// api/recipes.js
// Recibe ingredientes + preferencias, devuelve 3 recetas generadas por GPT-4o

const { rateLimit } = require('./_ratelimit');

async function getSpoonacularRecipes(ingredients, appliance) {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      includeIngredients: ingredients.slice(0, 6).join(','),
      number: 3,
      addRecipeInformation: true,
      instructionsRequired: true,
      sort: 'min-missing-ingredients',
      fillIngredients: true,
    });
    if (appliance === 'airfryer') params.set('equipment', 'air fryer');

    const res = await fetch(
      `https://api.spoonacular.com/recipes/complexSearch?${params}`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return [];
  }
}

function buildApplianceBlock(appliance) {
  if (!appliance || appliance === 'ninguno') return '';

  if (appliance === 'airfryer') {
    return `
ELECTRODOMÉSTICO: Air Fryer (freidora de aire)
Las 3 recetas DEBEN estar diseñadas exclusivamente para cocinarse en una freidora de aire.
Reglas de formato para los pasos:
- Indica siempre la temperatura en °C (ej: "Precalentamos la freidora a 200°C durante 3 minutos.")
- Especifica la posición de los alimentos en la cesta (ej: "Distribuimos en la cesta en una sola capa sin amontonar.")
- Indica el tiempo exacto y si hay que dar la vuelta (ej: "Cocinamos 12 minutos, dando la vuelta a los 6 minutos.")
- Si se necesita aceite, usa "Pintamos/rociamos con una cucharada de aceite" en vez de freír en aceite
- El time_minutes debe reflejar el tiempo real en la freidora (generalmente 15-25 min)
- Inspírate en recetas auténticas de Air Fryer populares en internet`;
  }

  if (appliance === 'thermomix') {
    return `
ELECTRODOMÉSTICO: Thermomix
Las 3 recetas DEBEN estar diseñadas exclusivamente para cocinarse en Thermomix.
Reglas de formato para los pasos (es CRÍTICO seguir el formato auténtico de Cookidoo):
- Usa el formato exacto: "Ponemos X en el vaso. Programamos N segundos/minutos, velocidad V."
- Velocidades de referencia: vel. 4-5 para picar, vel. 6-7 para triturar, vel. 10 para textura muy fina, vel. 1-2 para sofreír, vel. cuchara para mezclar suave
- Temperatura: Varoma (~115°C) para cocción al vapor, 100°C para hervir, 80-90°C para cremas
- Menciona la mariposa cuando sea necesario (para montar claras, nata, etc.)
- Menciona el cestillo cuando se use para escurrir o cocer al vapor
- El Varoma se coloca encima del vaso para cocinar al vapor
- Ejemplo de paso correcto: "Paso 1: Ponemos la cebolla troceada y el ajo en el vaso. Programamos 5 segundos, velocidad 5. Bajamos los restos de las paredes con la espátula."
- Ejemplo: "Paso 2: Añadimos el aceite. Programamos 3 minutos, temperatura Varoma, velocidad 1."
- El time_minutes debe ser realista para Thermomix (generalmente 20-40 min)
- Inspírate en recetas de Cookidoo y blogs especializados en Thermomix`;
  }

  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit: 30 generaciones de recetas por IP al día
  const allowed = await rateLimit(
    req, res,
    'recipes', 30, '1 d',
    'Has alcanzado el límite de 30 generaciones de recetas por día. Vuelve mañana.'
  );
  if (!allowed) return;

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Cuerpo de la petición inválido' });
  }

  const { ingredients, mustInclude, dietPrefs, timeLimits, servingsOptions, mealTypes, appliance, count, excludeNames } = req.body;

  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'Se necesita al menos un ingrediente' });
  }

  // Basic input sanitization
  if (!Array.isArray(ingredients) || ingredients.length > 200) {
    return res.status(400).json({ error: 'Lista de ingredientes inválida' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Servicio no configurado correctamente' });
  }

  const dietText = dietPrefs && dietPrefs.length > 0
    ? `Preferencias dietéticas: ${dietPrefs.join(', ')}.`
    : 'Sin restricciones dietéticas.';

  const times = Array.isArray(timeLimits) && timeLimits.length > 0 ? timeLimits.sort((a,b)=>a-b) : [30];
  const maxTime = times[times.length-1];
  const minSensibleTime = Math.max(15, Math.round(maxTime * 0.6));
  const timeText = times.length === 1
    ? `Tiempo disponible para cocinar: ${times[0]} minutos. OBLIGATORIO: el time_minutes de CADA receta debe estar entre ${minSensibleTime} y ${times[0]} minutos. Queda PROHIBIDO sugerir platos de menos de ${minSensibleTime} min cuando el usuario tiene ${times[0]} min disponibles — eso sería desperdiciar su tiempo de cocina.`
    : `Tiempo para cocinar: flexible entre ${times[0]} y ${times[times.length-1]} minutos. Distribuye las 3 recetas por ese rango: una corta (~${times[0]} min, mínimo ${Math.max(10, times[0]-5)} min), otra intermedia y otra más elaborada (~${times[times.length-1]} min).`;

  const servings = Array.isArray(servingsOptions) && servingsOptions.length > 0 ? servingsOptions.sort((a,b)=>a-b) : [2];
  const servingsText = servings.length === 1
    ? `La receta debe estar calculada para ${servings[0]} persona${servings[0] > 1 ? 's' : ''}.`
    : `Las recetas deben estar calculadas para ${servings.join(' o ')} personas (varía entre las 3 recetas).`;

  const mealText = Array.isArray(mealTypes) && mealTypes.length > 0
    ? `Tipo de comida: ${mealTypes.join(' o ')}. Adapta las recetas a este momento del día.`
    : '';

  const mustIncludeText = Array.isArray(mustInclude) && mustInclude.length > 0
    ? `OBLIGATORIO: El usuario quiere que estas recetas incluyan SÍ O SÍ los siguientes ingredientes: ${mustInclude.join(', ')}. CADA una de las 3 recetas DEBE usar al menos uno de estos ingredientes como ingrediente relevante, no como simple condimento.`
    : '';

  const recipeCount = (typeof count === 'number' && count >= 1 && count <= 3) ? count : 3;
  const excludeText = Array.isArray(excludeNames) && excludeNames.length > 0
    ? `IMPORTANTE: Estas recetas ya han sido sugeridas, NO las repitas ni uses el mismo nombre o concepto: ${excludeNames.join(', ')}. Sugiere algo completamente diferente.`
    : '';

  const applianceText = buildApplianceBlock(appliance);

  // Fetch real recipes from Spoonacular when an appliance is selected
  let spoonacularContext = '';
  if (appliance && appliance !== 'ninguno') {
    const spoonRecipes = await getSpoonacularRecipes(ingredients, appliance);
    if (spoonRecipes.length > 0) {
      spoonacularContext = `Basándote en estas recetas reales de internet como inspiración (adapta y traduce al español):\n${
        spoonRecipes.map(r => {
          const ingList = (r.extendedIngredients || []).slice(0, 5).map(i => i.original).join(', ');
          return `- "${r.title}" (${r.readyInMinutes} min): ${ingList}`;
        }).join('\n')
      }\n\n`;
    }
  }

  const systemMsg = appliance === 'thermomix'
    ? 'Eres un experto en Thermomix con conocimiento de miles de recetas de Cookidoo y blogs especializados. Cuando generas recetas para Thermomix, usas el formato exacto de Cookidoo: velocidades precisas, temperaturas, tiempos de programación y menciones a accesorios como la mariposa, el cestillo o el Varoma.'
    : appliance === 'airfryer'
    ? 'Eres un experto en freidoras de aire (Air Fryer) con conocimiento de miles de recetas populares en internet. Cuando generas recetas para Air Fryer, incluyes siempre temperatura en °C, tiempo exacto de cocción, posición en la cesta y si hay que dar la vuelta.'
    : 'Eres un chef experto que sugiere recetas caseras prácticas y deliciosas basadas en los ingredientes disponibles.';

  const prompt = `${spoonacularContext}Soy un chef casero y tengo estos ingredientes en casa: ${ingredients.join(', ')}.

${excludeText}
${mustIncludeText}
${dietText}
${timeText}
${servingsText}
${mealText}
${applianceText}

Sugiere EXACTAMENTE ${recipeCount} receta${recipeCount === 1 ? '' : 's'} que pueda hacer AHORA con lo que tengo.

REGLA DE INGREDIENTES (CRÍTICA): Los ingredientes de cada receta DEBEN ser ingredientes que tengo en mi lista. Los únicos ingredientes que puedes asumir sin que estén en mi lista son condimentos básicos como: sal, pimienta negra, aceite de oliva o girasol, ajo (si no aparece en mi lista úsalo solo como condimento), pimentón, orégano, comino, laurel, vinagre, azúcar, harina (poca cantidad), agua. Cualquier otro ingrediente —especialmente carnes, pescados, verduras, lácteos, legumbres— DEBE estar en mi lista. Si una receta que se te ocurre necesita un ingrediente importante que no tengo, ELIGE OTRA RECETA.

VARIEDAD: Las recetas deben ser VARIADAS entre sí (y distintas de cualquier receta ya sugerida):
- Cada receta debe girar en torno a un ingrediente principal DIFERENTE (no repitas el mismo protagonista)
- Que sean platos distintos en concepto: no varias versiones del mismo tipo de plato
- Si hay ingredientes variados en la lista, aprovéchalos para dar opciones diversas

Responde SOLO con este JSON:
{
  "recipes": [
    {
      "name": "Nombre de la receta",
      "time_minutes": 20,
      "difficulty": "fácil",
      "key_ingredients": ["ingrediente 1", "ingrediente 2", "ingrediente 3"],
      "all_ingredients": ["2 huevos", "1 tomate", "sal al gusto"],
      "steps": ["Paso 1: descripción clara.", "Paso 2: descripción clara."]
    }
  ]
}

difficulty solo puede ser: "fácil", "medio" o "difícil".`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);

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
          { role: 'system', content: systemMsg },
          { role: 'user', content: prompt }
        ],
        max_tokens: recipeCount === 1 ? 800 : (appliance === 'thermomix' ? 2500 : 2000),
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      if (status === 429) return res.status(429).json({ error: 'Demasiadas solicitudes, espera un momento e inténtalo de nuevo' });
      if (status === 401) return res.status(500).json({ error: 'Servicio no configurado correctamente' });
      return res.status(500).json({ error: 'No se pudieron generar las recetas, inténtalo de nuevo' });
    }

    const data = await response.json();
    let content;
    try {
      content = JSON.parse(data.choices[0].message.content);
    } catch {
      return res.status(500).json({ error: 'Respuesta inesperada del servicio de IA' });
    }

    return res.status(200).json({ recipes: content.recipes || [] });

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'La generación tardó demasiado. Inténtalo de nuevo.' });
    }
    return res.status(500).json({ error: 'Error de conexión con el servicio de IA' });
  }
};
