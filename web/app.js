(() => {
  'use strict';

  const STORAGE_KEY = 'sm_tpu_inventory_state_v1';
  const PRESYNC_BACKUP_KEY = 'sm_tpu_presync_backup_v1';
  const BRANCH_1 = 'SM Branch 1';
  const BRANCH_2 = 'SM Branch 2';

  const els = {};

  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function nowTimeStr() {
    return new Date().toTimeString().slice(0, 8);
  }

  function makeTxId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function normalizeSearch(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\bredme\b/g, 'redmi')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function buildInitialState() {
    const stock = (window.SM_INITIAL_STOCK || []).map((item) => ({ ...item }));
    return {
      profileSelected: false,
      activeBranch: BRANCH_1,
      userName: 'Owner',
      lockOtherBranch: true,
      apiUrl: '',
      lastSyncedAt: null,
      stock,
      sales: [],
      stockIn: [],
      transfers: [],
      adjustments: [],
      pendingQueue: [],
    };
  }

  let state = loadState();
  let ui = {
    activeTab: 'stock',
    search: '',
    brand: 'ALL',
    statusFilter: 'all',
    auditMode: false,
    stockInSearch: '',
    cart: {}, // key -> { id, brand, model, qty }
    reportDate: todayStr(),
    reportBranch: 'ALL',
    reportTab: 'sales',
    modalItemId: null,
    modalMode: 'sell',
    lastUndoTx: null,
    toastTimer: null,
  };

  function repairCorruptedModels(stockList) {
    if (!Array.isArray(stockList)) return stockList;
    return stockList.map((item) => {
      if (item && item.brand === 'iPhone' && String(item.model || '').includes('1899')) {
        return { ...item, id: 'iphone-12pm', model: '12PM' };
      }
      return item;
    });
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return buildInitialState();
      const parsed = JSON.parse(raw);
      const merged = {
        ...buildInitialState(),
        ...parsed,
      };
      merged.stock = repairCorruptedModels(merged.stock);
      return merged;
    } catch {
      return buildInitialState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    updateHeader();
  }

  function otherBranch(branch = state.activeBranch) {
    return branch === BRANCH_1 ? BRANCH_2 : BRANCH_1;
  }

  function getQty(item, branch) {
    return branch === BRANCH_1 ? Number(item.branch1) || 0 : Number(item.branch2) || 0;
  }

  function setQty(item, branch, qty) {
    if (branch === BRANCH_1) item.branch1 = Math.max(0, qty);
    else item.branch2 = Math.max(0, qty);
    item.lastUpdated = todayStr();
  }

  function getAllBrands() {
    const base = window.SM_INITIAL_CONFIG ? [...window.SM_INITIAL_CONFIG.brands] : [];
    const seen = new Set(base);
    for (const item of state.stock) {
      if (!seen.has(item.brand)) {
        seen.add(item.brand);
        base.push(item.brand);
      }
    }
    return base;
  }

  function showToast(msg, undoAction = null) {
    clearTimeout(ui.toastTimer);
    els.toastMsg.textContent = msg;
    if (undoAction) {
      ui.lastUndoTx = undoAction;
      els.toastUndoBtn.classList.remove('hidden');
    } else {
      ui.lastUndoTx = null;
      els.toastUndoBtn.classList.add('hidden');
    }
    els.toast.classList.remove('hidden');
    ui.toastTimer = setTimeout(() => {
      els.toast.classList.add('hidden');
    }, undoAction ? 5500 : 3000);
  }

  // ---- Google Apps Script Sync ----
  async function sendToSheet(payload) {
    if (!state.apiUrl) return { ok: false, offline: true };
    try {
      const res = await fetch(state.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return data;
    } catch (err) {
      return { ok: false, error: err.message || 'Network error' };
    }
  }

  async function queueOrSync(payload) {
    if (!state.apiUrl) {
      saveState();
      return;
    }
    state.pendingQueue.push(payload);
    saveState();
    await flushQueue();
  }

  async function flushQueue() {
    if (!state.apiUrl || state.pendingQueue.length === 0) {
      updateHeader();
      return { ok: true, remainingCount: 0, lastError: '' };
    }
    const remaining = [];
    let networkStopped = false;
    let lastError = '';
    for (const tx of state.pendingQueue) {
      if (networkStopped) {
        remaining.push(tx);
        continue;
      }
      const resp = await sendToSheet(tx);
      if (resp && resp.ok) {
        continue;
      }
      const errMsg = (resp && resp.error) || 'Upload failed';
      lastError = errMsg;
      // Stop early only on network/offline errors; for validation errors keep checking next items
      if (!resp || resp.offline || errMsg === 'Network error') {
        networkStopped = true;
        remaining.push(tx);
      } else {
        remaining.push({ ...tx, syncError: errMsg });
      }
    }
    state.pendingQueue = remaining;
    if (remaining.length === 0) {
      state.lastSyncedAt = new Date().toISOString();
    }
    saveState();
    return { ok: remaining.length === 0, remainingCount: remaining.length, lastError };
  }

  async function syncFromSheet() {
    if (!state.apiUrl) {
      showToast('Pehle Settings mein Google Apps Script URL lagayein.');
      return;
    }
    const qRes = await flushQueue();
    if (qRes.remainingCount > 0) {
      showToast(`Sync ruk gaya: ${qRes.remainingCount} local changes upload nahi ho sakin (${qRes.lastError}). Local stock mehfooz hai!`);
      return;
    }
    try {
      const sep = state.apiUrl.includes('?') ? '&' : '?';
      const res = await fetch(`${state.apiUrl}${sep}action=sync`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Sync failed');
      // Save a local pre-sync snapshot before overwriting local state
      try {
        localStorage.setItem(PRESYNC_BACKUP_KEY, JSON.stringify(state));
      } catch (_) {}
      if (Array.isArray(data.stock) && data.stock.length > 0) {
        state.stock = repairCorruptedModels(data.stock);
      }
      if (Array.isArray(data.sales)) state.sales = data.sales;
      if (Array.isArray(data.stockIn)) state.stockIn = data.stockIn;
      if (Array.isArray(data.transfers)) state.transfers = data.transfers;
      state.lastSyncedAt = new Date().toISOString();
      saveState();
      renderAll();
      showToast(`Google Sheet synced (${state.stock.length} models).`);
    } catch (err) {
      showToast('Sync error: ' + err.message);
    }
  }

  // ---- Core Business Actions ----
  function sellItem(itemId, qty, branch = state.activeBranch, note = '') {
    const item = state.stock.find((x) => x.id === itemId);
    if (!item) return false;
    if (state.lockOtherBranch && branch !== state.activeBranch) {
      showToast(`${branch} lock hai — apni branch se sell karein.`);
      return false;
    }
    const current = getQty(item, branch);
    if (qty <= 0 || current < qty) {
      showToast(`${branch} mein sirf ${current} pcs available hain.`);
      return false;
    }

    setQty(item, branch, current - qty);
    const txId = makeTxId('SL');
    const saleEntry = {
      id: txId,
      date: todayStr(),
      time: nowTimeStr(),
      branch,
      user: state.userName,
      brand: item.brand,
      model: item.model,
      qty,
      note,
      status: 'SOLD',
    };
    state.sales.unshift(saleEntry);
    saveState();
    renderAll();

    queueOrSync({
      action: 'sell',
      clientTxId: txId,
      branch,
      user: state.userName,
      brand: item.brand,
      model: item.model,
      qty,
      note,
      timestamp: new Date().toISOString(),
    });

    showToast(`Sold ${qty}x ${item.brand} ${item.model} (${branch})`, {
      type: 'return_sale',
      itemId: item.id,
      branch,
      qty,
    });
    return true;
  }

  function returnSale(itemId, qty, branch) {
    const item = state.stock.find((x) => x.id === itemId);
    if (!item) return;
    setQty(item, branch, getQty(item, branch) + qty);
    const txId = makeTxId('RT');
    state.sales.unshift({
      id: txId,
      date: todayStr(),
      time: nowTimeStr(),
      branch,
      user: state.userName,
      brand: item.brand,
      model: item.model,
      qty: -qty,
      note: 'Undo / Return',
      status: 'RETURNED',
    });
    saveState();
    renderAll();

    queueOrSync({
      action: 'return_sale',
      clientTxId: txId,
      branch,
      user: state.userName,
      brand: item.brand,
      model: item.model,
      qty,
      note: 'Undo / Return',
      timestamp: new Date().toISOString(),
    });

    showToast(`Returned ${qty}x ${item.brand} ${item.model}`);
  }

  function transferItem(itemId, fromBranch, toBranch, qty, note = '') {
    const item = state.stock.find((x) => x.id === itemId);
    if (!item) return false;
    const fromQty = getQty(item, fromBranch);
    if (qty <= 0 || fromQty < qty) {
      showToast(`${fromBranch} mein sirf ${fromQty} pcs available hain.`);
      return false;
    }

    setQty(item, fromBranch, fromQty - qty);
    setQty(item, toBranch, getQty(item, toBranch) + qty);
    const txId = makeTxId('TR');
    state.transfers.unshift({
      id: txId,
      date: todayStr(),
      time: nowTimeStr(),
      fromBranch,
      toBranch,
      brand: item.brand,
      model: item.model,
      qty,
      user: state.userName,
      note,
    });
    saveState();
    renderAll();

    queueOrSync({
      action: 'transfer',
      clientTxId: txId,
      fromBranch,
      toBranch,
      brand: item.brand,
      model: item.model,
      qty,
      user: state.userName,
      note,
      timestamp: new Date().toISOString(),
    });

    showToast(`Transferred ${qty}x ${item.brand} ${item.model} (${fromBranch} → ${toBranch})`);
    return true;
  }

  function adjustStock(itemId, newQty, branch = state.activeBranch, reason = 'Physical count / Audit') {
    const item = state.stock.find((x) => x.id === itemId);
    if (!item) return false;
    if (state.lockOtherBranch && branch !== state.activeBranch) {
      showToast(`${branch} lock hai — apni branch ki ginti update karein.`);
      return false;
    }
    const cleanQty = Math.max(0, Number(newQty) || 0);
    const oldQty = getQty(item, branch);
    if (cleanQty === oldQty) {
      showToast(`${item.brand} ${item.model} pehle se ${cleanQty} pcs hai.`);
      return true;
    }

    setQty(item, branch, cleanQty);
    const txId = makeTxId('AD');
    if (!Array.isArray(state.adjustments)) state.adjustments = [];
    state.adjustments.unshift({
      id: txId,
      date: todayStr(),
      time: nowTimeStr(),
      branch,
      user: state.userName,
      brand: item.brand,
      model: item.model,
      oldQty,
      newQty: cleanQty,
      diff: cleanQty - oldQty,
      reason,
    });
    saveState();
    renderAll();

    queueOrSync({
      action: 'adjust_stock',
      clientTxId: txId,
      branch,
      user: state.userName,
      brand: item.brand,
      model: item.model,
      newQty: cleanQty,
      reason,
      timestamp: new Date().toISOString(),
    });

    showToast(`Fixed ${item.brand} ${item.model}: ${oldQty} → ${cleanQty} pcs (${branch})`);
    return true;
  }

  function submitStockInBatch() {
    const entries = Object.values(ui.cart).filter((x) => Number(x.qty) > 0);
    if (entries.length === 0) {
      showToast('Batch cart khali hai.');
      return;
    }
    const branch = els.stockInBranchSelect.value;
    const note = els.stockInNoteInput.value.trim();
    const batchId = makeTxId('IN');
    const dt = todayStr();
    const tm = nowTimeStr();

    entries.forEach((entry, idx) => {
      const item = state.stock.find((x) => x.id === entry.id);
      if (!item) return;
      const q = Number(entry.qty);
      setQty(item, branch, getQty(item, branch) + q);
      state.stockIn.unshift({
        id: `${batchId}#${idx}`,
        date: dt,
        time: tm,
        branch,
        user: state.userName,
        brand: item.brand,
        model: item.model,
        qty: q,
        note,
      });
    });

    ui.cart = {};
    els.stockInNoteInput.value = '';
    saveState();
    renderAll();

    queueOrSync({
      action: 'stock_in',
      clientTxId: batchId,
      branch,
      user: state.userName,
      note,
      items: entries.map((e) => ({ brand: e.brand, model: e.model, qty: Number(e.qty) })),
      timestamp: new Date().toISOString(),
    });

    const totalPcs = entries.reduce((s, e) => s + Number(e.qty), 0);
    showToast(`${totalPcs} pcs (${entries.length} models) ${branch} mein add ho gaye!`);
  }

  function addNewModel() {
    const brand = els.newModelBrandInput.value.trim();
    const model = els.newModelNameInput.value.trim();
    const b1 = Math.max(0, Number(els.newModelB1Input.value) || 0);
    const b2 = Math.max(0, Number(els.newModelB2Input.value) || 0);

    if (!brand || !model) {
      showToast('Company aur Model dono likhein.');
      return;
    }
    const dup = state.stock.find(
      (x) => x.brand.toLowerCase() === brand.toLowerCase() && x.model.toLowerCase() === model.toLowerCase()
    );
    if (dup) {
      showToast(`${brand} ${model} pehle se maujood hai.`);
      return;
    }

    const id = `${brand}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    state.stock.unshift({
      id,
      brand,
      model,
      branch1: b1,
      branch2: b2,
      minAlert: 2,
      lastUpdated: todayStr(),
    });
    saveState();
    renderAll();

    queueOrSync({
      action: 'add_model',
      brand,
      model,
      branch1: b1,
      branch2: b2,
      minAlert: 2,
      timestamp: new Date().toISOString(),
    });

    els.addModelModal.classList.add('hidden');
    els.newModelBrandInput.value = '';
    els.newModelNameInput.value = '';
    els.newModelB1Input.value = '0';
    els.newModelB2Input.value = '0';
    showToast(`Added ${brand} ${model}`);
  }

  // ---- Rendering ----
  function updateHeader() {
    els.activeBranchLabel.textContent = state.activeBranch;
    els.activeUserLabel.textContent = state.userName || 'User';
    els.branchSwitchBtn.classList.toggle('b2', state.activeBranch === BRANCH_2);

    if (!state.apiUrl) {
      els.syncBadge.textContent = 'Local Mode';
      els.syncBadge.className = 'sync-badge local';
    } else if (state.pendingQueue.length > 0) {
      els.syncBadge.textContent = `Pending (${state.pendingQueue.length})`;
      els.syncBadge.className = 'sync-badge pending';
    } else {
      els.syncBadge.textContent = 'Sheet Synced';
      els.syncBadge.className = 'sync-badge synced';
    }
  }

  function renderBrandPills() {
    const brands = ['ALL', ...getAllBrands()];
    els.brandPills.innerHTML = brands
      .map((b) => `<button class="brand-pill ${ui.brand === b ? 'active' : ''}" data-brand="${escapeHtml(b)}" type="button">${b === 'ALL' ? 'All Brands' : escapeHtml(b)}</button>`)
      .join('');
  }

  function getFilteredStock() {
    const q = normalizeSearch(ui.search);
    const terms = q ? q.split(' ') : [];
    const myBranch = state.activeBranch;
    const other = otherBranch(myBranch);

    return state.stock.filter((item) => {
      if (ui.brand !== 'ALL' && item.brand !== ui.brand) return false;

      const myQty = getQty(item, myBranch);
      const otherQty = getQty(item, other);
      if (ui.statusFilter === 'instock' && myQty <= 0) return false;
      if (ui.statusFilter === 'low' && (myQty < 1 || myQty > (item.minAlert || 2))) return false;
      if (ui.statusFilter === 'zero' && myQty !== 0) return false;
      if (ui.statusFilter === 'other' && !(myQty === 0 && otherQty > 0)) return false;

      if (terms.length > 0) {
        const hay = normalizeSearch(`${item.brand} ${item.model}`);
        return terms.every((t) => hay.includes(t));
      }
      return true;
    });
  }

  function renderStockList() {
    const list = getFilteredStock();
    const myBranch = state.activeBranch;
    const other = otherBranch(myBranch);
    const myShort = myBranch === BRANCH_1 ? 'B1' : 'B2';
    const otherShort = other === BRANCH_1 ? 'B1' : 'B2';

    const myTotal = state.stock.reduce((s, x) => s + getQty(x, myBranch), 0);
    const otherTotal = state.stock.reduce((s, x) => s + getQty(x, other), 0);
    els.stockMiniStats.innerHTML = `
      <span>Showing ${list.length} models</span>
      <span>${myBranch}: ${myTotal} pcs | ${otherShort}: ${otherTotal} pcs</span>
    `;

    if (list.length === 0) {
      els.stockList.innerHTML = `<div class="panel-card"><p class="muted">Koi model nahi mila. Search clear karein ya Naya Maal tab se add karein.</p></div>`;
      return;
    }

    const html = list
      .slice(0, 150)
      .map((item) => {
        const myQty = getQty(item, myBranch);
        const otherQty = getQty(item, other);
        const qtyClass = myQty === 0 ? 'zero' : myQty <= (item.minAlert || 2) ? 'low' : 'ok';

        const pullBtn =
          myQty === 0 && otherQty > 0
            ? `<button class="quick-pull-btn" data-action="pull" data-id="${escapeHtml(item.id)}" type="button">Mangwao</button>`
            : '';

        const actionsHtml = ui.auditMode
          ? `
            <div class="audit-controls">
              <button class="audit-step-btn" data-audit-step="-1" data-id="${escapeHtml(item.id)}" type="button">-</button>
              <input class="audit-input" data-audit-input="${escapeHtml(item.id)}" type="number" min="0" value="${myQty}" />
              <button class="audit-step-btn" data-audit-step="1" data-id="${escapeHtml(item.id)}" type="button">+</button>
              <button class="audit-zero-btn" data-audit-zero="${escapeHtml(item.id)}" type="button">0</button>
              <button class="audit-save-btn" data-audit-save="${escapeHtml(item.id)}" type="button">Save</button>
            </div>
          `
          : `
            <div class="card-actions">
              ${pullBtn}
              <button class="quick-sell-btn" data-action="sell1" data-id="${escapeHtml(item.id)}" type="button" ${myQty <= 0 ? 'disabled' : ''}>-1 Sell</button>
              <button class="more-btn" data-action="open" data-id="${escapeHtml(item.id)}" type="button">...</button>
            </div>
          `;

        return `
          <div class="stock-card ${ui.auditMode ? 'audit-card' : ''}">
            <div class="stock-info">
              <span class="brand-tag">${escapeHtml(item.brand)}</span>
              <div class="model-name">${escapeHtml(item.model)}</div>
              <div class="branch-compare">
                <span class="qty-pill ${qtyClass}">${myShort}: ${myQty} pcs</span>
                <span class="other-pill ${otherQty > 0 ? 'has-stock' : ''}">${otherShort}: ${otherQty}</span>
              </div>
            </div>
            ${actionsHtml}
          </div>
        `;
      })
      .join('');

    const overflowNote =
      list.length > 150
        ? `<div class="panel-card"><p class="muted">${list.length - 150} mazeed models hain — search ya brand filter use karein.</p></div>`
        : '';
    els.stockList.innerHTML = html + overflowNote;
  }

  function renderStockInTab() {
    const entries = Object.values(ui.cart);
    const totalPcs = entries.reduce((s, e) => s + (Number(e.qty) || 0), 0);
    els.cartItemCount.textContent = entries.length;
    els.cartTotalPcs.textContent = totalPcs;
    els.stockInCartCard.classList.toggle('hidden', entries.length === 0);

    els.stockInCartList.innerHTML = entries
      .map(
        (e) => `
      <div class="cart-row">
        <div>
          <span class="brand-tag">${escapeHtml(e.brand)}</span>
          <strong> ${escapeHtml(e.model)}</strong>
        </div>
        <div class="card-actions">
          <input class="cart-qty-input" data-cart-id="${escapeHtml(e.id)}" type="number" min="1" value="${e.qty}" />
          <button class="btn btn-text btn-sm" data-remove-cart="${escapeHtml(e.id)}" type="button">&times;</button>
        </div>
      </div>
    `
      )
      .join('');

    const q = normalizeSearch(ui.stockInSearch);
    const terms = q ? q.split(' ') : [];
    const targetBranch = els.stockInBranchSelect.value;
    const matches = state.stock
      .filter((item) => {
        if (terms.length === 0) return true;
        const hay = normalizeSearch(`${item.brand} ${item.model}`);
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 60);

    els.stockInPickerList.innerHTML = matches
      .map((item) => {
        const cur = getQty(item, targetBranch);
        const inCart = ui.cart[item.id];
        const inCartBadge = inCart
          ? `<span class="qty-pill ok">Cart: +${inCart.qty}</span>`
          : '';
        return `
        <div class="stock-card stockin-card">
          <div class="stock-info">
            <span class="brand-tag">${escapeHtml(item.brand)}</span>
            <div class="model-name">${escapeHtml(item.model)}</div>
            <div class="branch-compare">
              <span class="other-pill">${targetBranch}: ${cur} pcs</span>
              ${inCartBadge}
            </div>
          </div>
          <div class="stockin-actions">
            <button class="btn btn-outline btn-sm" data-add-cart="${escapeHtml(item.id)}" data-qty="1" type="button">+1</button>
            <button class="btn btn-outline btn-sm" data-add-cart="${escapeHtml(item.id)}" data-qty="5" type="button">+5</button>
            <input class="custom-qty-input" data-custom-qty="${escapeHtml(item.id)}" type="number" min="1" placeholder="Qty" />
            <button class="btn btn-primary btn-sm" data-add-custom="${escapeHtml(item.id)}" type="button">Add</button>
          </div>
        </div>
      `;
      })
      .join('');
  }

  function renderTransferTab() {
    const myBranch = state.activeBranch;
    const other = otherBranch(myBranch);
    const needed = state.stock.filter((item) => getQty(item, myBranch) === 0 && getQty(item, other) > 0);
    els.availableOtherCount.textContent = needed.length;

    if (needed.length === 0) {
      els.crossBranchNeededList.innerHTML = `<p class="muted">Abhi aisa koi model nahi jo ${myBranch} mein zero ho aur ${other} mein available ho.</p>`;
    } else {
      els.crossBranchNeededList.innerHTML = needed
        .slice(0, 40)
        .map(
          (item) => `
        <div class="stock-card">
          <div class="stock-info">
            <span class="brand-tag">${escapeHtml(item.brand)}</span>
            <div class="model-name">${escapeHtml(item.model)}</div>
            <div class="branch-compare">
              <span class="qty-pill zero">${myBranch}: 0</span>
              <span class="other-pill has-stock">${other}: ${getQty(item, other)} pcs</span>
            </div>
          </div>
          <div class="card-actions">
            <button class="quick-pull-btn" data-pull-one="${escapeHtml(item.id)}" type="button">+1 Mangwao</button>
            <button class="more-btn" data-action="open-transfer" data-id="${escapeHtml(item.id)}" type="button">Custom</button>
          </div>
        </div>
      `
        )
        .join('');
    }

    if (state.transfers.length === 0) {
      els.transferHistoryList.innerHTML = `<p class="muted">Abhi koi transfer nahi hua.</p>`;
    } else {
      els.transferHistoryList.innerHTML = state.transfers
        .slice(0, 30)
        .map(
          (t) => `
        <div class="log-item">
          <div>
            <strong>${escapeHtml(t.brand)} ${escapeHtml(t.model)}</strong>
            <div class="muted">${escapeHtml(t.fromBranch)} &rarr; ${escapeHtml(t.toBranch)} &bull; ${t.date} ${t.time}</div>
          </div>
          <span class="count-pill">${t.qty} pcs</span>
        </div>
      `
        )
        .join('');
    }
  }

  function renderReportsTab() {
    const date = ui.reportDate;
    const br = ui.reportBranch;
    const matchBranch = (b) => br === 'ALL' || b === br;

    const sales = state.sales.filter((s) => s.date === date && matchBranch(s.branch));
    const stockIn = state.stockIn.filter((s) => s.date === date && matchBranch(s.branch));
    const transfers = state.transfers.filter(
      (t) => t.date === date && (br === 'ALL' || t.fromBranch === br || t.toBranch === br)
    );

    const soldPcs = sales.reduce((sum, s) => sum + (Number(s.qty) || 0), 0);
    const addedPcs = stockIn.reduce((sum, s) => sum + (Number(s.qty) || 0), 0);
    const trPcs = transfers.reduce((sum, t) => sum + (Number(t.qty) || 0), 0);

    els.reportSummaryCards.innerHTML = `
      <div class="kpi-box"><small>Sold (${date})</small><strong>${soldPcs}</strong></div>
      <div class="kpi-box"><small>Stock Added</small><strong>${addedPcs}</strong></div>
      <div class="kpi-box"><small>Transferred</small><strong>${trPcs}</strong></div>
    `;

    if (ui.reportTab === 'sales') {
      els.reportTabContent.innerHTML = sales.length
        ? `<div class="log-list">${sales
            .map(
              (s) => `
            <div class="log-item">
              <div>
                <strong>${escapeHtml(s.brand)} ${escapeHtml(s.model)}</strong>
                <div class="muted">${escapeHtml(s.branch)} &bull; ${escapeHtml(s.user)} &bull; ${s.time}</div>
              </div>
              <span class="qty-pill ${s.qty < 0 ? 'low' : 'ok'}">${s.qty > 0 ? '-' + s.qty : '+' + Math.abs(s.qty)}</span>
            </div>`
            )
            .join('')}</div>`
        : `<p class="muted">${date} ko koi sale record nahi hai.</p>`;
    } else if (ui.reportTab === 'stockin') {
      els.reportTabContent.innerHTML = stockIn.length
        ? `<div class="log-list">${stockIn
            .map(
              (s) => `
            <div class="log-item">
              <div>
                <strong>${escapeHtml(s.brand)} ${escapeHtml(s.model)}</strong>
                <div class="muted">${escapeHtml(s.branch)} &bull; ${escapeHtml(s.user)} ${s.note ? '&bull; ' + escapeHtml(s.note) : ''}</div>
              </div>
              <span class="qty-pill ok">+${s.qty}</span>
            </div>`
            )
            .join('')}</div>`
        : `<p class="muted">${date} ko koi naya maal add nahi hua.</p>`;
    } else if (ui.reportTab === 'transfers') {
      els.reportTabContent.innerHTML = transfers.length
        ? `<div class="log-list">${transfers
            .map(
              (t) => `
            <div class="log-item">
              <div>
                <strong>${escapeHtml(t.brand)} ${escapeHtml(t.model)}</strong>
                <div class="muted">${escapeHtml(t.fromBranch)} &rarr; ${escapeHtml(t.toBranch)} &bull; ${t.time}</div>
              </div>
              <span class="count-pill">${t.qty}</span>
            </div>`
            )
            .join('')}</div>`
        : `<p class="muted">${date} ko koi transfer nahi hua.</p>`;
    } else {
      const target = br === 'ALL' ? state.activeBranch : br;
      const lowItems = state.stock.filter((x) => getQty(x, target) <= (x.minAlert || 2));
      els.reportTabContent.innerHTML = lowItems.length
        ? `<p class="muted mb-8"><strong>${escapeHtml(target)}</strong> mein 0 ya low stock (${lowItems.length} models):</p>
           <div class="log-list mt-8">${lowItems
             .map(
               (x) => `
            <div class="log-item">
              <div><strong>${escapeHtml(x.brand)} ${escapeHtml(x.model)}</strong></div>
              <span class="qty-pill ${getQty(x, target) === 0 ? 'zero' : 'low'}">${getQty(x, target)} pcs</span>
            </div>`
             )
             .join('')}</div>`
        : `<p class="muted">${target} mein sab models full hain!</p>`;
    }
  }

  function buildPrintableHtml() {
    const grouped = new Map();
    for (const item of state.stock) {
      if (!grouped.has(item.brand)) grouped.set(item.brand, []);
      grouped.get(item.brand).push(item);
    }
    const blocks = Array.from(grouped.entries())
      .map(
        ([brand, items]) => `
      <div class="print-brand-box">
        <h4>${escapeHtml(brand)}</h4>
        <table>
          <thead><tr><th>Model</th><th class="num">B1</th><th class="num">B2</th><th class="num">Tot</th></tr></thead>
          <tbody>
            ${items
              .map(
                (i) => `<tr><td>${escapeHtml(i.model)}</td><td class="num">${i.branch1}</td><td class="num">${i.branch2}</td><td class="num">${i.branch1 + i.branch2}</td></tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
      )
      .join('');

    els.printableArea.innerHTML = `
      <h2 style="margin:0 0 8px;">SM TPU Cover Stock Sheet — ${todayStr()}</h2>
      <div class="print-grid">${blocks}</div>
    `;
  }

  function renderSettings() {
    els.settingsBranchSelect.value = state.activeBranch;
    els.settingsUserInput.value = state.userName;
    els.settingsLockOtherBranch.checked = !!state.lockOtherBranch;
    els.settingsApiUrlInput.value = state.apiUrl || '';

    const brands = getAllBrands();
    els.brandDataList.innerHTML = brands.map((b) => `<option value="${escapeHtml(b)}">`).join('');
  }

  function renderAll() {
    updateHeader();
    renderBrandPills();
    renderStockList();
    renderStockInTab();
    renderTransferTab();
    renderReportsTab();
    renderSettings();
  }

  // ---- Modals ----
  function openItemModal(itemId, defaultMode = 'sell') {
    const item = state.stock.find((x) => x.id === itemId);
    if (!item) return;
    ui.modalItemId = itemId;
    ui.modalMode = defaultMode;
    els.modalBrandBadge.textContent = item.brand;
    els.modalModelTitle.textContent = item.model;
    els.modalB1Qty.textContent = item.branch1;
    els.modalB2Qty.textContent = item.branch2;

    els.modalSellBranch.innerHTML = state.lockOtherBranch
      ? `<option value="${state.activeBranch}">${state.activeBranch}</option>`
      : `<option value="${BRANCH_1}">${BRANCH_1}</option><option value="${BRANCH_2}">${BRANCH_2}</option>`;
    els.modalSellBranch.value = state.activeBranch;
    els.modalAuditBranch.innerHTML = els.modalSellBranch.innerHTML;
    els.modalAuditBranch.value = state.activeBranch;
    els.auditQtyInput.value = String(getQty(item, state.activeBranch));
    els.auditReasonInput.value = '';
    els.sellQtyInput.value = '1';
    els.sellNoteInput.value = '';
    els.trQtyInput.value = '1';
    els.modalTransferDir.value = state.activeBranch === BRANCH_1 ? '2to1' : '1to2';

    setModalMode(defaultMode);
    els.itemActionModal.classList.remove('hidden');
  }

  function setModalMode(mode) {
    ui.modalMode = mode;
    document.querySelectorAll('[data-modal-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.modalMode === mode);
    });
    els.modalSellSection.classList.toggle('hidden', mode !== 'sell');
    els.modalTransferSection.classList.toggle('hidden', mode !== 'transfer');
    els.modalAuditSection.classList.toggle('hidden', mode !== 'audit');
  }

  function switchTab(tab) {
    ui.activeTab = tab;
    document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('active'));
    document.getElementById(`view-${tab}`).classList.add('active');
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.tab === tab);
    });
  }

  function formatPendingEntryText(tx, idx) {
    const dt = tx.timestamp ? tx.timestamp.slice(0, 16).replace('T', ' ') : '';
    if (tx.action === 'adjust_stock') {
      return `${idx + 1}. [Fix Qty] ${tx.brand} ${tx.model} -> ${tx.newQty} pcs (${tx.branch}) ${dt}`;
    }
    if (tx.action === 'stock_in') {
      const list = (tx.items || []).map((i) => `${i.brand} ${i.model} (+${i.qty})`).join(', ');
      return `${idx + 1}. [Naya Maal] ${tx.branch}: ${list} ${dt}`;
    }
    if (tx.action === 'sell') {
      return `${idx + 1}. [Sell] ${tx.brand} ${tx.model} -${tx.qty} (${tx.branch}) ${dt}`;
    }
    if (tx.action === 'return_sale') {
      return `${idx + 1}. [Return] ${tx.brand} ${tx.model} +${tx.qty} (${tx.branch}) ${dt}`;
    }
    if (tx.action === 'transfer') {
      return `${idx + 1}. [Transfer] ${tx.brand} ${tx.model} x${tx.qty} (${tx.fromBranch} -> ${tx.toBranch}) ${dt}`;
    }
    if (tx.action === 'add_model') {
      return `${idx + 1}. [New Model] ${tx.brand} ${tx.model} (B1:${tx.branch1 || 0}, B2:${tx.branch2 || 0}) ${dt}`;
    }
    return `${idx + 1}. [${tx.action}] ${tx.brand || ''} ${tx.model || ''} ${dt}`;
  }

  function openPendingModal() {
    const q = state.pendingQueue || [];
    els.pendingModalCount.textContent = q.length;
    els.pendingUploadError.classList.add('hidden');
    if (q.length === 0) {
      els.pendingQueueList.innerHTML = `<p class="muted">Koi pending entry nahi hai — sab synced hai.</p>`;
    } else {
      els.pendingQueueList.innerHTML = q
        .map((tx, idx) => {
          const line = formatPendingEntryText(tx, idx);
          const errHtml = tx.syncError
            ? `<div class="muted" style="color:var(--red);margin-top:2px;">Error: ${escapeHtml(tx.syncError)}</div>`
            : '';
          return `<div class="log-item"><div><div>${escapeHtml(line)}</div>${errHtml}</div><button class="btn btn-text btn-sm" data-drop-pending="${idx}" type="button" title="Remove">&times;</button></div>`;
        })
        .join('');
    }
    els.pendingModal.classList.remove('hidden');
  }

  function reapplyPendingToLocalStock() {
    const q = state.pendingQueue || [];
    if (q.length === 0) {
      showToast('Koi pending entry maujood nahi hai.');
      return;
    }
    let applied = 0;
    for (const tx of q) {
      if (tx.action === 'add_model') {
        const exists = state.stock.find(
          (x) => x.brand.toLowerCase() === String(tx.brand).toLowerCase() && x.model.toLowerCase() === String(tx.model).toLowerCase()
        );
        if (!exists) {
          state.stock.unshift({
            id: `${tx.brand}-${tx.model}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            brand: tx.brand,
            model: tx.model,
            branch1: Math.max(0, Number(tx.branch1) || 0),
            branch2: Math.max(0, Number(tx.branch2) || 0),
            minAlert: Number(tx.minAlert) || 2,
            lastUpdated: todayStr(),
          });
          applied++;
        }
        continue;
      }

      if (tx.action === 'stock_in' && Array.isArray(tx.items)) {
        for (const req of tx.items) {
          const item = state.stock.find(
            (x) => x.brand.toLowerCase() === String(req.brand).toLowerCase() && x.model.toLowerCase() === String(req.model).toLowerCase()
          );
          if (item) {
            setQty(item, tx.branch, getQty(item, tx.branch) + (Number(req.qty) || 0));
            applied++;
          }
        }
        continue;
      }

      const item = state.stock.find(
        (x) => x.brand.toLowerCase() === String(tx.brand || '').toLowerCase() && x.model.toLowerCase() === String(tx.model || '').toLowerCase()
      );
      if (!item) continue;

      if (tx.action === 'adjust_stock') {
        setQty(item, tx.branch, Math.max(0, Number(tx.newQty) || 0));
        applied++;
      } else if (tx.action === 'sell') {
        setQty(item, tx.branch, Math.max(0, getQty(item, tx.branch) - (Number(tx.qty) || 0)));
        applied++;
      } else if (tx.action === 'return_sale') {
        setQty(item, tx.branch, getQty(item, tx.branch) + (Number(tx.qty) || 0));
        applied++;
      } else if (tx.action === 'transfer') {
        const qty = Number(tx.qty) || 0;
        setQty(item, tx.fromBranch, Math.max(0, getQty(item, tx.fromBranch) - qty));
        setQty(item, tx.toBranch, getQty(item, tx.toBranch) + qty);
        applied++;
      }
    }
    saveState();
    renderAll();
    showToast(`${applied} pending changes app stock par wapas apply ho gayin!`);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- Init & Events ----
  function cacheDom() {
    [
      'branchSwitchBtn', 'activeBranchLabel', 'activeUserLabel', 'syncBadge', 'syncNowBtn',
      'stockSearchInput', 'clearSearchBtn', 'brandPills', 'stockStatusFilters', 'auditModeBtn', 'auditBanner', 'stockMiniStats', 'stockList',
      'openAddModelBtn', 'stockInBranchSelect', 'stockInNoteInput', 'stockInSearchInput',
      'stockInCartCard', 'cartItemCount', 'cartTotalPcs', 'clearCartBtn', 'stockInCartList', 'confirmStockInBtn', 'stockInPickerList',
      'availableOtherCount', 'crossBranchNeededList', 'transferHistoryList',
      'copyOrderListBtn', 'printSheetBtn', 'reportDateInput', 'reportBranchFilter', 'reportSummaryCards', 'reportTabContent', 'printableArea',
      'settingsBranchSelect', 'settingsUserInput', 'settingsLockOtherBranch', 'saveProfileBtn',
      'settingsApiUrlInput', 'saveApiUrlBtn', 'pushSeedBtn', 'pullSyncBtn', 'runBackupBtn', 'apiStatusMessage',
      'exportCsvBtn', 'exportJsonBtn', 'importJsonBtn', 'importJsonInput', 'openPendingBtn', 'restoreBackupBtn', 'resetDemoBtn',
      'pendingModal', 'pendingModalCount', 'closePendingModalBtn', 'reapplyPendingBtn', 'copyPendingBtn', 'flushPendingBtn', 'pendingUploadError', 'pendingQueueList',
      'branchModal', 'modalUserInput', 'closeBranchModalBtn',
      'itemActionModal', 'modalBrandBadge', 'modalModelTitle', 'modalB1Qty', 'modalB2Qty',
      'closeItemModalBtn', 'modalSellBranch', 'sellQtyMinus', 'sellQtyInput', 'sellQtyPlus', 'sellNoteInput', 'confirmSellBtn',
      'modalSellSection', 'modalTransferSection', 'modalTransferDir', 'trQtyMinus', 'trQtyInput', 'trQtyPlus', 'confirmTransferBtn',
      'modalAuditSection', 'modalAuditBranch', 'auditQtyMinus', 'auditQtyInput', 'auditQtyPlus', 'auditZeroBtn', 'auditReasonInput', 'confirmAuditBtn',
      'addModelModal', 'closeAddModelBtn', 'newModelBrandInput', 'brandDataList', 'newModelNameInput', 'newModelB1Input', 'newModelB2Input', 'confirmAddModelBtn',
      'toast', 'toastMsg', 'toastUndoBtn',
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Search & Filters
    els.stockSearchInput.addEventListener('input', (e) => {
      ui.search = e.target.value;
      els.clearSearchBtn.classList.toggle('hidden', !ui.search);
      renderStockList();
    });

    els.clearSearchBtn.addEventListener('click', () => {
      ui.search = '';
      els.stockSearchInput.value = '';
      els.clearSearchBtn.classList.add('hidden');
      renderStockList();
    });

    els.brandPills.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-brand]');
      if (!btn) return;
      ui.brand = btn.dataset.brand;
      renderBrandPills();
      renderStockList();
    });

    els.stockStatusFilters.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      ui.statusFilter = chip.dataset.filter;
      document.querySelectorAll('#stockStatusFilters [data-filter]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderStockList();
    });

    els.auditModeBtn.addEventListener('click', () => {
      ui.auditMode = !ui.auditMode;
      els.auditModeBtn.classList.toggle('active', ui.auditMode);
      els.auditBanner.classList.toggle('hidden', !ui.auditMode);
      renderStockList();
    });

    // Stock list actions
    els.stockList.addEventListener('click', (e) => {
      const stepBtn = e.target.closest('[data-audit-step]');
      if (stepBtn) {
        const id = stepBtn.dataset.id;
        const delta = Number(stepBtn.dataset.auditStep) || 0;
        const inp = els.stockList.querySelector(`[data-audit-input="${CSS.escape(id)}"]`);
        if (inp) inp.value = String(Math.max(0, (Number(inp.value) || 0) + delta));
        return;
      }

      const zeroBtn = e.target.closest('[data-audit-zero]');
      if (zeroBtn) {
        const id = zeroBtn.dataset.auditZero;
        const inp = els.stockList.querySelector(`[data-audit-input="${CSS.escape(id)}"]`);
        if (inp) inp.value = '0';
        adjustStock(id, 0, state.activeBranch, 'Shelf audit (set 0)');
        return;
      }

      const saveBtn = e.target.closest('[data-audit-save]');
      if (saveBtn) {
        const id = saveBtn.dataset.auditSave;
        const inp = els.stockList.querySelector(`[data-audit-input="${CSS.escape(id)}"]`);
        const val = Math.max(0, Number(inp ? inp.value : 0) || 0);
        adjustStock(id, val, state.activeBranch, 'Shelf audit');
        return;
      }

      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'sell1') sellItem(id, 1, state.activeBranch);
      else if (action === 'open') openItemModal(id, 'sell');
      else if (action === 'pull') {
        const from = otherBranch(state.activeBranch);
        transferItem(id, from, state.activeBranch, 1, 'Quick pull');
      }
    });

    // Stock In
    els.stockInBranchSelect.value = state.activeBranch;
    els.stockInBranchSelect.addEventListener('change', renderStockInTab);
    els.stockInSearchInput.addEventListener('input', (e) => {
      ui.stockInSearch = e.target.value;
      renderStockInTab();
    });

    els.stockInPickerList.addEventListener('click', (e) => {
      const customBtn = e.target.closest('[data-add-custom]');
      if (customBtn) {
        const id = customBtn.dataset.addCustom;
        const inp = els.stockInPickerList.querySelector(`[data-custom-qty="${CSS.escape(id)}"]`);
        const addQty = Number(inp ? inp.value : 0);
        if (!addQty || addQty <= 0) {
          showToast('Pehle quantity likhein (maslan 4 ya 15).');
          if (inp) inp.focus();
          return;
        }
        const item = state.stock.find((x) => x.id === id);
        if (!item) return;
        if (!ui.cart[id]) ui.cart[id] = { id: item.id, brand: item.brand, model: item.model, qty: 0 };
        ui.cart[id].qty += addQty;
        renderStockInTab();
        showToast(`Cart mein +${addQty} ${item.brand} ${item.model} add ho gaye`);
        return;
      }

      const btn = e.target.closest('[data-add-cart]');
      if (!btn) return;
      const id = btn.dataset.addCart;
      const addQty = Number(btn.dataset.qty) || 1;
      const item = state.stock.find((x) => x.id === id);
      if (!item) return;
      if (!ui.cart[id]) ui.cart[id] = { id: item.id, brand: item.brand, model: item.model, qty: 0 };
      ui.cart[id].qty += addQty;
      renderStockInTab();
    });

    els.stockInPickerList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.dataset.customQty) return;
      e.preventDefault();
      const id = e.target.dataset.customQty;
      const addBtn = els.stockInPickerList.querySelector(`[data-add-custom="${CSS.escape(id)}"]`);
      if (addBtn) addBtn.click();
    });

    els.stockInCartList.addEventListener('input', (e) => {
      if (!e.target.dataset.cartId) return;
      const id = e.target.dataset.cartId;
      const val = Math.max(0, Number(e.target.value) || 0);
      if (val === 0) delete ui.cart[id];
      else ui.cart[id].qty = val;
      const entries = Object.values(ui.cart);
      els.cartItemCount.textContent = entries.length;
      els.cartTotalPcs.textContent = entries.reduce((s, x) => s + x.qty, 0);
    });

    els.stockInCartList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-cart]');
      if (!btn) return;
      delete ui.cart[btn.dataset.removeCart];
      renderStockInTab();
    });

    els.clearCartBtn.addEventListener('click', () => {
      ui.cart = {};
      renderStockInTab();
    });

    els.confirmStockInBtn.addEventListener('click', submitStockInBatch);

    // Transfer tab
    els.crossBranchNeededList.addEventListener('click', (e) => {
      const pullBtn = e.target.closest('[data-pull-one]');
      if (pullBtn) {
        transferItem(pullBtn.dataset.pullOne, otherBranch(state.activeBranch), state.activeBranch, 1, 'Cross-branch pull');
        return;
      }
      const openBtn = e.target.closest('[data-action="open-transfer"]');
      if (openBtn) openItemModal(openBtn.dataset.id, 'transfer');
    });

    // Reports
    els.reportDateInput.value = ui.reportDate;
    els.reportDateInput.addEventListener('change', (e) => {
      ui.reportDate = e.target.value || todayStr();
      renderReportsTab();
    });
    els.reportBranchFilter.addEventListener('change', (e) => {
      ui.reportBranch = e.target.value;
      renderReportsTab();
    });
    document.querySelectorAll('[data-report-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        ui.reportTab = btn.dataset.reportTab;
        document.querySelectorAll('[data-report-tab]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderReportsTab();
      });
    });

    els.copyOrderListBtn.addEventListener('click', async () => {
      const target = ui.reportBranch === 'ALL' ? state.activeBranch : ui.reportBranch;
      const lines = state.stock
        .filter((x) => getQty(x, target) <= (x.minAlert || 2))
        .map((x) => `${x.brand} ${x.model}: ${getQty(x, target)} pcs`);
      const text = `*SM TPU Order List (${target}) — ${todayStr()}*\n` + (lines.length ? lines.join('\n') : 'All models in stock!');
      try {
        await navigator.clipboard.writeText(text);
        showToast('Order list copied! WhatsApp par paste karein.');
      } catch {
        showToast('Copy failed — browser permission check karein.');
      }
    });

    els.printSheetBtn.addEventListener('click', () => {
      buildPrintableHtml();
      window.print();
    });

    // Branch Modal
    els.branchSwitchBtn.addEventListener('click', () => {
      els.modalUserInput.value = state.userName;
      document.querySelectorAll('.branch-choice').forEach((c) => {
        c.classList.toggle('selected', c.dataset.branch === state.activeBranch);
      });
      els.branchModal.classList.remove('hidden');
    });

    els.closeBranchModalBtn.addEventListener('click', () => els.branchModal.classList.add('hidden'));

    document.querySelectorAll('.branch-choice').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chosen = btn.dataset.branch;
        const customName = els.modalUserInput.value.trim();
        state.activeBranch = chosen;
        state.userName = customName || (chosen === BRANCH_1 ? 'Owner (Branch 1)' : 'Bhai (Branch 2)');
        state.profileSelected = true;
        els.stockInBranchSelect.value = chosen;
        saveState();
        renderAll();
        els.branchModal.classList.add('hidden');
        showToast(`Active: ${state.activeBranch} (${state.userName})`);
      });
    });

    // Item Action Modal
    els.closeItemModalBtn.addEventListener('click', () => els.itemActionModal.classList.add('hidden'));
    document.querySelectorAll('[data-modal-mode]').forEach((b) => {
      b.addEventListener('click', () => setModalMode(b.dataset.modalMode));
    });
    els.sellQtyMinus.addEventListener('click', () => {
      els.sellQtyInput.value = Math.max(1, (Number(els.sellQtyInput.value) || 1) - 1);
    });
    els.sellQtyPlus.addEventListener('click', () => {
      els.sellQtyInput.value = (Number(els.sellQtyInput.value) || 1) + 1;
    });
    els.trQtyMinus.addEventListener('click', () => {
      els.trQtyInput.value = Math.max(1, (Number(els.trQtyInput.value) || 1) - 1);
    });
    els.trQtyPlus.addEventListener('click', () => {
      els.trQtyInput.value = (Number(els.trQtyInput.value) || 1) + 1;
    });

    els.confirmSellBtn.addEventListener('click', () => {
      const qty = Number(els.sellQtyInput.value) || 1;
      const ok = sellItem(ui.modalItemId, qty, els.modalSellBranch.value, els.sellNoteInput.value.trim());
      if (ok) els.itemActionModal.classList.add('hidden');
    });

    els.confirmTransferBtn.addEventListener('click', () => {
      const qty = Number(els.trQtyInput.value) || 1;
      const dir = els.modalTransferDir.value;
      const from = dir === '2to1' ? BRANCH_2 : BRANCH_1;
      const to = dir === '2to1' ? BRANCH_1 : BRANCH_2;
      const ok = transferItem(ui.modalItemId, from, to, qty, 'Modal transfer');
      if (ok) els.itemActionModal.classList.add('hidden');
    });

    els.auditQtyMinus.addEventListener('click', () => {
      els.auditQtyInput.value = String(Math.max(0, (Number(els.auditQtyInput.value) || 0) - 1));
    });
    els.auditQtyPlus.addEventListener('click', () => {
      els.auditQtyInput.value = String((Number(els.auditQtyInput.value) || 0) + 1);
    });
    els.auditZeroBtn.addEventListener('click', () => {
      els.auditQtyInput.value = '0';
    });
    els.modalAuditBranch.addEventListener('change', () => {
      const item = state.stock.find((x) => x.id === ui.modalItemId);
      if (item) els.auditQtyInput.value = String(getQty(item, els.modalAuditBranch.value));
    });
    els.confirmAuditBtn.addEventListener('click', () => {
      const qty = Math.max(0, Number(els.auditQtyInput.value) || 0);
      const branch = els.modalAuditBranch.value;
      const reason = els.auditReasonInput.value.trim() || 'Physical count / Audit';
      const ok = adjustStock(ui.modalItemId, qty, branch, reason);
      if (ok) els.itemActionModal.classList.add('hidden');
    });

    // Add New Model Modal
    els.openAddModelBtn.addEventListener('click', () => els.addModelModal.classList.remove('hidden'));
    els.closeAddModelBtn.addEventListener('click', () => els.addModelModal.classList.add('hidden'));
    els.confirmAddModelBtn.addEventListener('click', addNewModel);

    // Toast Undo
    els.toastUndoBtn.addEventListener('click', () => {
      if (ui.lastUndoTx && ui.lastUndoTx.type === 'return_sale') {
        const u = ui.lastUndoTx;
        returnSale(u.itemId, u.qty, u.branch);
      }
      els.toast.classList.add('hidden');
    });

    // Settings
    els.saveProfileBtn.addEventListener('click', () => {
      state.activeBranch = els.settingsBranchSelect.value;
      state.userName = els.settingsUserInput.value.trim() || state.activeBranch;
      state.lockOtherBranch = els.settingsLockOtherBranch.checked;
      state.profileSelected = true;
      els.stockInBranchSelect.value = state.activeBranch;
      saveState();
      renderAll();
      showToast('Profile saved.');
    });

    els.saveApiUrlBtn.addEventListener('click', async () => {
      const url = els.settingsApiUrlInput.value.trim();
      state.apiUrl = url;
      saveState();
      if (!url) {
        els.apiStatusMessage.classList.add('hidden');
        showToast('URL cleared — Local Mode active.');
        return;
      }
      els.apiStatusMessage.textContent = 'Testing connection...';
      els.apiStatusMessage.className = 'status-box mt-8';
      els.apiStatusMessage.classList.remove('hidden');
      try {
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}action=ping`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Ping failed');
        els.apiStatusMessage.textContent = `Connected to Google Sheet: "${data.sheetName}"`;
        els.apiStatusMessage.className = 'status-box ok mt-8';
      } catch (err) {
        els.apiStatusMessage.textContent = `Connection failed: ${err.message}`;
        els.apiStatusMessage.className = 'status-box err mt-8';
      }
    });

    els.pushSeedBtn.addEventListener('click', async () => {
      if (!state.apiUrl) return showToast('Pehle Apps Script URL save karein.');
      showToast('Pushing stock to Google Sheet...');
      let resp = await sendToSheet({
        action: 'seed_inventory',
        overwrite: false,
        items: state.stock,
      });
      if (resp && !resp.ok && String(resp.error || '').includes('already has data')) {
        if (confirm('Google Sheet mein pehle se stock maujood hai. Kya aap app ka mojooda stock Google Sheet par overwrite karna chahte hain?')) {
          resp = await sendToSheet({
            action: 'seed_inventory',
            overwrite: true,
            items: state.stock,
          });
        } else {
          return;
        }
      }
      if (resp && resp.ok) {
        state.pendingQueue = [];
        saveState();
        showToast(`Success! ${resp.seeded} models Google Sheet par update ho gaye.`);
      } else {
        showToast((resp && resp.error) || 'Push failed.');
      }
    });

    els.pullSyncBtn.addEventListener('click', syncFromSheet);
    els.syncNowBtn.addEventListener('click', syncFromSheet);
    els.syncBadge.addEventListener('click', openPendingModal);
    els.openPendingBtn.addEventListener('click', openPendingModal);
    els.closePendingModalBtn.addEventListener('click', () => els.pendingModal.classList.add('hidden'));
    els.pendingQueueList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-drop-pending]');
      if (!btn) return;
      const idx = Number(btn.dataset.dropPending);
      if (Number.isNaN(idx) || idx < 0 || idx >= state.pendingQueue.length) return;
      state.pendingQueue.splice(idx, 1);
      saveState();
      openPendingModal();
      showToast('Pending entry hata di gayi.');
    });
    els.reapplyPendingBtn.addEventListener('click', reapplyPendingToLocalStock);

    els.copyPendingBtn.addEventListener('click', async () => {
      const q = state.pendingQueue || [];
      if (q.length === 0) return showToast('Pending queue khali hai.');
      const text = q.map((tx, idx) => formatPendingEntryText(tx, idx)).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        showToast(`${q.length} pending entries copied!`);
      } catch {
        showToast('Copy failed — browser permission check karein.');
      }
    });

    els.flushPendingBtn.addEventListener('click', async () => {
      if (!state.apiUrl) return showToast('Pehle Settings mein Apps Script URL save karein.');
      els.pendingUploadError.classList.add('hidden');
      const res = await flushQueue();
      openPendingModal();
      if (res.ok) {
        showToast('Saari pending entries Google Sheet par upload ho gayin!');
      } else {
        els.pendingUploadError.textContent = `Upload ruka (${res.remainingCount} baqi): ${res.lastError}`;
        els.pendingUploadError.classList.remove('hidden');
      }
    });

    els.runBackupBtn.addEventListener('click', async () => {
      if (!state.apiUrl) return showToast('Pehle Apps Script URL save karein.');
      const resp = await sendToSheet({ action: 'run_backup' });
      if (resp && resp.ok) showToast(`Drive backup created: ${resp.backupName}`);
      else showToast(resp.error || 'Backup failed.');
    });

    els.exportCsvBtn.addEventListener('click', () => {
      const lines = ['Brand,Model,SM Branch 1,SM Branch 2,Total_Qty'];
      for (const i of state.stock) {
        lines.push(`"${i.brand}","${i.model.replace(/"/g, '""')}",${i.branch1},${i.branch2},${i.branch1 + i.branch2}`);
      }
      downloadFile(`sm-tpu-stock-${todayStr()}.csv`, lines.join('\n'), 'text/csv');
    });

    els.exportJsonBtn.addEventListener('click', () => {
      downloadFile(`sm-tpu-backup-${todayStr()}.json`, JSON.stringify(state, null, 2), 'application/json');
    });

    els.importJsonBtn.addEventListener('click', () => els.importJsonInput.click());
    els.importJsonInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed.stock) || parsed.stock.length === 0) {
          showToast('Invalid backup file — stock list nahi mili.');
          return;
        }
        if (!confirm(`${parsed.stock.length} models wali backup file load karni hai?`)) return;
        state = {
          ...buildInitialState(),
          ...parsed,
          stock: repairCorruptedModels(parsed.stock),
        };
        saveState();
        renderAll();
        showToast(`Backup imported (${state.stock.length} models). Ab Settings se Push Stock to Sheet dabayein.`);
      } catch (err) {
        showToast('JSON import error: ' + err.message);
      }
    });

    els.restoreBackupBtn.addEventListener('click', () => {
      const raw = localStorage.getItem(PRESYNC_BACKUP_KEY);
      if (!raw) {
        showToast('Koi pre-sync local backup maujood nahi hai.');
        return;
      }
      if (!confirm('Kya aap aakhri Sync se pehle wala local stock wapas lana chahte hain?')) return;
      try {
        state = { ...buildInitialState(), ...JSON.parse(raw) };
        saveState();
        renderAll();
        showToast('Pre-sync local backup restore ho gaya!');
      } catch {
        showToast('Backup restore nahi ho saka.');
      }
    });

    els.resetDemoBtn.addEventListener('click', () => {
      if (!confirm('Kya aap local demo data reset karke original list wapas lana chahte hain?')) return;
      localStorage.removeItem(STORAGE_KEY);
      state = buildInitialState();
      renderAll();
      showToast('Local data reset to initial cleaned inventory.');
    });
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function init() {
    cacheDom();
    bindEvents();
    renderAll();

    if (!state.profileSelected) {
      els.branchModal.classList.remove('hidden');
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    window.addEventListener('online', () => {
      flushQueue();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
