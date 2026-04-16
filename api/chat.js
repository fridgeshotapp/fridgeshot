// api/chat.js
// Chatbot para preguntar dudas sobre una receta específica

const { rateLimit } = require('./_ratelimit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit: 50 mensajes de chat por IP al día
  const allowed = await rateLimit(
    req, res,
    'chat', 50, '1 d',
    'Has alcanzado el límite de 50 mensajes por día. Vuelve mañana.'
  );
  if (!allowed) return;

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Cuerpo de la petición inválido' });
  }

  const { recipe, messages, userMessage } = req.body;

  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    return res.status(400).json({ error: 'Se necesita un mensaje' });
  }
  if (userMessage.length > 500) {
    return res.status(400).json({ error: 'Mensaje demasiado largo' });
  }
  if (!recipe || typeof recipe !== 'object') {
    return res.status(400).json({ error: 'Se necesita la receta' });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Historial inválido' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Servicio no configurado correctamente' });
  }

  const recipeContext = [
    `Receta: ${recipe.name}`,
    `Tiempo: ${recipe.time_minutes} minutos`,
    `Dificultad: ${recipe.difficulty}`,
    `Ingredientes: ${(recipe.all_ingredients || []).join(', ')}`,
    `Pasos: ${(recipe.steps || []).join(' | ')}`
  ].join('\n');

  const systemMsg = `Eres un chef experto y amigable ayudando a cocinar una receta concreta. El usuario está cocinando esta receta y tiene dudas:

${recipeContext}

Responde de forma breve y práctica. Si pregunta por sustituciones, tiempos, técnicas o adaptaciones, da consejos concretos. Responde siempre en español.`;

  // Historial limitado a los últimos 8 mensajes para no gastar tokens
  const historyMessages = messages
    .slice(-8)
    .filter(m => m.role && m.content)
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content).slice(0, 500)
    }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemMsg },
          ...historyMessages,
          { role: 'user', content: userMessage.trim() }
        ],
        max_tokens: 400,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      if (status === 429) return res.status(429).json({ error: 'Demasiadas solicitudes, espera un momento' });
      if (status === 401) return res.status(500).json({ error: 'Servicio no configurado correctamente' });
      return res.status(500).json({ error: 'No pude responder, inténtalo de nuevo' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(500).json({ error: 'Respuesta inesperada del servicio' });
    }

    return res.status(200).json({ reply });

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'La respuesta tardó demasiado. Inténtalo de nuevo.' });
    }
    return res.status(500).json({ error: 'Error de conexión con el servicio' });
  }
};
