// api/_openai.js
// Cliente compartido para la API de OpenAI: timeout por intento, reintentos con backoff
// ante errores transitorios (429 / 5xx / red) y modelo de respaldo si el principal
// no existe o fue retirado (404 / model_not_found).
//
// Todas las funciones lanzan OpenAIError con `status` (HTTP a devolver al cliente)
// y `userMessage` (texto en español para mostrar al usuario).

const { captureError } = require('./_sentry');

class OpenAIError extends Error {
  constructor(message, { status = 502, userMessage, upstreamStatus, code } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.userMessage = userMessage || 'El servicio de IA no está disponible ahora mismo. Inténtalo de nuevo.';
    this.upstreamStatus = upstreamStatus;
    this.code = code;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isModelMissing(status, body) {
  const code = body?.error?.code || '';
  return status === 404 || code === 'model_not_found' || /model.*(does not exist|not found|deprecated)/i.test(body?.error?.message || '');
}

/**
 * POST a la API de OpenAI con reintentos.
 * @param {string} path            p.ej. '/v1/chat/completions'
 * @param {object} body            cuerpo de la petición (sin `model`)
 * @param {object} opts
 * @param {string[]} opts.models   modelos a probar en orden (fallback si el primero no existe)
 * @param {number} opts.deadlineMs presupuesto total de tiempo (debe ser < maxDuration de Vercel)
 * @param {number} opts.attemptTimeoutMs timeout por intento
 * @param {number} opts.maxAttempts intentos máximos por modelo
 * @param {string} opts.endpoint   nombre para logs/Sentry
 */
async function openaiPost(path, body, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAIError('OPENAI_API_KEY missing', { status: 500, userMessage: 'Servicio no configurado correctamente' });
  }

  const {
    models,
    deadlineMs = 50_000,
    attemptTimeoutMs = 40_000,
    maxAttempts = 3,
    endpoint = path,
  } = opts;

  const started = Date.now();
  const remaining = () => deadlineMs - (Date.now() - started);
  let lastErr;

  for (const model of models) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const budget = Math.min(attemptTimeoutMs, remaining());
      if (budget < 3_000) break; // no merece la pena empezar un intento sin tiempo

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      let response;
      try {
        response = await fetch(`https://api.openai.com${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ ...body, model }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const timedOut = err.name === 'AbortError';
        lastErr = new OpenAIError(`${endpoint}: ${timedOut ? 'timeout' : 'network'} (${model}, attempt ${attempt}): ${err.message}`, {
          status: 504,
          userMessage: timedOut
            ? 'La IA está tardando más de lo normal. Inténtalo de nuevo en unos segundos.'
            : 'Error de conexión con el servicio de IA. Inténtalo de nuevo.',
        });
        // Tras un timeout el bucle solo reintenta si aún queda presupuesto (check de `budget` arriba)
        await sleep(backoff(attempt));
        continue;
      }
      clearTimeout(timer);

      if (response.ok) {
        try {
          return await response.json();
        } catch (err) {
          lastErr = new OpenAIError(`${endpoint}: invalid JSON from OpenAI`, { status: 502 });
          continue;
        }
      }

      const errBody = await response.json().catch(() => ({}));
      const status = response.status;
      const msg = errBody?.error?.message || '';

      if (status === 401 || status === 403) {
        const e = new OpenAIError(`${endpoint}: auth error ${status}: ${msg}`, {
          status: 500, upstreamStatus: status, userMessage: 'Servicio no configurado correctamente',
        });
        captureError(e, { endpoint, model, status });
        throw e;
      }

      if (isModelMissing(status, errBody)) {
        lastErr = new OpenAIError(`${endpoint}: model unavailable ${model}: ${msg}`, { status: 502, upstreamStatus: status });
        captureError(lastErr, { endpoint, model, status });
        break; // pasar al siguiente modelo
      }

      if (status === 429 && errBody?.error?.code === 'insufficient_quota') {
        const e = new OpenAIError(`${endpoint}: insufficient_quota`, {
          status: 503, upstreamStatus: status,
          userMessage: 'El servicio de IA no está disponible temporalmente. Inténtalo más tarde.',
        });
        captureError(e, { endpoint, model });
        throw e;
      }

      if (status === 400) {
        const e = new OpenAIError(`${endpoint}: bad request: ${msg}`, {
          status: 400, upstreamStatus: status, code: errBody?.error?.code,
          userMessage: errBody?.error?.code === 'content_policy_violation'
            ? 'La IA no ha podido procesar esta petición. Prueba con otra.'
            : 'La IA no ha podido procesar esta petición. Inténtalo de nuevo.',
        });
        captureError(e, { endpoint, model });
        throw e;
      }

      lastErr = new OpenAIError(`${endpoint}: upstream ${status} (${model}, attempt ${attempt}): ${msg}`, {
        status: status === 429 ? 429 : 502, upstreamStatus: status,
        userMessage: status === 429
          ? 'La IA está saturada en este momento. Espera unos segundos e inténtalo de nuevo.'
          : undefined,
      });
      if (!isRetryableStatus(status)) break;

      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : backoff(attempt));
    }
  }

  const finalErr = lastErr || new OpenAIError(`${endpoint}: no time budget left`, { status: 504,
    userMessage: 'La IA está tardando más de lo normal. Inténtalo de nuevo en unos segundos.' });
  captureError(finalErr, { endpoint });
  throw finalErr;
}

function backoff(attempt) {
  return Math.min(4_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
}

/**
 * Chat completion que devuelve JSON parseado (response_format json_object).
 * Si el modelo devuelve JSON inválido o truncado, reintenta una vez.
 */
async function chatJSON(messages, opts = {}) {
  const { max_tokens, temperature, deadlineMs = 50_000, ...rest } = opts;
  const started = Date.now();
  for (let i = 0; i < 2; i++) {
    // El reintento por JSON inválido comparte el mismo presupuesto total (maxDuration de Vercel)
    const left = deadlineMs - (Date.now() - started);
    if (i > 0 && left < 10_000) break;
    const data = await openaiPost('/v1/chat/completions', {
      messages,
      max_tokens,
      ...(temperature !== undefined ? { temperature } : {}),
      response_format: { type: 'json_object' },
    }, { ...rest, deadlineMs: left });
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (content) {
      try { return JSON.parse(content); } catch { /* reintentar */ }
    }
    if (choice?.message?.refusal) {
      throw new OpenAIError('refusal', { status: 422, userMessage: 'La IA no ha podido procesar esta petición. Prueba con otra.' });
    }
  }
  const e = new OpenAIError(`${opts.endpoint}: invalid JSON content`, { status: 502,
    userMessage: 'Respuesta inesperada del servicio de IA. Inténtalo de nuevo.' });
  captureError(e, { endpoint: opts.endpoint });
  throw e;
}

/** Envía un OpenAIError (o cualquier error) como respuesta JSON. */
function sendError(res, err) {
  if (res.headersSent) return;
  if (err instanceof OpenAIError) {
    return res.status(err.status).json({ error: err.userMessage });
  }
  captureError(err);
  return res.status(500).json({ error: 'Error interno del servidor. Inténtalo de nuevo.' });
}

// Modelos configurables por env var para poder cambiar sin redeploy de código
// si OpenAI retira alguno. El segundo de cada lista es el fallback.
function modelList(envVar, defaults) {
  const fromEnv = (process.env[envVar] || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...fromEnv, ...defaults])];
}

const MODELS = {
  vision: () => modelList('OPENAI_MODEL_VISION', ['gpt-4o', 'gpt-4.1']),
  recipes: () => modelList('OPENAI_MODEL_RECIPES', ['gpt-4o', 'gpt-4.1']),
  chat: () => modelList('OPENAI_MODEL_CHAT', ['gpt-4o-mini', 'gpt-4.1-mini']),
  image: () => modelList('OPENAI_MODEL_IMAGE', ['gpt-image-1-mini', 'gpt-image-1']),
};

module.exports = { openaiPost, chatJSON, sendError, OpenAIError, MODELS };
