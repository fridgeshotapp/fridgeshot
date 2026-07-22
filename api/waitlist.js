// api/waitlist.js
// Guarda emails de interesados en la tabla `waitlist` de Supabase.
// La tabla debe existir en Supabase:
//   CREATE TABLE waitlist (
//     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//     email text UNIQUE NOT NULL,
//     created_at timestamptz DEFAULT now()
//   );

const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('./_ratelimit');
const { withSentry, captureError } = require('./_sentry');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const allowed = await rateLimit(req, res, 'waitlist', 5, '1 h', 'Demasiados intentos. Espera un momento.');
  if (!allowed) return;

  const { email } = req.body || {};
  const trimmed = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!trimmed || !EMAIL_RE.test(trimmed) || trimmed.length > 254) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase
    .from('waitlist')
    .upsert({ email: trimmed }, { onConflict: 'email' });

  if (error) {
    console.error('Waitlist insert error:', error.message);
    captureError(new Error(`Waitlist insert failed: ${error.message}`), { endpoint: 'waitlist' });
    return res.status(500).json({ error: 'No se pudo guardar el email. Inténtalo de nuevo.' });
  }

  return res.status(200).json({ ok: true });
});
