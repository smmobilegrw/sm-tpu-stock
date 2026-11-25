/**
 * SM TPU Inventory — Google Apps Script Backend
 * Supports: SM Branch 1 & SM Branch 2, Atomic Stock Updates,
 * Date-wise Daily_Sales, Stock_In, Transfers, Print_View, and Daily Drive Backups.
 */

const CONFIG = {
  BRANCHES: ['SM Branch 1', 'SM Branch 2'],
  SHEETS: {
    STOCK: 'Current_Stock',
    SALES: 'Daily_Sales',
    STOCK_IN: 'Stock_In',
    TRANSFERS: 'Transfers',
    PRINT: 'Print_View',
  },
  BACKUP_FOLDER: 'SM_TPU_Daily_Backups',
  DEFAULT_MIN_ALERT: 2,
};

/**
 * Adds a custom menu inside Google Sheets for 1-click setup, print refresh, and backup.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SM TPU App')
    .addItem('1. Setup / Repair Sheets', 'setupWorkbook')
    .addItem('2. Enable Daily Auto-Backup (11:55 PM)', 'setupDailyBackupTrigger')
    .addSeparator()
    .addItem('Refresh Print View', 'refreshPrintView')
    .addItem('Run Backup Now', 'createDailyBackup')
    .addToUi();
}

function setupWorkbook() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, CONFIG.SHEETS.STOCK, [
    'Brand',
    'Model',
    'SM Branch 1',
    'SM Branch 2',
    'Total_Qty',
    'Min_Alert',
    'Last_Updated',
  ], '#0f766e');

  ensureSheet_(ss, CONFIG.SHEETS.SALES, [
    'Entry_ID',
    'Date',
    'Time',
    'Branch',
    'User',
    'Brand',
    'Model',
    'Qty_Sold',
    'Note',
    'Status',
  ], '#1d4ed8');

  ensureSheet_(ss, CONFIG.SHEETS.STOCK_IN, [
    'Entry_ID',
    'Date',
    'Time',
    'Branch',
    'User',
    'Brand',
    'Model',
    'Qty_Added',
    'Note',
  ], '#047857');

  ensureSheet_(ss, CONFIG.SHEETS.TRANSFERS, [
    'Entry_ID',
    'Date',
    'Time',
    'From_Branch',
    'To_Branch',
    'Brand',
    'Model',
    'Qty',
    'Requested_By',
    'Note',
  ], '#6d28d9');

  ensureSheet_(ss, CONFIG.SHEETS.PRINT, ['SM TPU Stock — Printable Sheet'], '#1e293b');
  refreshPrintView();
  return { ok: true, message: 'Workbook setup complete.' };
}

function ensureSheet_(ss, name, headers, headerColor) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0 && headers && headers.length > 0) {
    const range = sheet.getRange(1, 1, 1, headers.length);
    range.setValues([headers]);
    range.setFontWeight('bold');
    range.setBackground(headerColor || '#0f172a');
    range.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function setupDailyBackupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'createDailyBackup') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('createDailyBackup')
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .nearMinute(55)
    .create();
  return { ok: true, message: 'Daily backup trigger scheduled around 11:55 PM.' };
}

function createDailyBackup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Karachi';
  const dateStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const backupName = 'SM_TPU_Backup_' + dateStr;

  const folders = DriveApp.getFoldersByName(CONFIG.BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.BACKUP_FOLDER);

  // Replace existing same-day backup if triggered manually more than once
  const existing = folder.getFilesByName(backupName);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  const file = DriveApp.getFileById(ss.getId());
  const copy = file.makeCopy(backupName, folder);
  return {
    ok: true,
    backupName: backupName,
    url: copy.getUrl(),
    createdAt: new Date().toISOString(),
  };
}

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = params.action || 'ping';

    if (action === 'ping') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      return jsonResponse_({
        ok: true,
        app: 'SM TPU Inventory',
        sheetName: ss.getName(),
        branches: CONFIG.BRANCHES,
        serverTime: new Date().toISOString(),
      });
    }

    if (action === 'sync') {
      return jsonResponse_(getFullSyncData_(params.limit ? Number(params.limit) : 250));
    }

    if (action === 'report') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const tz = ss.getSpreadsheetTimeZone() || 'Asia/Karachi';
      const dateStr = params.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
      return jsonResponse_(getDateReport_(dateStr));
    }

    return jsonResponse_({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message || String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(bodyText);
    const action = payload.action;

    if (!action) {
      return jsonResponse_({ ok: false, error: 'Missing action in request payload.' });
    }

    let result;
    switch (action) {
      case 'sell':
        result = handleSell_(payload);
        break;
      case 'return_sale':
        result = handleReturnSale_(payload);
        break;
      case 'stock_in':
        result = handleStockIn_(payload);
        break;
      case 'transfer':
        result = handleTransfer_(payload);
        break;
      case 'add_model':
        result = handleAddModel_(payload);
        break;
      case 'seed_inventory':
        result = handleSeedInventory_(payload);
        break;
      case 'refresh_print_view':
        result = refreshPrintView();
        break;
      case 'run_backup':
        result = createDailyBackup();
        break;
      default:
        result = { ok: false, error: 'Unknown POST action: ' + action };
    }

    return jsonResponse_(result);
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message || String(err) });
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDateTimeParts_(isoOrNow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Karachi';
  const d = isoOrNow ? new Date(isoOrNow) : new Date();
  return {
    date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'),
    time: Utilities.formatDate(d, tz, 'HH:mm:ss'),
  };
}

function branchColIndex_(branch) {
  if (branch === 'SM Branch 1') return 3; // C
  if (branch === 'SM Branch 2') return 4; // D
  throw new Error('Invalid branch: ' + branch);
}

function loadStockIndex_(stockSheet) {
  const lastRow = stockSheet.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;
  const values = stockSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < values.length; i++) {
    const brand = String(values[i][0] || '').trim();
    const model = String(values[i][1] || '').trim();
    if (!brand || !model) continue;
    const key = brand.toLowerCase() + '::' + model.toLowerCase();
    map.set(key, {
      rowNum: i + 2,
      brand: brand,
      model: model,
      branch1: Number(values[i][2]) || 0,
      branch2: Number(values[i][3]) || 0,
      minAlert: Number(values[i][5]) || CONFIG.DEFAULT_MIN_ALERT,
    });
  }
  return map;
}

function hasDuplicateEntryId_(sheet, entryId) {
  if (!entryId) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const start = Math.max(2, lastRow - 300);
  const ids = sheet.getRange(start, 1, lastRow - start + 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(entryId)) return true;
  }
  return false;
}

function handleSell_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ensureSheet_(ss, CONFIG.SHEETS.STOCK);
  const salesSheet = ensureSheet_(ss, CONFIG.SHEETS.SALES);

  const entryId = payload.clientTxId || Utilities.getUuid();
  if (hasDuplicateEntryId_(salesSheet, entryId)) {
    return { ok: true, deduplicated: true, entryId: entryId };
  }

  const branch = payload.branch;
  const branchCol = branchColIndex_(branch);
  const qty = Number(payload.qty);
  if (!qty || qty <= 0) throw new Error('Qty must be greater than 0.');

  const key = String(payload.brand || '').trim().toLowerCase() + '::' + String(payload.model || '').trim().toLowerCase();
  const index = loadStockIndex_(stockSheet);
  const item = index.get(key);
  if (!item) throw new Error('Model not found: ' + payload.brand + ' ' + payload.model);

  const currentQty = branchCol === 3 ? item.branch1 : item.branch2;
  if (currentQty < qty) {
    throw new Error('Insufficient stock in ' + branch + ' (Available: ' + currentQty + ', Requested: ' + qty + ')');
  }

  const newQty = currentQty - qty;
  const dt = getDateTimeParts_(payload.timestamp);
  stockSheet.getRange(item.rowNum, branchCol).setValue(newQty);
  stockSheet.getRange(item.rowNum, 7).setValue(dt.date);

  salesSheet.appendRow([
    entryId,
    dt.date,
    dt.time,
    branch,
    payload.user || branch,
    item.brand,
    item.model,
    qty,
    payload.note || '',
    'SOLD',
  ]);

  return {
    ok: true,
    entryId: entryId,
    brand: item.brand,
    model: item.model,
    branch: branch,
    newQty: newQty,
  };
}

function handleReturnSale_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ensureSheet_(ss, CONFIG.SHEETS.STOCK);
  const salesSheet = ensureSheet_(ss, CONFIG.SHEETS.SALES);

  const entryId = payload.clientTxId || Utilities.getUuid();
  if (hasDuplicateEntryId_(salesSheet, entryId)) {
    return { ok: true, deduplicated: true, entryId: entryId };
  }

  const branch = payload.branch;
  const branchCol = branchColIndex_(branch);
  const qty = Number(payload.qty);
  if (!qty || qty <= 0) throw new Error('Return qty must be greater than 0.');

  const key = String(payload.brand || '').trim().toLowerCase() + '::' + String(payload.model || '').trim().toLowerCase();
  const index = loadStockIndex_(stockSheet);
  const item = index.get(key);
  if (!item) throw new Error('Model not found: ' + payload.brand + ' ' + payload.model);

  const currentQty = branchCol === 3 ? item.branch1 : item.branch2;
  const newQty = currentQty + qty;
  const dt = getDateTimeParts_(payload.timestamp);
  stockSheet.getRange(item.rowNum, branchCol).setValue(newQty);
  stockSheet.getRange(item.rowNum, 7).setValue(dt.date);

  salesSheet.appendRow([
    entryId,
    dt.date,
    dt.time,
    branch,
    payload.user || branch,
    item.brand,
    item.model,
    -qty,
    payload.note || 'Return / Undo',
    'RETURNED',
  ]);

  return { ok: true, entryId: entryId, newQty: newQty };
}

function handleStockIn_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ensureSheet_(ss, CONFIG.SHEETS.STOCK);
  const stockInSheet = ensureSheet_(ss, CONFIG.SHEETS.STOCK_IN);

  const branch = payload.branch;
  const branchCol = branchColIndex_(branch);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new Error('No stock-in items provided.');

  const batchId = payload.clientTxId || Utilities.getUuid();
  if (hasDuplicateEntryId_(stockInSheet, batchId + '#0')) {
    return { ok: true, deduplicated: true, batchId: batchId };
  }

  const index = loadStockIndex_(stockSheet);
  const dt = getDateTimeParts_(payload.timestamp);
  const logRows = [];

  for (let i = 0; i < items.length; i++) {
    const req = items[i];
    const qty = Number(req.qty);
    if (!qty || qty <= 0) continue;
    const key = String(req.brand || '').trim().toLowerCase() + '::' + String(req.model || '').trim().toLowerCase();
    const item = index.get(key);
    if (!item) throw new Error('Model not found: ' + req.brand + ' ' + req.model);

    const currentQty = branchCol === 3 ? item.branch1 : item.branch2;
    const newQty = currentQty + qty;
    stockSheet.getRange(item.rowNum, branchCol).setValue(newQty);
    stockSheet.getRange(item.rowNum, 7).setValue(dt.date);

    if (branchCol === 3) item.branch1 = newQty;
    else item.branch2 = newQty;

    logRows.push([
      batchId + '#' + i,
      dt.date,
      dt.time,
      branch,
      payload.user || branch,
      item.brand,
      item.model,
      qty,
      payload.note || '',
    ]);
  }

  if (logRows.length > 0) {
    const startRow = stockInSheet.getLastRow() + 1;
    stockInSheet.getRange(startRow, 1, logRows.length, 9).setValues(logRows);
  }

  return { ok: true, addedCount: logRows.length, batchId: batchId };
}

function handleTransfer_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ensureSheet_(ss, CONFIG.SHEETS.STOCK);
  const transferSheet = ensureSheet_(ss, CONFIG.SHEETS.TRANSFERS);

  const entryId = payload.clientTxId || Utilities.getUuid();
  if (hasDuplicateEntryId_(transferSheet, entryId)) {
    return { ok: true, deduplicated: true, entryId: entryId };
  }

  const fromBranch = payload.fromBranch;
  const toBranch = payload.toBranch;
  if (fromBranch === toBranch) throw new Error('From and To branch cannot be the same.');

  const fromCol = branchColIndex_(fromBranch);
  const toCol = branchColIndex_(toBranch);
  const qty = Number(payload.qty);
  if (!qty || qty <= 0) throw new Error('Transfer qty must be greater than 0.');

  const key = String(payload.brand || '').trim().toLowerCase() + '::' + String(payload.model || '').trim().toLowerCase();
  const index = loadStockIndex_(stockSheet);
  const item = index.get(key);
  if (!item) throw new Error('Model not found: ' + payload.brand + ' ' + payload.model);

  const fromQty = fromCol === 3 ? item.branch1 : item.branch2;
  const toQty = toCol === 3 ? item.branch1 : item.branch2;
  if (fromQty < qty) {
    throw new Error('Insufficient stock in ' + fromBranch + ' (Available: ' + fromQty + ')');
  }

  const dt = getDateTimeParts_(payload.timestamp);
  stockSheet.getRange(item.rowNum, fromCol).setValue(fromQty - qty);
  stockSheet.getRange(item.rowNum, toCol).setValue(toQty + qty);
  stockSheet.getRange(item.rowNum, 7).setValue(dt.date);

  transferSheet.appendRow([
    entryId,
    dt.date,
    dt.time,
    fromBranch,
    toBranch,
    item.brand,
    item.model,
    qty,
    payload.user || toBranch,
    payload.note || '',
  ]);

  return {
    ok: true,
    entryId: entryId,
    fromNewQty: fromQty - qty,
    toNewQty: toQty + qty,
  };
}

function handleAddModel_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ensureSheet_(ss, CONFIG.SHEETS.STOCK);
  const brand = String(payload.brand || '').trim();
  const model = String(payload.model || '').trim();
  if (!brand || !model) throw new Error('Brand and Model are required.');

  const index = loadStockIndex_(stockSheet);
  const key = brand.toLowerCase() + '::' + model.toLowerCase();
  if (index.has(key)) throw new Error('Model already exists: ' + brand + ' ' + model);

  const b1 = Math.max(0, Number(payload.branch1) || 0);
  const b2 = Math.max(0, Number(payload.branch2) || 0);
  const minAlert = Math.max(0, Number(payload.minAlert) || CONFIG.DEFAULT_MIN_ALERT);
  const dt = getDateTimeParts_(payload.timestamp);

  const newRow = stockSheet.getLastRow() + 1;
  stockSheet.getRange(newRow, 1, 1, 7).setValues([[
    brand,
    model,
    b1,
    b2,
    '=C' + newRow + '+D' + newRow,
    minAlert,
    dt.date,
  ]]);

  return { ok: true, brand: brand, model: model, rowNum: newRow };
}

function handleSeedInventory_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupWorkbook();
  const stockSheet = ss.getSheetByName(CONFIG.SHEETS.STOCK);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new Error('No seed items provided.');

  if (stockSheet.getLastRow() > 1 && !payload.overwrite) {
    return {
      ok: false,
      error: 'Current_Stock already has data. Sync instead or enable overwrite.',
    };
  }

  if (payload.overwrite && stockSheet.getLastRow() > 1) {
    stockSheet.getRange(2, 1, stockSheet.getLastRow() - 1, 7).clearContent();
  }

  const dt = getDateTimeParts_();
  const rows = items.map(function (item, idx) {
    const r = idx + 2;
    return [
      String(item.brand || '').trim(),
      String(item.model || '').trim(),
      Math.max(0, Number(item.branch1) || 0),
      Math.max(0, Number(item.branch2) || 0),
      '=C' + r + '+D' + r,
      Math.max(0, Number(item.minAlert) || CONFIG.DEFAULT_MIN_ALERT),
      dt.date,
    ];
  });

  stockSheet.getRange(2, 1, rows.length, 7).setValues(rows);
  refreshPrintView();
  return { ok: true, seeded: rows.length };
}

function getFullSyncData_(limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ss.getSheetByName(CONFIG.SHEETS.STOCK);
  const salesSheet = ss.getSheetByName(CONFIG.SHEETS.SALES);
  const stockInSheet = ss.getSheetByName(CONFIG.SHEETS.STOCK_IN);
  const transferSheet = ss.getSheetByName(CONFIG.SHEETS.TRANSFERS);

  const stock = [];
  if (stockSheet && stockSheet.getLastRow() > 1) {
    const vals = stockSheet.getRange(2, 1, stockSheet.getLastRow() - 1, 7).getValues();
    for (let i = 0; i < vals.length; i++) {
      const brand = String(vals[i][0] || '').trim();
      const model = String(vals[i][1] || '').trim();
      if (!brand || !model) continue;
      stock.push({
        id: (brand + '-' + model).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        brand: brand,
        model: model,
        branch1: Number(vals[i][2]) || 0,
        branch2: Number(vals[i][3]) || 0,
        minAlert: Number(vals[i][5]) || CONFIG.DEFAULT_MIN_ALERT,
        lastUpdated: formatCellDate_(vals[i][6]),
      });
    }
  }

  return {
    ok: true,
    serverTime: new Date().toISOString(),
    stock: stock,
    sales: readTailRows_(salesSheet, 10, limit, function (r) {
      return {
        id: String(r[0]),
        date: formatCellDate_(r[1]),
        time: formatCellTime_(r[2]),
        branch: String(r[3]),
        user: String(r[4]),
        brand: String(r[5]),
        model: String(r[6]),
        qty: Number(r[7]) || 0,
        note: String(r[8] || ''),
        status: String(r[9] || 'SOLD'),
      };
    }),
    stockIn: readTailRows_(stockInSheet, 9, limit, function (r) {
      return {
        id: String(r[0]),
        date: formatCellDate_(r[1]),
        time: formatCellTime_(r[2]),
        branch: String(r[3]),
        user: String(r[4]),
        brand: String(r[5]),
        model: String(r[6]),
        qty: Number(r[7]) || 0,
        note: String(r[8] || ''),
      };
    }),
    transfers: readTailRows_(transferSheet, 10, limit, function (r) {
      return {
        id: String(r[0]),
        date: formatCellDate_(r[1]),
        time: formatCellTime_(r[2]),
        fromBranch: String(r[3]),
        toBranch: String(r[4]),
        brand: String(r[5]),
        model: String(r[6]),
        qty: Number(r[7]) || 0,
        user: String(r[8] || ''),
        note: String(r[9] || ''),
      };
    }),
  };
}

function getDateReport_(dateStr) {
  const full = getFullSyncData_(2000);
  return {
    ok: true,
    date: dateStr,
    sales: full.sales.filter(function (s) { return s.date === dateStr; }),
    stockIn: full.stockIn.filter(function (s) { return s.date === dateStr; }),
    transfers: full.transfers.filter(function (s) { return s.date === dateStr; }),
  };
}

function readTailRows_(sheet, colCount, limit, mapper) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastRow = sheet.getLastRow();
  const count = Math.min(lastRow - 1, limit || 250);
  const startRow = lastRow - count + 1;
  const vals = sheet.getRange(startRow, 1, count, colCount).getValues();
  const list = [];
  for (let i = vals.length - 1; i >= 0; i--) {
    list.push(mapper(vals[i]));
  }
  return list;
}

function formatCellDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Karachi';
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  return String(val).slice(0, 10);
}

function formatCellTime_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Karachi';
    return Utilities.formatDate(val, tz, 'HH:mm:ss');
  }
  return String(val);
}

/**
 * Rebuilds a clean side-by-side Printable Sheet matching the shop's paper layout.
 */
function refreshPrintView() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stockSheet = ss.getSheetByName(CONFIG.SHEETS.STOCK);
  const printSheet = ensureSheet_(ss, CONFIG.SHEETS.PRINT);
  printSheet.clear();

  if (!stockSheet || stockSheet.getLastRow() < 2) {
    printSheet.getRange(1, 1).setValue('No stock rows yet.');
    return { ok: true, message: 'Print view cleared (empty stock).' };
  }

  const values = stockSheet.getRange(2, 1, stockSheet.getLastRow() - 1, 4).getValues();
  const grouped = {};
  const brandOrder = [];
  for (let i = 0; i < values.length; i++) {
    const b = String(values[i][0] || '').trim();
    const m = String(values[i][1] || '').trim();
    if (!b || !m) continue;
    if (!grouped[b]) {
      grouped[b] = [];
      brandOrder.push(b);
    }
    grouped[b].push([m, Number(values[i][2]) || 0, Number(values[i][3]) || 0]);
  }

  const dt = getDateTimeParts_();
  printSheet.getRange(1, 1).setValue('SM TPU Cover Stock Sheet — Printed: ' + dt.date + ' ' + dt.time).setFontWeight('bold').setFontSize(12);

  // Place 4 brands across per row block (4 cols each: Model | B1 | B2 | Tot)
  const COLS_PER_BRAND = 4;
  let blockStartRow = 3;

  for (let idx = 0; idx < brandOrder.length; idx += 4) {
    const slice = brandOrder.slice(idx, idx + 4);
    let maxRows = 0;

    for (let s = 0; s < slice.length; s++) {
      const brand = slice[s];
      const list = grouped[brand];
      const startCol = s * COLS_PER_BRAND + 1;

      const headerRange = printSheet.getRange(blockStartRow, startCol, 1, COLS_PER_BRAND);
      headerRange.setValues([[brand, 'B1', 'B2', 'Tot']]);
      headerRange.setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');

      const rows = list.map(function (entry) {
        return [entry[0], entry[1], entry[2], entry[1] + entry[2]];
      });
      if (rows.length > 0) {
        printSheet.getRange(blockStartRow + 1, startCol, rows.length, COLS_PER_BRAND).setValues(rows);
        printSheet.getRange(blockStartRow, startCol, rows.length + 1, COLS_PER_BRAND).setBorder(true, true, true, true, true, true);
      }
      if (rows.length > maxRows) maxRows = rows.length;
    }

    blockStartRow += maxRows + 3;
  }

  return { ok: true, message: 'Print view refreshed.' };
}
