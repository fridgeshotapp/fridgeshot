// api/_sentry.js
// Wrapper de Sentry para funciones serverless.
// Para activar: añade SENTRY_DSN como variable de entorno en Vercel.
// Obtén el DSN en sentry.io → tu proyecto → Settings → Client Keys.

let _Sentry = null;

function getSentry() {
  if (_Sentry) return _Sentry;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn, environment: process.env.VERCEL_ENV || 'production', tracesSampleRate: 0.1 });
    _Sentry = Sentry;
    return Sentry;
  } catch {
    return null;
  }
}

/**
 * Envuelve un handler de Vercel con captura de errores de Sentry.
 * Si SENTRY_DSN no está configurado, el handler funciona igual sin Sentry.
 */
function withSentry(handler) {
  return async function(req, res) {
    const Sentry = getSentry();
    try {
      await handler(req, res);
    } catch (err) {
      if (Sentry) Sentry.captureException(err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error interno del servidor' });
      }
    }
  };
}

module.exports = { withSentry, getSentry };
