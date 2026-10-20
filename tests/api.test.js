// Tests de los endpoints con OpenAI simulado: reintentos, fallbacks y validación de entrada.
const test = require('node:test');
const assert = require('node:assert');
const { J, chatOk, mock, queue, call, PNG_B64 } = require('./helpers');

test('analyze: reintenta tras 500 y 429 y limpia la respuesta', async () => {
  queue(J(500, {}), J(429, { error: { message: 'slow down' } }), chatOk('{"all_ingredients":["leche"," huevos ",3]}'));
  const res = await call('analyze.js', { imagesBase64: [PNG_B64] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.all_ingredients, ['leche', 'huevos']);
  assert.equal(mock.calls.length, 3);
});

test('analyze: modelo retirado (404) → usa el fallback', async () => {
  queue(J(404, { error: { code: 'model_not_found' } }), chatOk('{"all_ingredients":["x"]}'));
  const res = await call('analyze.js', { imagesBase64: [PNG_B64] });
  assert.equal(res.statusCode, 200);
  assert.notEqual(mock.calls[0].model, mock.calls[1].model);
});

test('analyze: la imagen se envía con el MIME correcto', async () => {
  queue(chatOk('{"all_ingredients":[]}'));
  await call('analyze.js', { imagesBase64: [PNG_B64] });
  const url = mock.calls[0].body.messages[0].content[0].image_url.url;
  assert.match(url, /^data:image\/png;base64,/);
});

test('analyze: rechaza entradas inválidas sin llamar a OpenAI', async () => {
  queue();
  const bodies = [{}, { imagesBase64: [] }, { imagesBase64: ['x'] }, { imagesBase64: Array(6).fill(PNG_B64) }, { imagesBase64: ['A'.repeat(200)] }];
  for (const body of bodies) {
    const res = await call('analyze.js', body);
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(mock.calls.length, 0);
});

test('recipes: JSON truncado → reintenta; normaliza recetas y descarta inválidas', async () => {
  queue(chatOk('{"recipes": [{"name":"A"'), chatOk(JSON.stringify({ recipes: [
    { name: 'Tortilla', time_minutes: '20', difficulty: 'fácil', steps: ['a'] },
    { name: '' },
    { name: 'Sin pasos', steps: [] },
  ] })));
  const res = await call('recipes.js', { ingredients: ['huevo'], dietPrefs: 'vegano', timeLimits: ['30', 'x'] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recipes.length, 1);
  assert.equal(res.body.recipes[0].time_minutes, 20);
});

test('recipes: ninguna receta válida → 502 con mensaje legible', async () => {
  queue(chatOk('{"recipes":[]}'));
  const res = await call('recipes.js', { ingredients: ['huevo'] });
  assert.equal(res.statusCode, 502);
  assert.ok(res.body.error);
});

test('recipes: clave de OpenAI inválida → 500 sin reintentar', async () => {
  queue(J(401, {}));
  const res = await call('recipes.js', { ingredients: ['huevo'] });
  assert.equal(res.statusCode, 500);
  assert.equal(mock.calls.length, 1);
});

test('recipes: sin ingredientes → 400', async () => {
  queue();
  const res = await call('recipes.js', { ingredients: [] });
  assert.equal(res.statusCode, 400);
});

test('chat: error de red → reintenta', async () => {
  queue(new TypeError('fetch failed'), chatOk('Hola'));
  const res = await call('chat.js', { recipe: { name: 'x', all_ingredients: 'no-array' }, messages: [], userMessage: 'hola' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, 'Hola');
});

test('chat: sin saldo en OpenAI → 503 sin reintentar', async () => {
  queue(J(429, { error: { code: 'insufficient_quota' } }));
  const res = await call('chat.js', { recipe: { name: 'x' }, messages: [], userMessage: 'hola' });
  assert.equal(res.statusCode, 503);
  assert.equal(mock.calls.length, 1);
});

test('image: 403 (organización sin verificar) → siguiente modelo', async () => {
  queue(J(403, { error: { message: 'org must be verified' } }), J(200, { data: [{ b64_json: 'abc' }] }));
  const res = await call('image.js', { recipeName: 'Tortilla', ingredients: ['huevo'] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.b64, 'abc');
  assert.equal(mock.calls.length, 2);
});

test('image: valida la entrada', async () => {
  queue();
  const res = await call('image.js', {});
  assert.equal(res.statusCode, 400);
});

test('client-error: acepta un error y rechaza cuerpos vacíos', async () => {
  queue();
  assert.equal((await call('client-error.js', { message: 'boom' })).statusCode, 204);
  assert.equal((await call('client-error.js', {})).statusCode, 400);
});

test('todos los endpoints POST rechazan GET con 405', async () => {
  for (const f of ['analyze.js', 'recipes.js', 'chat.js', 'image.js', 'waitlist.js', 'client-error.js']) {
    const res = await call(f, null, { method: 'GET' });
    assert.equal(res.statusCode, 405, f);
  }
});
