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

/**
 * Comprueba el rate limit para una petición.
 * Devuelve true si se permite, false si se ha superado el límite
 * (y en ese caso ya envía la respuesta 429 automáticamente).
 *
 * Si Redis falla o tarda más de REDIS_TIMEOUT_MS, se deja pasar la petición
 * (fail-open) y se reporta a Sentry: un fallo de Upstash no debe tumbar la app.
 */
const REDIS_TIMEOUT_MS = 2_000;
let reportedRedisError = false;

async function rateLimit(req, res, key, requests, window, errorMsg) {
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    // Sin configurar: dejamos pasar (útil en desarrollo sin Redis)
    return true;
  }

  const forwarded = req.headers['x-forwarded-for'] || '';
  const ip = req.headers['x-real-ip'] || forwarded.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';

  try {
    const limiter = getLimiter(key, requests, window);
    const { success, remaining, reset } = await Promise.race([
      limiter.limit(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ratelimit timeout')), REDIS_TIMEOUT_MS)),
    ]);

    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      res.setHeader('X-RateLimit-Limit', String(requests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(reset));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: errorMsg, retry_after: retryAfter });
      return false;
    }

    res.setHeader('X-RateLimit-Limit', String(requests));
    res.setHeader('X-RateLimit-Remaining', String(remaining ?? 0));
    res.setHeader('X-RateLimit-Reset', String(reset ?? 0));
    return true;
  } catch (err) {
    console.error('[ratelimit] Redis error — failing open:', err?.message);
    // Un aviso por instancia: si Redis está caído, no agotar la cuota de Sentry con cada petición
    if (!reportedRedisError) {
      reportedRedisError = true;
      captureError(err, { endpoint: key, where: 'ratelimit' });
    }
    return true;
  }
}

module.exports = { rateLimit };
