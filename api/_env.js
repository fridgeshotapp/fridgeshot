// api/_env.js
// Normaliza las variables de entorno al cargar cualquier función.
// Al pegar valores en el dashboard de Vercel es fácil colar un salto de línea o un espacio
// final (ya pasó con UPSTASH_REDIS_REST_URL y rompió el rate limit). Aquí se limpian.
// Se carga desde _sentry.js, que importan todos los endpoints.

const REQUIRED = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_DSN',
];

const OPTIONAL = [
  'SPOONACULAR_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'OPENAI_MODEL_VISION',
  'OPENAI_MODEL_RECIPES',
  'OPENAI_MODEL_CHAT',
  'OPENAI_MODEL_IMAGE',
];

for (const key of [...REQUIRED, ...OPTIONAL]) {
  const v = process.env[key];
  if (typeof v === 'string') {
    // quita espacios, saltos de línea y comillas envolventes pegadas por error
    const clean = v.trim().replace(/^["']|["']$/g, '').trim();
    if (clean) process.env[key] = clean;
    else delete process.env[key];
  }
}

function missingEnv() {
  return REQUIRED.filter(k => !process.env[k]);
}

module.exports = { REQUIRED, OPTIONAL, missingEnv };
