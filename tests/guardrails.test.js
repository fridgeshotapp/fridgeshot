// Barandillas de arquitectura: reglas que, si se rompen, tumban producción.
// Cada test corresponde a un fallo real que ya ocurrió o a una regla de CLAUDE.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./helpers');

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const apiFiles = (dir = 'api') => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? apiFiles(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
const endpoints = apiFiles().filter(f => !path.basename(f).startsWith('_'));
const vercel = JSON.parse(read('vercel.json'));
const appHtml = read('app.html');

test('cada endpoint está envuelto en withSentry()', () => {
  for (const f of endpoints) assert.match(read(f), /withSentry\(/, f);
});

test('rateLimit() siempre se llama con (req, res, ...) — el bug que rompió /api/image', () => {
  for (const f of apiFiles()) {
    const src = read(f);
    for (const m of src.matchAll(/await rateLimit\(([^)]*)\)/g)) {
      assert.match(m[1], /^\s*req\s*,\s*res\s*,/, `${f}: rateLimit(${m[1].slice(0, 40)}...)`);
    }
  }
});

test('ningún endpoint llama a OpenAI directamente (todo pasa por _openai.js)', () => {
  for (const f of endpoints) assert.doesNotMatch(read(f), /api\.openai\.com\/v1\/(chat|images)/, f);
});

test('no se supera el límite de 12 funciones del plan Hobby de Vercel', () => {
  assert.ok(endpoints.length <= 12, `${endpoints.length} funciones: ${endpoints.join(', ')}`);
});

test('timeouts ordenados: deadline del handler < maxDuration < timeout del cliente', () => {
  const clientTimeouts = Object.fromEntries([...appHtml.match(/const API_TIMEOUTS = \{([^}]*)\}/)[1]
    .matchAll(/(\w+):\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
  for (const name of ['analyze', 'recipes', 'image', 'chat']) {
    const maxDuration = (vercel.functions[`api/${name}.js`]?.maxDuration || 10) * 1000;
    const deadlines = [...read(`api/${name}.js`).matchAll(/(?:deadlineMs:|55_000|deadlineMs =)\s*([\d_]+)?/g)]
      .map(m => Number((m[1] || '55000').replace(/_/g, ''))).filter(Boolean);
    for (const d of deadlines) assert.ok(d < maxDuration, `${name}: deadline ${d} >= maxDuration ${maxDuration}`);
    assert.ok(clientTimeouts[name] > maxDuration, `${name}: cliente ${clientTimeouts[name]} <= maxDuration ${maxDuration}`);
  }
  const safety = Number(appHtml.match(/\}, (\d+)\); \/\/ red de seguridad/)[1]);
  assert.ok(safety > Math.max(...Object.values(clientTimeouts)), 'timeout de la pantalla de carga demasiado corto');
});

test('el cron de keepalive apunta a un endpoint que existe y es diario', () => {
  for (const c of vercel.crons) {
    assert.ok(fs.existsSync(path.join(ROOT, c.path.replace(/^\//, '') + '.js')), c.path);
    assert.equal(c.schedule.split(' ')[2], '*', 'debe ejecutarse todos los días');
  }
});

test('CSP permite los orígenes que usa la app', () => {
  const csp = vercel.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  const directive = name => csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ')) || '';
  const supabase = 'https://amniuriaesnvgagfjhre.supabase.co';
  assert.ok(directive('connect-src').includes(supabase), 'connect-src sin Supabase');
  assert.ok(directive('img-src').includes(supabase), 'img-src sin Supabase Storage');
  assert.ok(directive('connect-src').includes('https://eu.i.posthog.com'), 'connect-src sin PostHog');
  assert.ok(directive('script-src').includes('https://eu-assets.i.posthog.com'), 'script-src sin PostHog');
  // El cliente de Supabase en app.html debe apuntar al mismo proyecto que la CSP
  assert.ok(appHtml.includes(`'${supabase}'`), 'app.html usa otro proyecto Supabase');
});

test('/app nunca se cachea en la CDN', () => {
  const app = vercel.headers.find(h => h.source === '/app');
  assert.match(app.headers.find(h => h.key === 'Cache-Control').value, /s-maxage=0/);
});

test('app.html: todo el JS inline es sintácticamente válido', () => {
  const scripts = [...appHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0);
  scripts.forEach((s, i) => assert.doesNotThrow(() => new vm.Script(s), `script inline #${i}`));
});

test('app.html: el SDK de Supabase es self-hosted (las CDN se bloquean en redes corporativas)', () => {
  assert.match(appHtml, /<script src="\/assets\/supabase\.min\.js"><\/script>/);
  assert.doesNotMatch(appHtml, /<script[^>]+src="https:\/\/cdn\.jsdelivr\.net/);
  assert.ok(fs.statSync(path.join(ROOT, 'assets/supabase.min.js')).size > 50_000);
});

test('app.html: el callback de onAuthStateChange no es async (deadlock de supabase-js)', () => {
  const calls = [...appHtml.matchAll(/onAuthStateChange\(\s*(async\s*)?\(/g)];
  assert.ok(calls.length > 0, 'no se encontró onAuthStateChange');
  for (const m of calls) assert.ok(!m[1], 'onAuthStateChange(async ...) bloquea el login');
});

test('app.html: las llamadas a /api usan apiPost (timeouts + reintentos), no fetch directo', () => {
  const direct = [...appHtml.matchAll(/fetch\('\/api\/(\w[\w-]*)/g)].map(m => m[1]);
  assert.deepEqual(direct.filter(n => !['client-error'].includes(n) && !n.startsWith('stripe')), []);
});

test('sw.js: solo intercepta el propio origen y la caché tiene versión', () => {
  const sw = read('sw.js');
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /const CACHE = 'fridgeshot-v\d+'/);
  const STATIC = JSON.parse(sw.match(/const STATIC = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const p of STATIC) {
    if (p === '/app') continue;
    assert.ok(fs.existsSync(path.join(ROOT, p)), `sw.js STATIC incluye ${p}, que no existe (la instalación del SW fallaría)`);
  }
});

test('los iconos versionados que usan manifest/HTML existen', () => {
  const refs = new Set([...(read('manifest.json') + appHtml + read('index.html')).matchAll(/\/assets\/(icon-[\w-]+\.png)/g)].map(m => m[1]));
  for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, 'assets', r)), r);
});
