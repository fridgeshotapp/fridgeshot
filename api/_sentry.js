// api/_sentry.js
// Wrapper de Sentry para funciones serverless.
// Para activar: añade SENTRY_DSN como variable de entorno en Vercel.
// Obtén el DSN en sentry.io → tu proyecto → Settings → Client Keys.

require('./_env'); // limpia las env vars antes de que nadie las lea

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

// Eventos capturados que aún no se han enviado. En serverless, Vercel congela la función
// en cuanto se envía la respuesta: sin flush, la mayoría de eventos de Sentry se pierden.
let pendingEvents = 0;

/**
 * Envuelve un handler de Vercel con captura de errores de Sentry.
 * Si SENTRY_DSN no está configurado, el handler funciona igual sin Sentry.
 * Si durante la petición se capturó algún error, retrasa el cierre de la respuesta
 * hasta que Sentry haya enviado los eventos (máx. 2s).
 */
function withSentry(handler) {
  return async function(req, res) {
    const Sentry = getSentry();
    if (Sentry && typeof res.end === 'function') {
      const origEnd = res.end.bind(res);
      res.end = function(...args) {
        if (!pendingEvents) return origEnd(...args);
        pendingEvents = 0;
        Sentry.flush(2000).catch(() => {}).finally(() => origEnd(...args));
        return res;
      };
    }
    try {
      await handler(req, res);
    } catch (err) {
      if (Sentry) { Sentry.captureException(err); pendingEvents++; }
      if (!res.headersSent && !res.writableEnded) {
        res.status(500).json({ error: 'Error interno del servidor' });
      }
    }
  };
}

// Captura manual: para errores atrapados dentro de un handler que aún así devuelven respuesta al cliente.
function captureError(err, context) {
  const Sentry = getSentry();
  if (!Sentry) return;
  try {
    if (context) Sentry.withScope(scope => { scope.setContext('extra', context); Sentry.captureException(err); });
    else Sentry.captureException(err);
    pendingEvents++;
  } catch { /* nunca dejar que Sentry rompa el flujo */ }
}

// Errores del navegador (vía /api/client-error), agrupados por mensaje en Sentry.
function captureClientError(message, context) {
  const Sentry = getSentry();
  if (!Sentry) return;
  try {
    Sentry.withScope(scope => {
      scope.setTag('source', 'frontend');
      scope.setFingerprint(['frontend', String(message).slice(0, 120)]);
      scope.setContext('client', context);
      Sentry.captureMessage(`[frontend] ${message}`, 'error');
    });
    pendingEvents++;
  } catch {}
}

module.exports = { withSentry, getSentry, captureError, captureClientError };
