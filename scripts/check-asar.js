// ─── Post-build check: verify every relative require() in main.js's
//     dependency graph exists inside the packaged app.asar ───────────────────
// Prevents the "Cannot find module './xxx'" crash from missing files in the
// electron-builder "files" whitelist.
//
// Usage: node scripts/check-asar.js [outDir]   (default: out/win-unpacked)

const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const outDir = path.resolve(APP_DIR, process.argv[2] || 'out/win-unpacked');
const asarPath = path.join(outDir, 'resources', 'app.asar');
const mainFile = path.join(APP_DIR, 'main.js');

if (!fs.existsSync(asarPath)) {
  console.error(`asar not found: ${asarPath}`);
  process.exit(1);
}

function relativeRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let m;
  const re = /require\(['"](\.[^'"]+)['"]\)/g;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function resolveModule(fromFile, rel) {
  // Support './x' and './x.js' resolution (same as Node for .js files)
  const base = path.resolve(path.dirname(fromFile), rel);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(base + '.js')) return base + '.js';
  return null;
}

const entries = new Set(asar.listPackage(asarPath).map((e) => e.replace(/\\/g, '/')));
let ok = true;
const visited = new Set();

function visit(file) {
  if (visited.has(file)) return;
  visited.add(file);
  for (const rel of relativeRequires(file)) {
    const resolved = resolveModule(file, rel);
    if (!resolved) {
      console.error(`cannot resolve local file: ${rel} (required by ${path.relative(APP_DIR, file)})`);
      ok = false;
      continue;
    }
    const inAsar = '/' + path.relative(APP_DIR, resolved).replace(/\\/g, '/');
    if (!entries.has(inAsar)) {
      console.error(`MISSING in app.asar: ${inAsar}`);
      ok = false;
    }
    visit(resolved);
  }
}

visit(mainFile);

if (!ok) {
  console.error('\n✗ Packaged app is broken: missing modules. Fix package.json "build.files".');
  process.exit(1);
}
console.log('✓ asar check OK: all main.js requires are packaged.');
