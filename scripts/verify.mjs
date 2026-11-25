import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const base = path.resolve('C:/Users/ZOBI/.gemini/antigravity/scratch/sm-tpu-inventory');
const jsFiles = ['web/app.js', 'web/initial-data.js', 'web/sw.js', 'google-apps-script/Code.gs'];

for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(base, f), 'utf8');
  new vm.Script(code, { filename: f });
  console.log('Syntax OK:', f);
}

const html = fs.readFileSync(path.join(base, 'web/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(base, 'web/app.js'), 'utf8');
const match = appJs.match(/function cacheDom\(\) \{[\s\S]*?\[([\s\S]*?)\]\.forEach/);
if (!match) throw new Error('cacheDom() block not found');
const ids = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const missing = ids.filter((id) => !html.includes(`id="${id}"`));
console.log('Checked DOM IDs:', ids.length, 'Missing:', missing);
if (missing.length > 0) {
  throw new Error('Missing DOM IDs: ' + missing.join(', '));
}

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(base, 'web/initial-data.js'), 'utf8'), sandbox);
const csvLines = fs.readFileSync(path.join(base, 'data/cleaned_inventory.csv'), 'utf8').trim().split(/\r?\n/);
const stock = sandbox.window.SM_INITIAL_STOCK;

console.log('Initial JS models:', stock.length, 'CSV data rows:', csvLines.length - 1);
if (stock.length !== csvLines.length - 1) {
  throw new Error('Mismatch between initial-data.js and cleaned_inventory.csv');
}

const b2NonZero = stock.filter((x) => x.branch2 !== 0);
if (b2NonZero.length > 0) {
  throw new Error('Expected all SM Branch 2 quantities to be 0');
}

console.log('All verification checks passed!');
