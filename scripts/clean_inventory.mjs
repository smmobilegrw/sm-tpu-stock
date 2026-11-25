import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve('C:/Users/ZOBI/.gemini/antigravity/scratch/sm-tpu-inventory');
const rawCsv = fs.readFileSync(path.join(rootDir, 'data', 'raw_inventory.csv'), 'utf8');

function parseCsvRows(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current.trim());
    rows.push(cols);
  }
  return rows;
}

const rows = parseCsvRows(rawCsv);
const header = rows[0];

// Pair columns: (0,1)=Samsung, (2,3)=Vivo, (4,5)=Oppo, (6,7)=Infinix,
// (8,9)=Tecno, (10,11)=Itel (+Google, Huawei, Honor), (12,13)=Redmi (+Realme), (14,15)=iPhone
const brandPairs = [
  { col: 0, initialBrand: 'Samsung' },
  { col: 2, initialBrand: 'Vivo' },
  { col: 4, initialBrand: 'Oppo' },
  { col: 6, initialBrand: 'Infinix' },
  { col: 8, initialBrand: 'Tecno' },
  { col: 10, initialBrand: 'Itel' },
  { col: 12, initialBrand: 'Redmi' },
  { col: 14, initialBrand: 'iPhone' },
];

const embeddedBrands = new Set(['Google', 'Huawei', 'Honor', 'Realme']);

function cleanModelName(brand, model) {
  let m = model.replace(/\s+/g, ' ').trim();
  if (brand === 'Redmi') {
    m = m.replace(/^Redme\b/i, 'Redmi');
  }
  if (brand === 'Tecno') {
    m = m.replace(/^Caom\b/i, 'Camon');
  }
  return m;
}

const itemsMap = new Map();
const issues = [];

for (const pair of brandPairs) {
  let activeBrand = pair.initialBrand;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawModel = (row[pair.col] ?? '').trim();
    const rawQty = (row[pair.col + 1] ?? '').trim();

    if (!rawModel && !rawQty) continue;

    // Check if this cell is an embedded brand sub-header (e.g. Google, Huawei, Honor, Realme)
    if (embeddedBrands.has(rawModel) && (rawQty === '' || rawQty.toLowerCase() === 'rem')) {
      activeBrand = rawModel;
      continue;
    }

    if (!rawModel) continue;

    const model = cleanModelName(activeBrand, rawModel);
    let qty = 0;
    if (rawQty === '' || rawQty === '?') {
      issues.push(`${activeBrand} -> "${model}": invalid/blank qty ("${rawQty || 'blank'}"), set to 0`);
      qty = 0;
    } else if (/^\d+$/.test(rawQty)) {
      qty = Number(rawQty);
    } else {
      issues.push(`${activeBrand} -> "${model}": unexpected qty "${rawQty}", set to 0`);
      qty = 0;
    }

    const key = `${activeBrand.toLowerCase()}::${model.toLowerCase()}`;
    if (itemsMap.has(key)) {
      const existing = itemsMap.get(key);
      issues.push(`Duplicate merged: ${activeBrand} "${model}" (${existing.branch1} + ${qty} = ${existing.branch1 + qty})`);
      existing.branch1 += qty;
    } else {
      itemsMap.set(key, {
        id: `${activeBrand.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        brand: activeBrand,
        model,
        branch1: qty,
        branch2: 0,
        minAlert: 2,
      });
    }
  }
}

const brandOrder = [
  'Samsung',
  'Vivo',
  'Oppo',
  'Infinix',
  'Tecno',
  'Itel',
  'Redmi',
  'iPhone',
  'Realme',
  'Google',
  'Huawei',
  'Honor',
];

const items = Array.from(itemsMap.values()).sort((a, b) => {
  const bi = brandOrder.indexOf(a.brand);
  const bj = brandOrder.indexOf(b.brand);
  if (bi !== bj) return bi - bj;
  return a.model.localeCompare(b.model, undefined, { numeric: true, sensitivity: 'base' });
});

// Ensure unique IDs even if punctuation collapses
const seenIds = new Set();
for (const item of items) {
  let id = item.id.replace(/^-+|-+$/g, '');
  let suffix = 2;
  let candidate = id;
  while (seenIds.has(candidate)) {
    candidate = `${id}-${suffix++}`;
  }
  item.id = candidate;
  seenIds.add(candidate);
}

// Write cleaned_inventory.csv
const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const today = new Date().toISOString().slice(0, 10);
const csvLines = [
  ['Brand', 'Model', 'SM Branch 1', 'SM Branch 2', 'Total_Qty', 'Min_Alert', 'Last_Updated'].join(','),
];

items.forEach((item, idx) => {
  const rowNum = idx + 2;
  csvLines.push(
    [
      csvEscape(item.brand),
      csvEscape(item.model),
      item.branch1,
      item.branch2,
      `=C${rowNum}+D${rowNum}`,
      item.minAlert,
      today,
    ].join(',')
  );
});

fs.writeFileSync(path.join(rootDir, 'data', 'cleaned_inventory.csv'), csvLines.join('\n') + '\n', 'utf8');

// Write web/initial-data.js
fs.mkdirSync(path.join(rootDir, 'web'), { recursive: true });
const jsContent = `// Auto-generated from raw_inventory.csv by scripts/clean_inventory.mjs
window.SM_INITIAL_CONFIG = {
  branches: ["SM Branch 1", "SM Branch 2"],
  brands: ${JSON.stringify(brandOrder, null, 2)}
};

window.SM_INITIAL_STOCK = ${JSON.stringify(items, null, 2)};
`;
fs.writeFileSync(path.join(rootDir, 'web', 'initial-data.js'), jsContent, 'utf8');

const totalB1 = items.reduce((s, x) => s + x.branch1, 0);
console.log(JSON.stringify({
  totalModels: items.length,
  totalBranch1Pcs: totalB1,
  totalBranch2Pcs: 0,
  brandsCount: new Set(items.map((i) => i.brand)).size,
  issues,
}, null, 2));
