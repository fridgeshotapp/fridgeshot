// api/analyze.js
// Recibe un array de imágenes en base64, devuelve ingredientes + bounding boxes por GPT-4o Vision

const { rateLimit } = require('./_ratelimit');
const { withSentry } = require('./_sentry');
const { createClient } = require('@supabase/supabase-js');

async function isProUser(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return false;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return false;
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: sub } = await admin
      .from('user_subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .single();
    return sub?.status === 'active' || sub?.status === 'trialing';
  } catch {
    return false;
  }
}

function buildPrompt(n) {
  return `Recibes ${n} foto${n > 1 ? 's' : ''} de nevera, despensa o ingredientes.
Analiza ${n > 1 ? 'TODAS las imágenes juntas como si fuera un único inventario' : 'la imagen'}.

Reglas:
1. Lista TODOS los ingredientes, alimentos y bebidas visibles en cualquiera de las fotos.
2. Si el mismo ingrediente aparece en varias fotos, inclúyelo UNA SOLA VEZ en "all_ingredients".
3. Para cada foto, indica qué items detectaste y su posición aproximada como bounding box.
4. Si en algún envase o producto ves claramente la marca o la cadena de supermercado (ej: Hacendado→Mercadona, marca Carrefour, Lidl/Freshona/Milbona, Dia, Auchan→Alcampo, marca El Corte Inglés, marcas como Danone, Nestlé, Bimbo, La Lechera, Presidente, etc.), inclúyelo en "detected_brands". Solo incluye marcas que puedas identificar con seguridad por el envase.

Las coordenadas del bounding box van de 0 a 999 ([0,0] = esquina superior-izquierda, [999,999] = inferior-derecha de cada foto).

Responde SOLO con este JSON, sin texto adicional:
{
  "all_ingredients": ["ingrediente1", "ingrediente2"],
  "detected_brands": [
    { "ingredient": "leche", "brand": "Hacendado", "store": "Mercadona" }
  ],
  "photos_analysis": [
    {
      "photo_index": 0,
      "items": [
        { "name": "huevo", "bbox": [100, 50, 300, 200] }
      ]
    }
  ]
}

Si no puedes determinar la posición exacta de un ingrediente, omite el campo "bbox" para ese item pero inclúyelo igualmente en "all_ingredients".
Si no detectas ninguna marca con certeza, devuelve "detected_brands" como array vacío [].`;
}

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Pro users skip the rate limit — that's their core paid benefit
  const isPro = await isProUser(req);

  if (!isPro) {
    const allowed = await rateLimit(
      req, res,
      'analyze', 10, '1 d',
      'Has alcanzado el límite de análisis por hoy. Vuelve mañana o hazte Pro para análisis ilimitados.'
    );
    if (!allowed) return;
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Cuerpo de la petición inválido' });
  }

  const { imagesBase64 } = req.body;

  if (!imagesBase64 || !Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    return res.status(400).json({ error: 'Se necesita al menos una imagen en imagesBase64[]' });
  }
  if (imagesBase64.length > 5) {
    return res.status(400).json({ error: 'Máximo 5 imágenes por petición' });
  }

  // Validate each image: must be non-empty base64, reasonable size (max ~8MB decoded)
  for (const b64 of imagesBase64) {
    if (typeof b64 !== 'string' || b64.length < 100) {
      return res.status(400).json({ error: 'Imagen inválida o demasiado pequeña' });
    }
    if (b64.length > 11_000_000) { // ~8MB decoded
      return res.status(400).json({ error: 'Una imagen supera el tamaño máximo permitido' });
    }
    if (!BASE64_RE.test(b64.replace(/\s/g, ''))) {
      return res.status(400).json({ error: 'Formato de imagen inválido' });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Servicio no configurado correctamente' });
  }

  const imageContent = imagesBase64.map(b64 => ({
    type: 'image_url',
    image_url: {
      url: `data:image/jpeg;base64,${b64}`,
      detail: 'high'
    }
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              ...imageContent,
              { type: 'text', text: buildPrompt(imagesBase64.length) }
            ]
          }
        ],
        max_tokens: 2500,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const status = response.status;
      if (status === 429) return res.status(429).json({ error: 'Demasiadas solicitudes, espera un momento e inténtalo de nuevo' });
      if (status === 401) return res.status(500).json({ error: 'Servicio no configurado correctamente' });
      return res.status(500).json({ error: 'Error al analizar las imágenes, inténtalo de nuevo' });
    }

    const data = await response.json();
    let content;
    try {
      content = JSON.parse(data.choices[0].message.content);
    } catch {
      return res.status(500).json({ error: 'Respuesta inesperada del servicio de IA' });
    }

    return res.status(200).json({
      all_ingredients: content.all_ingredients || [],
      detected_brands: content.detected_brands || [],
      photos_analysis: content.photos_analysis || []
    });

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'El análisis tardó demasiado. Inténtalo con menos fotos o una conexión más rápida.' });
    }
    return res.status(500).json({ error: 'Error de conexión con el servicio de IA' });
  }
});
