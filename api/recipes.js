// api/recipes.js
// Recibe ingredientes + preferencias, devuelve 3 recetas generadas por GPT-4o

const { rateLimit } = require('./_ratelimit');
const { withSentry } = require('./_sentry');
const { isProUser } = require('./_auth');
const { chatJSON, sendError, MODELS } = require('./_openai');
const { Redis } = require('@upstash/redis');

let _redis;
function getRedis() {
  if (!_redis && process.env.UPSTASH_REDIS_REST_URL) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

async function getCachedSpoonacular(key) {
  try {
    const r = getRedis();
    if (!r) return null;
    // Timeout corto: la caché es opcional, nunca debe bloquear la generación de recetas
    const val = await Promise.race([r.get(key), new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
    return val ? (typeof val === 'string' ? JSON.parse(val) : val) : null;
  } catch { return null; }
}

async function setCachedSpoonacular(key, data) {
  try {
    const r = getRedis();
    if (!r) return;
    await Promise.race([r.set(key, JSON.stringify(data), { ex: 86400 }), new Promise(resolve => setTimeout(resolve, 1500))]); // 24h TTL
  } catch { /* non-critical */ }
}

async function getSpoonacularRecipes(ingredients, appliance) {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) return [];

  const sortedIngredients = ingredients.slice(0, 6).sort();
  const cacheKey = `fridgeshot:spoon:${appliance}:${sortedIngredients.join(',')}`;

  const cached = await getCachedSpoonacular(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      includeIngredients: sortedIngredients.join(','),
      number: 3,
      addRecipeInformation: true,
      instructionsRequired: true,
      sort: 'min-missing-ingredients',
      fillIngredients: true,
    });
    if (appliance === 'airfryer') params.set('equipment', 'air fryer');

    const spoonController = new AbortController();
    const spoonTimeout = setTimeout(() => spoonController.abort(), 6000);
    const res = await fetch(
      `https://api.spoonacular.com/recipes/complexSearch?${params}`,
      { headers: { 'x-api-key': apiKey }, signal: spoonController.signal }
    );
    clearTimeout(spoonTimeout);
    if (!res.ok) return [];
    const data = await res.json();
    const results = data.results || [];
    await setCachedSpoonacular(cacheKey, results);
    return results;
  } catch {
    return [];
  }
}


// Normaliza arrays opcionales del body: evita que un tipo inesperado rompa el prompt con un 500
function strList(v, max = 20) {
  return Array.isArray(v)
    ? v.filter(x => typeof x === 'string').map(x => x.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80)).filter(Boolean).slice(0, max)
    : [];
}
function numList(v, min, max) {
  return Array.isArray(v)
    ? v.map(Number).filter(n => Number.isFinite(n) && n >= min && n <= max).slice(0, 10)
    : [];
}

// Utensilios de "Mi cocina". Los ids deben coincidir con KITCHEN_TOOLS en app.html (guardrail test).
const TOOLS = {
  placa: 'fuegos / placa (sartén, cazo, olla)',
  horno: 'horno',
  microondas: 'microondas',
  airfryer: 'Air Fryer (freidora de aire)',
  thermomix: 'Thermomix',
  olla: 'olla exprés',
  batidora: 'batidora / minipimer',
};
const toolIds = v => [...new Set(strList(v).filter(id => Object.prototype.hasOwnProperty.call(TOOLS, id)))];

const AIRFRYER_RULES = `Reglas de formato para los pasos de Air Fryer:
- Indica siempre la temperatura en °C (ej: "Precalentamos la freidora a 200°C durante 3 minutos.")
- Especifica la posición de los alimentos en la cesta (ej: "Distribuimos en la cesta en una sola capa sin amontonar.")
- Indica el tiempo exacto y si hay que dar la vuelta (ej: "Cocinamos 12 minutos, dando la vuelta a los 6 minutos.")
- Si se necesita aceite, usa "Pintamos/rociamos con una cucharada de aceite" en vez de freír en aceite
- El time_minutes debe reflejar el tiempo real en la freidora (generalmente 15-25 min)
- Inspírate en recetas auténticas de Air Fryer populares en internet`;

const THERMOMIX_RULES = `Reglas de formato para los pasos de Thermomix (es CRÍTICO seguir el formato auténtico de Cookidoo):
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

// tools: lo que el usuario tiene en su cocina (restricción). mustUse: lo que exige para esta receta.
// Sin tools configurados no se restringe nada (comportamiento anterior a "Mi cocina").
function buildToolsBlock(tools, mustUse, recipeCount) {
  const parts = [];
  if (tools.length > 0) {
    const missing = Object.keys(TOOLS).filter(id => !tools.includes(id));
    parts.push(`UTENSILIOS: En mi cocina tengo: ${tools.map(id => TOOLS[id]).join(', ')}.`
      + (missing.length ? ` NO tengo: ${missing.map(id => TOOLS[id]).join(', ')}. Ninguna receta puede usar algo que no tengo (por ejemplo, si no tengo horno, nada al horno).` : '')
      + ' Utensilios básicos como cuchillos, tablas, boles o fuentes se dan por supuestos.');
  }
  if (mustUse.length > 0) {
    const n = recipeCount === 1 ? 'La receta' : `CADA una de las ${recipeCount} recetas`;
    parts.push(`OBLIGATORIO: ${n} DEBE cocinarse usando ${mustUse.map(id => TOOLS[id]).join(' y ')} como método de cocción principal.`);
  } else if (tools.length > 0) {
    parts.push('Elige libremente entre mis utensilios el que mejor encaje con cada receta.');
  }
  const has = id => tools.includes(id) || mustUse.includes(id);
  if (has('airfryer')) parts.push(AIRFRYER_RULES);
  if (has('thermomix')) parts.push(THERMOMIX_RULES);
  return parts.join('\n');
}

module.exports = withSentry(async function handler(req, res) {
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

  const { ingredients, count } = req.body;
  const mustInclude = strList(req.body.mustInclude);
  const dietPrefs = strList(req.body.dietPrefs);
  const mealTypes = strList(req.body.mealTypes);
  const excludeNames = strList(req.body.excludeNames, 30);
  const timeLimits = numList(req.body.timeLimits, 5, 240);
  const servingsOptions = numList(req.body.servingsOptions, 1, 20);

  const mustUseTools = toolIds(req.body.mustUseTools);
  // Clientes antiguos (antes de "Mi cocina") mandan un único appliance que exigía las 3 recetas
  if (['airfryer', 'thermomix'].includes(req.body.appliance) && !mustUseTools.length) mustUseTools.push(req.body.appliance);
  const tools = toolIds(req.body.tools);
  // Lo obligatorio cuenta como disponible. Sin "Mi cocina" configurada (tools vacío) no se restringe nada,
  // así que no se añade: si no, el resto de electrodomésticos pasarían a contar como "no los tengo".
  if (tools.length) for (const id of mustUseTools) if (!tools.includes(id)) tools.push(id);
  const specialMust = mustUseTools.find(id => id === 'thermomix' || id === 'airfryer');

  // Exigir AirFryer/Thermomix es una función Pro — se verifica en el servidor
  if (specialMust) {
    const isPro = await isProUser(req);
    if (!isPro) {
      return res.status(403).json({ error: 'Las recetas para AirFryer y Thermomix son exclusivas del plan Pro.' });
    }
  }

  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'Se necesita al menos un ingrediente' });
  }

  // Basic input sanitization
  if (!Array.isArray(ingredients) || ingredients.length > 200) {
    return res.status(400).json({ error: 'Lista de ingredientes inválida' });
  }

  // Strip control characters and truncate each ingredient name
  const sanitizedIngredients = ingredients
    .filter(i => typeof i === 'string')
    .map(i => i.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80))
    .filter(i => i.length > 0);

  if (sanitizedIngredients.length === 0) {
    return res.status(400).json({ error: 'Se necesita al menos un ingrediente válido' });
  }
  ingredients.splice(0, ingredients.length, ...sanitizedIngredients);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Servicio no configurado correctamente' });
  }

  const dietText = dietPrefs.length > 0
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

  const toolsText = buildToolsBlock(tools, mustUseTools, recipeCount);

  // Recetas reales de Spoonacular como inspiración cuando se exige AirFryer/Thermomix
  let spoonacularContext = '';
  if (specialMust) {
    const spoonRecipes = await getSpoonacularRecipes(ingredients, specialMust);
    if (spoonRecipes.length > 0) {
      spoonacularContext = `Basándote en estas recetas reales de internet como inspiración (adapta y traduce al español):\n${
        spoonRecipes.map(r => {
          const ingList = (r.extendedIngredients || []).slice(0, 5).map(i => i.original).join(', ');
          return `- "${r.title}" (${r.readyInMinutes} min): ${ingList}`;
        }).join('\n')
      }\n\n`;
    }
  }

  const systemMsg = specialMust === 'thermomix'
    ? 'Eres un experto en Thermomix con conocimiento de miles de recetas de Cookidoo y blogs especializados. Cuando generas recetas para Thermomix, usas el formato exacto de Cookidoo: velocidades precisas, temperaturas, tiempos de programación y menciones a accesorios como la mariposa, el cestillo o el Varoma.'
    : specialMust === 'airfryer'
    ? 'Eres un experto en freidoras de aire (Air Fryer) con conocimiento de miles de recetas populares en internet. Cuando generas recetas para Air Fryer, incluyes siempre temperatura en °C, tiempo exacto de cocción, posición en la cesta y si hay que dar la vuelta.'
    : 'Eres un chef experto que sugiere recetas caseras prácticas y deliciosas basadas en los ingredientes disponibles.'
      + (tools.includes('thermomix') || tools.includes('airfryer') ? ' También dominas la Thermomix (formato Cookidoo) y la Air Fryer.' : '');

  const prompt = `${spoonacularContext}Soy un chef casero y tengo estos ingredientes en casa: ${ingredients.join(', ')}.

${excludeText}
${mustIncludeText}
${dietText}
${timeText}
${servingsText}
${mealText}
${toolsText}

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
      "steps": ["Paso 1: descripción clara.", "Paso 2: descripción clara."],
      "tools_used": ["placa"]
    }
  ]
}

difficulty solo puede ser: "fácil", "medio" o "difícil".
tools_used: ids de los electrodomésticos que usa la receta, solo de esta lista: ${Object.keys(TOOLS).join(', ')}.`;

  try {
    const content = await chatJSON([
      { role: 'system', content: systemMsg },
      { role: 'user', content: prompt }
    ], {
      endpoint: 'recipes',
      models: MODELS.recipes(),
      max_tokens: recipeCount === 1 ? 1200 : ([...tools, ...mustUseTools].includes('thermomix') ? 3000 : 2600),
      deadlineMs: 52_000,
      attemptTimeoutMs: 40_000,
    });

    const recipes = (Array.isArray(content.recipes) ? content.recipes : [])
      .filter(r => r && typeof r.name === 'string' && r.name.trim() && Array.isArray(r.steps) && r.steps.length > 0)
      .map(r => ({
        name: r.name.trim(),
        time_minutes: Number(r.time_minutes) || null,
        difficulty: ['fácil', 'medio', 'difícil'].includes(r.difficulty) ? r.difficulty : 'medio',
        key_ingredients: Array.isArray(r.key_ingredients) ? r.key_ingredients.map(String) : [],
        all_ingredients: Array.isArray(r.all_ingredients) ? r.all_ingredients.map(String) : [],
        steps: r.steps.map(String),
        tools_used: toolIds(r.tools_used),
      }))
      .map(r => ({
        ...r,
        // Columna appliance de saved_recipes (y badges de recetas guardadas antiguas)
        appliance: r.tools_used.includes('thermomix') ? 'thermomix' : r.tools_used.includes('airfryer') ? 'airfryer' : 'ninguno',
      }));

    if (recipes.length === 0) {
      return res.status(502).json({ error: 'La IA no ha devuelto recetas válidas. Inténtalo de nuevo.' });
    }

    return res.status(200).json({ recipes });
  } catch (err) {
    return sendError(res, err);
  }
});
