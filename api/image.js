// api/image.js
// Genera una imagen del plato con DALL-E 3

const { rateLimit } = require('./_ratelimit');
const { withSentry } = require('./_sentry');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const limited = await rateLimit(req, 'image', 5, 86400); // 5/día por IP
  if (limited) return res.status(429).json({ error: 'Límite diario de imágenes alcanzado. Vuelve mañana.' });

  const { recipeName, ingredients } = req.body || {};
  if (!recipeName) return res.status(400).json({ error: 'recipeName requerido' });

  const ingredientList = Array.isArray(ingredients) && ingredients.length
    ? ingredients.slice(0, 12).join(', ')
    : '';

  const prompt = `Professional food photography of "${recipeName}"${ingredientList ? `, made with ${ingredientList}` : ''}. Shot from above on a rustic wooden table, natural light, appetizing presentation, restaurant quality, photorealistic.`;

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'b64_json'
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return res.status(502).json({ error: err?.error?.message || 'Error generando imagen' });
  }

  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) return res.status(502).json({ error: 'Respuesta inesperada de OpenAI' });

  res.json({ b64 });
}

module.exports = withSentry(handler);
