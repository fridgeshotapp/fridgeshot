#!/usr/bin/env node
// Smoke test contra un despliegue real (por defecto producción).
//   npm run smoke                      → https://fridgeshot.app
//   npm run smoke -- https://otra-url  → otra URL
//
// Solo hace peticiones baratas: ninguna llega a OpenAI (cuerpos inválidos → 400).
// Un 5xx o 503 en cualquiera de ellas significa que algo está roto (Redis, env vars,
// código que peta antes de validar...). Sale con código 1 si algo falla.

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'https://fridgeshot.app').replace(/\/$/, '');
const TIMEOUT_MS = 30_000;

async function req(method, path, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  } finally {
    clearTimeout(t);
  }
}

const checks = [
  ['GET /  (landing)', async () => {
    const r = await req('GET', '/');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  }],
  ['GET /app  (app + SDK de Supabase self-hosted)', async () => {
    const r = await req('GET', '/app');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.text.includes('/assets/supabase.min.js')) throw new Error('falta el script de Supabase');
    if (!r.text.includes('onAuthStateChange')) throw new Error('falta la inicialización de auth');
  }],
  ['GET /assets/supabase.min.js', async () => {
    const r = await req('GET', '/assets/supabase.min.js');
    if (r.status !== 200 || r.text.length < 50_000) throw new Error(`HTTP ${r.status}, ${r.text.length} bytes`);
  }],
  ['GET /sw.js', async () => {
    const r = await req('GET', '/sw.js');
    if (r.status !== 200 || !/fridgeshot-v\d+/.test(r.text)) throw new Error(`HTTP ${r.status}`);
  }],
  ['GET /manifest.json', async () => {
    const r = await req('GET', '/manifest.json');
    if (r.status !== 200 || !r.json) throw new Error(`HTTP ${r.status}`);
  }],
  ...[
    ['/api/analyze', { imagesBase64: [] }],
    ['/api/recipes', { ingredients: [] }],
    ['/api/chat', {}],
    ['/api/image', {}],
    ['/api/waitlist', { email: 'no-es-un-email' }],
  ].map(([path, body]) => [`POST ${path}  (validación → 400)`, async () => {
    const r = await req('POST', path, body);
    if (r.status === 429) return 'rate limited (ok)';
    if (r.status !== 400) throw new Error(`esperaba 400, recibido ${r.status}: ${r.text.slice(0, 150)}`);
  }]),
  ['GET /api/health  (Supabase, Redis, OpenAI, env vars)', async () => {
    const r = await req('GET', '/api/health');
    if (!r.json) throw new Error(`HTTP ${r.status}, respuesta no JSON`);
    if (!r.json.ok) throw new Error(JSON.stringify(r.json.checks));
    return `versión ${r.json.version}`;
  }],
];

// Códigos de salida: 0 = todo OK · 1 = la app desplegada falla · 2 = la app responde
// pero /api/health indica un servicio externo/config rota (no lo arregla un rollback).
(async () => {
  console.log(`Smoke test → ${BASE}\n`);
  let failed = 0, healthFailed = false;
  for (const [name, fn] of checks) {
    try {
      const note = await fn();
      console.log(`  ✔ ${name}${note ? `  — ${note}` : ''}`);
    } catch (err) {
      if (name.startsWith('GET /api/health')) healthFailed = true; else failed++;
      console.log(`  ✖ ${name}\n      ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    }
  }
  if (failed) {
    console.log(`\n✖ ${failed} comprobación(es) de la app fallida(s)`);
    process.exit(1);
  }
  if (healthFailed) {
    console.log('\n⚠ La app responde, pero un servicio externo o la configuración fallan (ver /api/health arriba).');
    process.exit(2);
  }
  console.log('\n✔ Todo OK');
})();
