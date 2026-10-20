// Tests de la infraestructura compartida: env vars y rate limit.
const test = require('node:test');
const assert = require('node:assert');
const { mockRes } = require('./helpers');

test('_env: limpia saltos de línea, espacios y comillas', () => {
  process.env.UPSTASH_REDIS_REST_URL = '"https://x.upstash.io\n" ';
  process.env.STRIPE_PRICE_ID = '   ';
  delete require.cache[require.resolve('../api/_env')];
  require('../api/_env');
  assert.equal(process.env.UPSTASH_REDIS_REST_URL, 'https://x.upstash.io');
  assert.equal(process.env.STRIPE_PRICE_ID, undefined);
  delete process.env.UPSTASH_REDIS_REST_URL;
});

test('ratelimit: windowToMs', () => {
  const { _windowToMs } = require('../api/_ratelimit');
  assert.equal(_windowToMs('1 d'), 86_400_000);
  assert.equal(_windowToMs('7 d'), 7 * 86_400_000);
  assert.equal(_windowToMs('1 h'), 3_600_000);
});

test('ratelimit: el respaldo en memoria limita por IP y por endpoint', () => {
  const { _memoryLimit } = require('../api/_ratelimit');
  for (let i = 0; i < 3; i++) assert.equal(_memoryLimit('t', '1.1.1.1', 3, '1 h').success, true);
  assert.equal(_memoryLimit('t', '1.1.1.1', 3, '1 h').success, false);
  assert.equal(_memoryLimit('t', '2.2.2.2', 3, '1 h').success, true);
  assert.equal(_memoryLimit('otro', '1.1.1.1', 3, '1 h').success, true);
});

test('ratelimit: Redis caído → no tumba la petición y aplica el límite en memoria', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://does-not-exist.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  const realFetch = global.fetch;
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    const { rateLimit } = require('../api/_ratelimit');
    const req = { headers: { 'x-forwarded-for': '9.9.9.9' } };
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await rateLimit(req, mockRes(), 'redisdown', 2, '1 h', 'limit'));
    assert.deepEqual(results, [true, true, false]);
  } finally {
    global.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
  }
});

test('ratelimit: en Vercel sin Redis configurado también limita', async () => {
  process.env.VERCEL = '1';
  try {
    const { rateLimit } = require('../api/_ratelimit');
    const req = { headers: { 'x-forwarded-for': '8.8.4.4' } };
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await rateLimit(req, mockRes(), 'noredis', 1, '1 h', 'limit'));
    assert.deepEqual(results, [true, false]);
  } finally {
    delete process.env.VERCEL;
  }
});
