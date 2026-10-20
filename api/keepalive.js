// api/keepalive.js
// Cron diario (vercel.json): mantiene vivos los servicios del plan gratuito.
// - Supabase pausa los proyectos free tras ~7 días sin actividad (login de Google y sync caen).
// - Upstash archiva las bases de datos free inactivas (el rate limit deja de funcionar).
// Si alguno falla se reporta a Sentry para enterarnos antes que los usuarios.

const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');
const { withSentry, captureError } = require('./_sentry');

async function pingSupabase() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from('waitlist').select('email', { head: true, count: 'exact' });
  if (error) throw new Error(`Supabase keepalive failed: ${error.message}`);
}

async function pingRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL) return 'not configured';
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  await redis.set('fridgeshot:keepalive', new Date().toISOString(), { ex: 60 * 60 * 24 * 30 });
  return 'ok';
}

module.exports = withSentry(async (req, res) => {
  const result = { ts: new Date().toISOString() };
  for (const [name, fn] of [['supabase', pingSupabase], ['redis', pingRedis]]) {
    try {
      result[name] = (await fn()) || 'ok';
    } catch (err) {
      result[name] = `error: ${err.message}`;
      captureError(err, { endpoint: 'keepalive', service: name });
    }
  }
  const ok = !String(result.supabase).startsWith('error') && !String(result.redis).startsWith('error');
  res.status(ok ? 200 : 500).json({ ok, ...result });
});
