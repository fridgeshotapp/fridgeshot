// api/image.js
// Genera una imagen del plato con los modelos de imagen de OpenAI (gpt-image-1-mini por defecto).
// DALL-E 3 queda solo como último recurso: OpenAI lo ha retirado de la API.

const { rateLimit } = require('./_ratelimit');
const { withSentry } = require('./_sentry');
const { openaiPost, sendError, OpenAIError, MODELS } = require('./_openai');

function bodyForModel(model, prompt) {
  if (model.startsWith('dall-e')) {
    return { prompt, n: 1, size: '1024x1024', quality: 'standard', response_format: 'b64_json' };
  }
  // gpt-image-*: siempre devuelve b64; JPEG comprimido para no reventar el localStorage del cliente
  return { prompt, n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg', output_compression: 75 };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const allowed = await rateLimit(
    req, res,
    'image', 5, '1 d',
    'Has alcanzado el límite de 5 fotos generadas por día. Vuelve mañana.'
  );
  if (!allowed) return;

  const { recipeName, ingredients } = req.body || {};
  if (!recipeName || typeof recipeName !== 'string') {
    return res.status(400).json({ error: 'Falta el nombre de la receta' });
  }

  const ingredientList = Array.isArray(ingredients) && ingredients.length
    ? ingredients.filter(i => typeof i === 'string').slice(0, 12).map(i => i.slice(0, 60)).join(', ')
    : '';

  const prompt = `Professional food photography of "${recipeName.slice(0, 120)}"${ingredientList ? `, made with ${ingredientList}` : ''}. Shot from above on a rustic wooden table, natural light, appetizing presentation, restaurant quality, photorealistic. No text, no people.`;

  const started = Date.now();
  let lastErr;
  // Cada modelo usa parámetros distintos, así que probamos uno a uno.
  for (const model of [...MODELS.image(), 'dall-e-3']) {
    const deadlineMs = 55_000 - (Date.now() - started);
    if (deadlineMs < 10_000) break;
    try {
      const data = await openaiPost('/v1/images/generations', bodyForModel(model, prompt), {
        endpoint: 'image',
        models: [model],
        deadlineMs,
        attemptTimeoutMs: deadlineMs,
        maxAttempts: 2,
      });
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) throw new OpenAIError('image: empty response', { status: 502 });
      return res.status(200).json({ b64, mime: model.startsWith('dall-e') ? 'image/png' : 'image/jpeg' });
    } catch (err) {
      lastErr = err;
      // Modelo no disponible para esta cuenta (404 / 403 por verificación de organización): probar el siguiente
      const upstream = err instanceof OpenAIError ? err.upstreamStatus : null;
      if (upstream === 404 || upstream === 403 || upstream === 400) continue;
      break;
    }
  }

  if (lastErr instanceof OpenAIError && lastErr.status !== 400) return sendError(res, lastErr);
  return sendError(res, new OpenAIError('image: all models failed', {
    status: 502, userMessage: 'No se pudo generar la foto ahora mismo. Inténtalo de nuevo más tarde.',
  }));
}

module.exports = withSentry(handler);
