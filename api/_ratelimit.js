// api/_ratelimit.js
// Helper compartido de rate limiting usando Upstash Redis
// Límites por IP y por día para proteger los costes de OpenAI

const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');
const { captureError } = require('./_sentry');

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

const limiters = {};
function getLimiter(key, requests, window) {
  if (!limiters[key]) {
    limiters[key] = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(requests, window),
      prefix: `fridgeshot:${key}`,
    });
  }
  return limiters[key];
}

// ── Respaldo en memoria ────────────────────────────────────────────────
// Si Redis no está disponible, aplicamos el mismo límite por IP en la memoria de la
// instancia. No es global (cada instancia de Vercel cuenta por separado y se reinicia
// en cold start), pero evita que un fallo de Upstash deje los costes de OpenAI sin techo.
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function windowToMs(window) {
  const m = String(window).trim().match(/^(\d+)\s*(ms|s|m|h|d)$/);
  return m ? Number(m[1]) * UNIT_MS[m[2]] : 86_400_000;
}

const memoryHits = new Map(); // `${key}:${ip}` → timestamps
const MEMORY_MAX_KEYS = 5_000;
function memoryLimit(key, ip, requests, window) {
  const now = Date.now();
  const windowMs = windowToMs(window);
  const id = `${key}:${ip}`;
  const hits = (memoryHits.get(id) || []).filter(t => t > now - windowMs);
  const success = hits.length < requests;
  if (success) hits.push(now);
  memoryHits.set(id, hits);
  if (memoryHits.size > MEMORY_MAX_KEYS) memoryHits.delete(memoryHits.keys().next().value);
  return { success, remaining: Math.max(0, requests - hits.length), reset: (hits[0] || now) + windowMs };
}

/**
 * Comprueba el rate limit para una petición.
 * Devuelve true si se permite, false si se ha superado el límite
 * (y en ese caso ya envía la respuesta 429 automáticamente).
 *
 * Si Redis falla, tarda más de REDIS_TIMEOUT_MS o no está configurado en Vercel,
 * se usa el limitador en memoria y se reporta a Sentry: un fallo de Upstash no debe
 * tumbar la app, pero tampoco dejarla sin límite.
 */
const REDIS_TIMEOUT_MS = 2_000;
let reportedRedisError = false;

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  return req.headers['x-real-ip'] || forwarded.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
}

async function rateLimit(req, res, key, requests, window, errorMsg) {
  const ip = getIp(req);
  let result;

  if (!process.env.UPSTASH_REDIS_REST_URL) {
    // Sin Redis en local: dejamos pasar. En Vercel: respaldo en memoria.
    if (!process.env.VERCEL) return true;
    result = memoryLimit(key, ip, requests, window);
  } else {
    try {
      const limiter = getLimiter(key, requests, window);
      result = await Promise.race([
        limiter.limit(ip),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ratelimit timeout')), REDIS_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error('[ratelimit] Redis error — using in-memory fallback:', err?.message);
      // Un aviso por instancia: si Redis está caído, no agotar la cuota de Sentry con cada petición
      if (!reportedRedisError) {
        reportedRedisError = true;
        captureError(err, { endpoint: key, where: 'ratelimit' });
      }
      result = memoryLimit(key, ip, requests, window);
    }
  }

  const { success, remaining, reset } = result;
  res.setHeader('X-RateLimit-Limit', String(requests));
  res.setHeader('X-RateLimit-Remaining', String(success ? (remaining ?? 0) : 0));
  res.setHeader('X-RateLimit-Reset', String(reset ?? 0));

  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: errorMsg, retry_after: retryAfter });
    return false;
  }
  return true;
}

module.exports = { rateLimit, _memoryLimit: memoryLimit, _windowToMs: windowToMs };
