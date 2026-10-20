// api/client-error.js
// POST /api/client-error — recibe errores JS del navegador (window.onerror / promesas
// rechazadas en app.html) y los reenvía a Sentry. Sin esto, un error en el móvil de un
// usuario solo se veía en su pantalla (banner rojo) y nunca nos enterábamos.

const { rateLimit } = require('./_ratelimit');
const { withSentry, captureClientError } = require('./_sentry');

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const allowed = await rateLimit(req, res, 'client-error', 20, '1 h', 'Too many reports');
  if (!allowed) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const message = clip(body?.message, 500);
  if (!message) return res.status(400).json({ error: 'message required' });

  captureClientError(message, {
    kind: clip(body.kind, 30),
    source: clip(body.source, 300),
    line: Number(body.line) || undefined,
    col: Number(body.col) || undefined,
    stack: clip(body.stack, 4000),
    page: clip(body.page, 300),
    screen: clip(body.screen, 50),
    userAgent: clip(req.headers['user-agent'], 300),
    version: clip(body.version, 40),
  });

  return res.status(204).end();
});
