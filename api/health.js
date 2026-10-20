// api/health.js
// GET /api/health — estado real de la app (también responde en /api/keepalive vía rewrite).
//
// - Lo llama el cron diario de Vercel (vercel.json) y un monitor externo (UptimeRobot) cada 5 min.
// - Cada llamada hace actividad real en Supabase y Upstash: así los planes gratuitos no se
//   pausan/archivan por inactividad (en oct-2026 ambos murieron y la app quedó caída).
// - Comprueba que existen los modelos de OpenAI configurados (GET /v1/models/{id}, gratis):
//   detecta modelos retirados antes de que fallen las peticiones de los usuarios.
//
// Responde 200 si todo está bien y 503 si algo falla → el monitor externo te avisa.
// No hace llamadas de pago a OpenAI.

const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');
const { withSentry, captureError } = require('./_sentry');
const { missingEnv } = require('./_env');
const { MODELS } = require('./_openai');

const CHECK_TIMEOUT_MS = 6_000;

function withTimeout(promise, ms = CHECK_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

async function checkSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('not configured');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await supabase.from('waitlist').select('email', { head: true, count: 'exact' });
  if (error) throw new Error(error.message || 'query failed');
  return 'ok';
}

async function checkRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL) throw new Error('not configured (rate limit disabled)');
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  await redis.set('fridgeshot:keepalive', new Date().toISOString(), { ex: 60 * 60 * 24 * 30 });
  return 'ok';
}

async function modelExists(id) {
  const r = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  if (r.status === 401) throw new Error('invalid OPENAI_API_KEY');
  return r.ok;
}

async function checkOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error('not configured');
  const result = {};
  let degraded = false;
  await Promise.all(Object.entries(MODELS).map(async ([use, list]) => {
    const models = list();
    const primaryOk = await modelExists(models[0]);
    if (primaryOk) { result[use] = models[0]; return; }
    // Principal retirado: ¿hay fallback disponible?
    for (const m of models.slice(1)) {
      if (await modelExists(m)) { result[use] = `${m} (fallback: ${models[0]} unavailable)`; degraded = true; return; }
    }
    throw new Error(`no model available for ${use}: ${models.join(', ')}`);
  }));
  return degraded ? { degraded: true, ...result } : result;
}

module.exports = withSentry(async function handler(req, res) {
  const checks = {};
  let ok = true;

  const missing = missingEnv();
  checks.env = missing.length ? { missing } : 'ok';
  if (missing.length) ok = false;

  const services = { supabase: checkSupabase, redis: checkRedis, openai: checkOpenAI };
  await Promise.all(Object.entries(services).map(async ([name, fn]) => {
    try {
      checks[name] = await withTimeout(fn());
      if (checks[name]?.degraded) ok = false;
    } catch (err) {
      checks[name] = `error: ${err.message}`;
      ok = false;
    }
  }));

  // Solo el cron reporta a Sentry (el monitor externo llama cada 5 min y llenaría la cuota)
  const isCron = /vercel-cron/i.test(req.headers['user-agent'] || '');
  if (!ok && isCron) captureError(new Error('Health check failed'), { checks });

  res.setHeader('Cache-Control', 'no-store');
  res.status(ok ? 200 : 503).json({
    ok,
    ts: new Date().toISOString(),
    version: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7),
    checks,
  });
});
