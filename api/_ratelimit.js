// api/_ratelimit.js
// Helper compartido de rate limiting usando Upstash Redis
// Límites por IP y por día para proteger los costes de OpenAI

const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

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
 */
async function rateLimit(req, res, key, requests, window, errorMsg) {
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    // Sin configurar: dejamos pasar (útil en desarrollo sin Redis)
    return true;
  }

  const forwarded = req.headers['x-forwarded-for'] || '';
  const ip = forwarded.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';

  try {
    const limiter = getLimiter(key, requests, window);
    const { success, remaining, reset } = await limiter.limit(ip);

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
  } catch {
    // Si Redis falla, dejamos pasar para no romper la app
    return true;
  }
}

module.exports = { rateLimit };
