#!/usr/bin/env node
// Deploy seguro a producción:  npm run deploy
//
//   1. Avisa si hay cambios sin commitear (no se despliegan).
//   2. Ejecuta los tests — si fallan, NO despliega.
//   3. Push de master → master (preview) y main (producción de Vercel).
//   4. Espera a que producción sirva este commit (/api/health devuelve la versión).
//   5. Ejecuta el smoke test contra producción.
//   6. Si algo falla, explica cómo volver atrás.

const { spawnSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROD = 'https://fridgeshot.app';
const sh = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const run = (cmd, args, env) => spawnSync(cmd, args, {
  cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env },
}).status;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rollbackHelp(sha) {
  console.log(`
Cómo volver atrás:
  • Rápido (sin código): vercel.com → fridgeshot → Deployments → el deploy anterior
    que funcionaba → ⋯ → "Instant Rollback". Tarda segundos.
  • Con git:  git revert ${sha}  &&  npm run deploy
`);
}

(async () => {
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'master') {
    console.error(`✖ Estás en "${branch}". Despliega desde master.`);
    process.exit(1);
  }

  const dirty = sh('git status --porcelain');
  if (dirty) {
    console.log('⚠ Hay cambios sin commitear. NO se van a desplegar:\n' + dirty.split('\n').map(l => '    ' + l).join('\n') + '\n');
  }

  console.log('▶ Tests…');
  if (run('npm', ['test', '--silent']) !== 0) {
    console.error('\n✖ Los tests fallan. No se despliega.');
    process.exit(1);
  }

  const sha = sh('git rev-parse --short=7 HEAD');
  console.log(`\n▶ Push ${sha} → master + main…`);
  // Refspecs explícitos: no depende de la config local del remoto
  if (run('git', ['push', 'origin', 'master:master', 'master:main'], { FRIDGESHOT_TESTED: '1' }) !== 0) {
    console.error('✖ Falló el push.');
    process.exit(1);
  }

  console.log(`\n▶ Esperando a que ${PROD} sirva ${sha}…`);
  const deadline = Date.now() + 6 * 60_000;
  let live = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${PROD}/api/health`, { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (j?.version === sha) { live = true; break; }
    } catch {}
    process.stdout.write('.');
    await sleep(10_000);
  }
  console.log('');
  if (!live) {
    console.error(`✖ Tras 6 min producción no sirve ${sha}. Mira el build en vercel.com → fridgeshot → Deployments.`);
    process.exit(1);
  }

  console.log('▶ Smoke test en producción…');
  const smoke = run('node', [path.join('scripts', 'smoke.js'), PROD]);
  if (smoke === 2) {
    console.log(`\n⚠ ${sha} desplegado y la app responde, pero /api/health marca un servicio o variable de entorno roto.`);
    console.log('  No es culpa de este deploy (un rollback no lo arregla): revisa el servicio indicado arriba.');
    process.exit(2);
  }
  if (smoke !== 0) {
    console.error(`\n✖ El deploy ${sha} está en producción pero el smoke test falla.`);
    rollbackHelp(sha);
    process.exit(1);
  }
  console.log(`\n✔ ${sha} desplegado y verificado en ${PROD}`);
})();
