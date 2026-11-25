// Kontrola vydání: verze v app.js a sw.js sedí a mezipaměť service workeru obsahuje
// přesně soubory, které aplikace potřebuje (jinak by offline start nebo aktualizace selhaly).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const ls = (dir, ext) => readdirSync(new URL(dir, root)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);

const app = read('js/app.js').match(/APP_VERSION = '([^']+)'/)[1];
const sw = read('sw.js');
assert.equal(sw.match(/const VERSION = '([^']+)'/)[1], `ukoly-${app}`, 'VERSION v sw.js musí být ukoly-<APP_VERSION>');

const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
for (const f of shell) assert.ok(existsSync(new URL(f, root)), `SHELL odkazuje na neexistující ${f}`);

const runtime = ['index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  ...ls('js', '.js'), ...ls('vendor', '.js'), ...ls('fonts', '.woff2'), ...ls('icons', '.png')];
for (const f of runtime) assert.ok(shell.includes(f), `${f} chybí v SHELL v sw.js`);

const manifest = JSON.parse(read('manifest.webmanifest'));
for (const i of manifest.icons) assert.ok(existsSync(new URL(i.src, root)), `ikona ${i.src} neexistuje`);
for (const [, f] of read('index.html').matchAll(/(?:href|src)="([^"#:]+)"/g)) assert.ok(existsSync(new URL(f, root)), `index.html odkazuje na neexistující ${f}`);
for (const [, f] of read('styles.css').matchAll(/url\(([^)]+)\)/g)) assert.ok(existsSync(new URL(f, root)), `styles.css odkazuje na neexistující ${f}`);

console.log(`vydání ${app}: verze, mezipaměť, ikony a odkazy OK`);
