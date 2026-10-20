// Utilidades compartidas por los tests: fetch simulado y `res` de Vercel simulado.
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Entorno controlado: sin Redis (rate limit desactivado fuera de Vercel), sin Sentry.
process.env.OPENAI_API_KEY = 'sk-test';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.SENTRY_DSN;
delete process.env.VERCEL;
for (const k of Object.keys(process.env)) if (k.startsWith('OPENAI_MODEL_')) delete process.env[k];

const J = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
});
const chatOk = content => J(200, { choices: [{ message: { content } }] });

// Cola de respuestas para fetch: cada llamada consume la siguiente (Error = fallo de red)
const mock = { queue: [], calls: [] };
global.fetch = async (url, opts = {}) => {
  let body = {};
  try { body = JSON.parse(opts.body || '{}'); } catch {}
  mock.calls.push({ url: String(url), model: body.model, body });
  if (!mock.queue.length) throw new Error('fetch mock: no queued response for ' + url);
  const next = mock.queue.shift();
  if (next instanceof Error) throw next;
  return typeof next === 'function' ? next(url, opts) : next;
};
function queue(...responses) { mock.queue = responses; mock.calls = []; }

function mockRes() {
  return {
    headersSent: false, writableEnded: false, statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; this.writableEnded = true; return this; },
    end() { this.headersSent = true; this.writableEnded = true; return this; },
  };
}

async function call(file, body, { method = 'POST', headers = {} } = {}) {
  const handler = require(path.join(ROOT, 'api', file));
  const res = mockRes();
  await handler({ method, headers, body }, res);
  return res;
}

// Imagen PNG mínima válida en base64 (cabecera PNG + relleno)
const PNG_B64 = 'iVBORw0KGgo' + 'A'.repeat(200);

module.exports = { ROOT, J, chatOk, mock, queue, call, mockRes, PNG_B64 };
