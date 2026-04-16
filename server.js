const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'lifely2026';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const CIN7_USER = process.env.CIN7_USER || '';
const CIN7_KEY = process.env.CIN7_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const AIS_API_KEY = process.env.AIS_API_KEY || '';
const CIN7_REQUEST_SPACING_MS = 1500;
const CIN7_MIN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CIN7_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const LL_AU_BRANCH_IDS = [3, 60976];
const LL_NZ_BRANCH_IDS = [48391];

// Shopify stores
const SHOPIFY_STORES = {
  lifely: {
    domain: 'lifelystore.myshopify.com',
    token: process.env.SHOPIFY_TOKEN || ''
  },
  cushie: {
    domain: 'cushie-2235.myshopify.com',
    token: process.env.SHOPIFY_TOKEN_CUSHIE || ''
  },
  littlelifely: {
    domain: 'little-lifely.myshopify.com',
    token: process.env.SHOPIFY_TOKEN_LL || ''
  }
};

// ===== CK DEFINITIONS =====
const CK_DEFS = {
  'llau-cb':   { name: 'Little Lifely AU',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'Australia', stockBranches: LL_AU_BRANCH_IDS, filter: sku => !sku.includes('CBCF'), sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llnz':      { name: 'Little Lifely NZ',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'New Zealand', stockBranches: LL_NZ_BRANCH_IDS, strictStockBranches: true, filter: sku => !sku.includes('CBCF'), sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llau-cbcf': { name: 'LL AU Combos',            prefix: 'LLAU-CBCF-', logo: 'little-lifely.png', store: 'lifely', excludeCV: true, stockBranches: LL_AU_BRANCH_IDS, sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llna':     { name: 'Little Lifely NA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'United States', stockBranches: [60701], sizes: {'-TW-':'Twin','-F-':'Full'} },
  'llca':     { name: 'Little Lifely CA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'Canada', stockBranches: [61831], sizes: {'-TW-':'Twin','-F-':'Full'} },
  'lluk':     { name: 'Little Lifely UK',       prefix: 'LLUK',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, stockBranches: [62444], sizes: {'-S-':'Single','-SD-':'Small Double','-D-':'Double'} },
  'llsg':     { name: 'Little Lifely SG',       prefix: 'LLSG',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, stockBranches: [57843], strictStockBranches: true, sizes: {'-SS-':'Super Single','-S-':'Single','-Q-':'Queen'} },
  'dd':       { name: 'Deep Dream',             prefix: 'DD',     logo: 'deep-dream.png',    store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, sizes: {'915':'Single','107':'King Single','137':'Double','153':'Queen','183':'King'} },
  'cocoon':   { name: 'Cocoon Bed',             prefix: 'COCOON', logo: 'cocoon-bed.png',    store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, sizes: {'-DOUBLE-':'Double','-QUEEN-':'Queen','-KING-':'King'} },
  'rdnt':     { name: 'Radiant',                prefix: 'RDNT',   logo: 'radiant.png',       store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, sizes: {'-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'wfhcr':    { name: 'WFH Chair',              prefix: 'WFHCR',  logo: 'wfh-chair.png',     store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, sizes: {} },
  'cusb-au':  { name: 'Cushie AU',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, filter: sku => (sku.startsWith('CUSB') || sku.startsWith('LFSB')) && !sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },
  'cusb-us':  { name: 'Cushie US',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', stockBranches: [60701], filter: sku => sku.startsWith('V2-') || sku.startsWith('V3-'), excludeCV: true, sizes: {'-TB-':'Twin','-DB-':'Full','-QB-':'Queen','-KB-':'King','-CH-':'Chaise','-OS-':'Ottoman','-OB-':'Ottoman Bed','-RMST-':'Armrest','-ARM-':'Armrest'} },
  'cusb-uk':  { name: 'Cushie UK',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', stockBranches: [62444], filter: sku => (sku.startsWith('CUSB') || sku.startsWith('LFSB')) && sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },
  
  'cmss':     { name: 'Modular Sleeper',        prefix: 'CMSS',   logo: 'lifely-sofa.png',   store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, sizes: {'-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'lifely-sofa': { name: 'Modular Sofa',        prefix: 'LIFELY', logo: 'lifely-sofa.png',   store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, sizes: {} }
};

// ===== COMBO BOM (Bill of Materials) =====
const COMBO_BOM = {
  // LLAU-CBCF-{size}-{colour} = 1× LLAU-CB-{size}-{colour} + 1× DD mattress
  mattress: { 'S': 'DD-21915CF', 'KS': 'DD-21107CF', 'D': 'DD-21137CF' }
};

function getComboSize(sku) {
  if (sku.includes('-S-')) return 'S';
  if (sku.includes('-KS-')) return 'KS';
  if (sku.includes('-D-')) return 'D';
  return null;
}

function getComboColour(sku) {
  const parts = sku.split('-');
  return parts[parts.length - 1]; // Last segment is colour
}

function explodeComboBOM(comboSku) {
  const size = getComboSize(comboSku);
  const colour = getComboColour(comboSku);
  if (!size || !colour) return null;
  return {
    bed: 'LLAU-CB-' + size + '-' + colour,
    mattress: COMBO_BOM.mattress[size],
    bedQty: 1,
    mattressQty: 1
  };
}

// ===== SESSION STORE =====
const sessions = new Map();
function createSession() {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { created: Date.now(), valid: true });
  return id;
}
function validSession(id) {
  const s = sessions.get(id);
  if (!s || !s.valid) return false;
  if (Date.now() - s.created > 24 * 60 * 60 * 1000) { sessions.delete(id); return false; }
  return true;
}

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  const sid = req.headers['x-session'] || req.query.session;
  if (validSession(sid)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

// ===== DATA CACHE =====
let dataCache = {
  lastRefresh: null,
  lastCin7Refresh: null,
  cin7Products: {},   // sku -> {soh, available, costAUD, cbm}
  cin7StockByBranch: {}, // sku -> { branchId -> { soh, available, branchName } }
  cin7POs: [],        // [{reference, status, stage, arrival, items: {sku: qty}}]
  shopifyVelocity: {}, // store -> {sku -> weekly_velocity}
  shopifyInventory: {}, // store -> {sku -> inventory_level}
  shopifyOpenDemand: {}, // store -> { country -> { sku -> open qty } }
  error: null
};
const CACHE_SNAPSHOT_PATH = path.join(__dirname, 'data', 'cache-snapshot.json');
const CACHE_SNAPSHOT_BACKUP_PATH = path.join(__dirname, 'data', 'cache-snapshot.last-good.json');
const PO_SNAPSHOT_PATH = path.join(__dirname, 'data', 'po-snapshot.json');
const PO_SNAPSHOT_BACKUP_PATH = path.join(__dirname, 'data', 'po-snapshot.last-good.json');
const SNAPSHOT_PUSH_STATE_PATH = path.join(__dirname, 'data', 'snapshot-push-state.json');
let snapshotPushInFlight = false;
let cacheSnapshotPushInFlight = false;

function snapshotHasCin7Data(snap) {
  return !!(snap && (
    (snap.cin7Products && Object.keys(snap.cin7Products).length > 0) ||
    (Array.isArray(snap.cin7POs) && snap.cin7POs.length > 0)
  ));
}

function cleanPoReference(ref) {
  return (ref || '').replace(/-cover$/i, '');
}

function mergeCin7POsByReference(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const now = Date.now();
  const grouped = new Map();

  const priority = po => {
    if (!po) return 0;
    if (po.fullyReceivedDate || po.stage === 'Received') return 4;
    const eta = po.estimatedArrivalDate || po.arrival;
    const etd = po.etd;
    const etaMs = eta ? new Date(eta).getTime() : NaN;
    const etdMs = etd ? new Date(etd).getTime() : NaN;
    if (!Number.isNaN(etaMs) && etaMs <= now) return 3;
    if (!Number.isNaN(etdMs) && etdMs <= now) return 2;
    return 1;
  };

  for (const po of rows) {
    const key = cleanPoReference(po.reference);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ...po, reference: key });
  }

  const merged = [];
  for (const [reference, group] of grouped.entries()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    group.sort((a, b) => priority(b) - priority(a));
    const base = { ...group[0], reference, items: {} };

    for (const po of group) {
      for (const [sku, qty] of Object.entries(po.items || {})) {
        base.items[sku] = (base.items[sku] || 0) + qty;
      }
      base.total = (base.total || 0) + (po.total || 0);
      base.freightTotal = (base.freightTotal || 0) + (po.freightTotal || 0);
      if (!base.company && po.company) base.company = po.company;
      if (!base.status && po.status) base.status = po.status;
      if (!base.stage && po.stage) base.stage = po.stage;
      if (!base.deliveryCountry && po.deliveryCountry) base.deliveryCountry = po.deliveryCountry;
      if (!base.deliveryCity && po.deliveryCity) base.deliveryCity = po.deliveryCity;
      if (!base.trackingCode && po.trackingCode) base.trackingCode = po.trackingCode;
      if (!base.port && po.port) base.port = po.port;
      if (!base.logisticsCarrier && po.logisticsCarrier) base.logisticsCarrier = po.logisticsCarrier;
      if (!base.internalComments && po.internalComments) base.internalComments = po.internalComments;
      if (!base.createdBy && po.createdBy) base.createdBy = po.createdBy;
      if (!base.invoiceDate && po.invoiceDate) base.invoiceDate = po.invoiceDate;
      if (!base.supplierInvoiceReference && po.supplierInvoiceReference) base.supplierInvoiceReference = po.supplierInvoiceReference;
      if ((!base.customFields || Object.keys(base.customFields).length === 0) && po.customFields) base.customFields = po.customFields;
      if (!base.fullyReceivedDate && po.fullyReceivedDate) base.fullyReceivedDate = po.fullyReceivedDate;
      if (!base.arrival && po.arrival) base.arrival = po.arrival;
      if (!base.estimatedArrivalDate && po.estimatedArrivalDate) base.estimatedArrivalDate = po.estimatedArrivalDate;
      if (!base.etd && po.etd) base.etd = po.etd;
    }

    merged.push(base);
  }

  return merged;
}

function loadPoSnapshot() {
  for (const snapPath of [PO_SNAPSHOT_PATH, PO_SNAPSHOT_BACKUP_PATH]) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      if (Array.isArray(snap?.cin7POs) && snap.cin7POs.length > 0) {
        if (!Array.isArray(dataCache.cin7POs) || dataCache.cin7POs.length < snap.cin7POs.length) {
          dataCache.cin7POs = mergeCin7POsByReference(snap.cin7POs);
          if (snap.lastCin7Refresh) dataCache.lastCin7Refresh = snap.lastCin7Refresh;
          if (snap.lastRefresh) dataCache.lastRefresh = snap.lastRefresh;
          console.log(`Loaded full PO snapshot from ${path.basename(snapPath)}: ${dataCache.cin7POs.length} POs`);
        }
        return;
      }
    } catch (e) {
      // try next path
    }
  }
}

function saveSnapshotPushState(state) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PUSH_STATE_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PUSH_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('Snapshot push state save failed:', e.message);
  }
}

function loadSnapshotPushState() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PUSH_STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function maybePushPoSnapshotToGit(reason = 'cin7-refresh') {
  const today = new Date().toISOString().slice(0, 10);
  const state = loadSnapshotPushState();
  if (state.poLastSuccessDate === today || snapshotPushInFlight) return;
  snapshotPushInFlight = true;
  const command = [
    'git add data/po-snapshot.json data/po-snapshot.last-good.json',
    'git diff --cached --quiet && exit 0',
    `git commit -m "Update PO snapshot (${reason})"`,
    'git push'
  ].join(' && ');
  exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
    snapshotPushInFlight = false;
    if (stdout) console.log(stdout.trim());
    if (stderr) console.log(stderr.trim());
    if (error) {
      if (error.code !== 0) console.error('PO snapshot git push failed:', error.message);
      return;
    }
    saveSnapshotPushState({ ...state, poLastSuccessDate: today, poLastReason: reason, poPushedAt: new Date().toISOString() });
    console.log('PO snapshot pushed to GitHub');
  });
}

function maybePushCacheSnapshotToGit(reason = 'cin7-refresh') {
  const today = new Date().toISOString().slice(0, 10);
  const state = loadSnapshotPushState();
  if (state.cacheLastSuccessDate === today || cacheSnapshotPushInFlight) return;
  cacheSnapshotPushInFlight = true;
  const command = [
    'git add data/cache-snapshot.json data/cache-snapshot.last-good.json',
    'git diff --cached --quiet && exit 0',
    `git commit -m "Update cache snapshot (${reason})"`,
    'git push'
  ].join(' && ');
  exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
    cacheSnapshotPushInFlight = false;
    if (stdout) console.log(stdout.trim());
    if (stderr) console.log(stderr.trim());
    if (error) {
      if (error.code !== 0) console.error('Cache snapshot git push failed:', error.message);
      return;
    }
    saveSnapshotPushState({ ...state, cacheLastSuccessDate: today, cacheLastReason: reason, cachePushedAt: new Date().toISOString() });
    console.log('Cache snapshot pushed to GitHub');
  });
}

function savePoSnapshot(pushToGit = false, pushReason = 'cin7-refresh') {
  try {
    if (!Array.isArray(dataCache.cin7POs) || dataCache.cin7POs.length === 0) {
      console.warn('Refusing to save empty PO snapshot — keeping last good PO cache on disk');
      return;
    }
    fs.mkdirSync(path.dirname(PO_SNAPSHOT_PATH), { recursive: true });
    const payload = JSON.stringify({
      lastRefresh: dataCache.lastRefresh,
      lastCin7Refresh: dataCache.lastCin7Refresh,
      cin7POs: mergeCin7POsByReference(dataCache.cin7POs)
    });
    fs.writeFileSync(PO_SNAPSHOT_PATH, payload);
    fs.writeFileSync(PO_SNAPSHOT_BACKUP_PATH, payload);
    console.log(`Saved full PO snapshot (${dataCache.cin7POs.length} POs)`);
    if (pushToGit) maybePushPoSnapshotToGit(pushReason);
  } catch (e) {
    console.error('PO snapshot save failed:', e.message);
  }
}

function loadCacheSnapshot() {
  for (const snapPath of [CACHE_SNAPSHOT_PATH, CACHE_SNAPSHOT_BACKUP_PATH]) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      if (snapshotHasCin7Data(snap)) {
        dataCache = { ...dataCache, ...snap, error: null };
        dataCache.cin7POs = mergeCin7POsByReference(dataCache.cin7POs || []);
        console.log(`Loaded cache snapshot from ${path.basename(snapPath)}: ${Object.keys(dataCache.cin7Products).length} CIN7 SKUs, ${dataCache.cin7POs.length} POs`);
        break;
      }
      console.log(`Cache snapshot empty at ${path.basename(snapPath)} — ignoring`);
    } catch (e) {
      // try next path
    }
  }
  loadPoSnapshot();
  if (!snapshotHasCin7Data(dataCache)) console.log('No usable cache snapshot found — starting cold');
}

function saveCacheSnapshot(pushToGit = false, pushReason = 'cin7-refresh') {
  try {
    const snapshot = {
      snapshotCreatedAt: new Date().toISOString(),
      lastRefresh: dataCache.lastRefresh,
      lastCin7Refresh: dataCache.lastCin7Refresh,
      cin7Products: dataCache.cin7Products,
      cin7StockByBranch: dataCache.cin7StockByBranch,
      cin7POs: dataCache.cin7POs,
      shopifyVelocity: dataCache.shopifyVelocity,
      shopifyInventory: dataCache.shopifyInventory,
      shopifyOpenDemand: dataCache.shopifyOpenDemand,
      error: dataCache.error,
      fxRate
    };

    if (!snapshotHasCin7Data(snapshot)) {
      console.warn('Refusing to save empty Cin7 snapshot — keeping last good cache on disk');
      return;
    }

    fs.mkdirSync(path.dirname(CACHE_SNAPSHOT_PATH), { recursive: true });
    const payload = JSON.stringify(snapshot);
    fs.writeFileSync(CACHE_SNAPSHOT_PATH, payload);
    fs.writeFileSync(CACHE_SNAPSHOT_BACKUP_PATH, payload);
    console.log('Saved cache snapshot');
    if (pushToGit) maybePushCacheSnapshotToGit(pushReason);
  } catch (e) {
    console.error('Cache snapshot save failed:', e.message);
  }
}

loadCacheSnapshot();

// Load Excel-derived landed costs (SOH Stock Value ÷ SOH Stock Qty from CIN7 report)
let excelLandedCosts = {};
try {
  excelLandedCosts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'landed-costs.json'), 'utf8'));
  console.log(`Loaded ${Object.keys(excelLandedCosts).length} Excel landed costs`);
} catch (e) { console.log('No Excel landed costs file found — will use estimated only'); }

// ===== LIVE FX RATE =====
let fxRate = { USDAUD: 1.45, lastFetch: null }; // fallback
async function refreshFxRate() {
  try {
    const { body } = await apiRequest({ hostname: 'open.er-api.com', path: '/v6/latest/USD', headers: {} });
    if (body?.rates?.AUD) {
      fxRate.USDAUD = body.rates.AUD;
      fxRate.lastFetch = new Date().toISOString();
      console.log(`FX rate updated: 1 USD = ${fxRate.USDAUD} AUD`);
    }
  } catch (e) { console.log('FX rate fetch failed:', e.message); }
}
refreshFxRate();
setInterval(refreshFxRate, 6 * 60 * 60 * 1000); // Refresh every 6 hours

// ===== HTTPS REQUEST HELPER =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let cin7LastRequestAt = 0;
let cin7BackoffUntil = 0;
let cin7RecoveryTimer = null;
let refreshPromise = null;

async function throttleCin7Request() {
  const waitMs = Math.max(0, cin7LastRequestAt + CIN7_REQUEST_SPACING_MS - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  cin7LastRequestAt = Date.now();
}

function hasCin7Cache() {
  return Object.keys(dataCache.cin7Products || {}).length > 0;
}

function scheduleCin7Recovery(reason) {
  if (hasCin7Cache() || cin7RecoveryTimer) return;
  const delayMs = Math.max(5 * 60 * 1000, cin7BackoffUntil > Date.now() ? cin7BackoffUntil - Date.now() : CIN7_RATE_LIMIT_BACKOFF_MS);
  console.warn(`Scheduling delayed CIN7 recovery in ${Math.ceil(delayMs / 60000)} min (${reason})`);
  cin7RecoveryTimer = setTimeout(async () => {
    cin7RecoveryTimer = null;
    if (hasCin7Cache()) return;
    console.log('Running scheduled CIN7 recovery refresh...');
    try {
      await refreshAllData();
    } catch (e) {
      console.error('Scheduled CIN7 recovery failed:', e.message);
    }
  }, delayMs);
  if (typeof cin7RecoveryTimer.unref === 'function') cin7RecoveryTimer.unref();
}

function getCin7SkipReason(force = false) {
  const now = Date.now();
  const lastCin7RefreshMs = dataCache.lastCin7Refresh ? new Date(dataCache.lastCin7Refresh).getTime() : 0;

  if (cin7BackoffUntil > now && hasCin7Cache()) {
    return `rate limit backoff active for ${Math.ceil((cin7BackoffUntil - now) / 60000)} more min`;
  }

  if (!force && lastCin7RefreshMs && hasCin7Cache() && (now - lastCin7RefreshMs) < CIN7_MIN_REFRESH_INTERVAL_MS) {
    return `last CIN7 refresh was ${Math.round((now - lastCin7RefreshMs) / 60000)} min ago`;
  }

  return null;
}

function markCin7Backoff(reason, retryAfterSeconds) {
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(CIN7_RATE_LIMIT_BACKOFF_MS, retryAfterSeconds * 1000)
    : CIN7_RATE_LIMIT_BACKOFF_MS;
  cin7BackoffUntil = Math.max(cin7BackoffUntil, Date.now() + retryAfterMs);
  console.warn(`CIN7 backoff enabled for ${Math.ceil(retryAfterMs / 60000)} min (${reason})`);
  scheduleCin7Recovery(reason);
}

function apiRequest(options, postData, attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        const status = res.statusCode || 0;

        // Cin7 can return 429 during cold starts or concurrent refreshes.
        // Retry briefly, but never honor giant Retry-After values that can stall
        // the whole refresh loop for hours and leave the planner empty on restart.
        if (options.hostname === 'api.cin7.com' && status === 429 && attempt < 2) {
          const retryAfterHeader = parseInt(res.headers['retry-after'] || '2', 10);
          const retryAfter = Math.min(15, Math.max(2, Number.isFinite(retryAfterHeader) ? retryAfterHeader : 2));
          console.warn(`Cin7 429 for ${options.path} — retrying in ${retryAfter}s (attempt ${attempt + 1}/2)`);
          await sleep(retryAfter * 1000);
          try {
            const retried = await apiRequest(options, postData, attempt + 1);
            return resolve(retried);
          } catch (e) {
            return reject(e);
          }
        }

        try { resolve({ body: JSON.parse(data), headers: res.headers, status }); }
        catch(e) { resolve({ body: data, headers: res.headers, status }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ===== CIN7: FETCH ALL PRODUCTS =====
async function fetchCin7AllProducts() {
  if (!CIN7_USER || !CIN7_KEY) { console.log('CIN7 SKIPPED: no credentials. USER=' + (CIN7_USER ? 'set' : 'empty') + ' KEY=' + (CIN7_KEY ? 'set' : 'empty')); return { products: {}, stockByBranch: {} }; }
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const products = {};
  const stockByBranch = {};

  for (let page = 1; page <= 50; page++) {
    try {
      console.log('CIN7 Products: fetching page ' + page);
      let body, status, headers;
      try {
        await throttleCin7Request();
        const resp = await apiRequest({
          hostname: 'api.cin7.com',
          path: `/api/v1/Products?page=${page}&rows=250`,
          headers: { 'Authorization': `Basic ${auth}` }
        });
        body = resp.body;
        status = resp.status;
        headers = resp.headers || {};
      } catch (fetchErr) {
        console.error(`CIN7 Products page ${page} failed:`, fetchErr.message);
        break;
      }
      console.log('CIN7 Products page ' + page + ': status=' + status + ' isArray=' + Array.isArray(body) + ' length=' + (Array.isArray(body) ? body.length : 'N/A'));
      if (status === 429) {
        markCin7Backoff(`Products page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const product of body) {
        const variants = product.productOptions || [];
        const cbm = product.volume || 0;
        for (const v of variants) {
          if (v.code) {
            const pc = v.priceColumns || {};
            const costAUD = pc.costAUD || (pc.costUSD ? pc.costUSD * fxRate.USDAUD : 0);
            products[v.code] = { soh: v.stockOnHand || 0, available: v.stockAvailable || 0, costAUD, cbm };
          }
        }
        if (product.styleCode && product.stockOnHand > 0) {
          products[product.styleCode] = { soh: product.stockOnHand, available: product.stockAvailable || 0, cbm };
        }
      }
    } catch (e) { console.error(`CIN7 Products page ${page} error:`, e.message); continue; }
  }

  for (let page = 1; page <= 50; page++) {
    try {
      console.log('CIN7 Stock: fetching page ' + page);
      let body, status, headers;
      try {
        await throttleCin7Request();
        const resp = await apiRequest({
          hostname: 'api.cin7.com',
          path: `/api/v1/Stock?page=${page}&rows=250`,
          headers: { 'Authorization': `Basic ${auth}` }
        });
        body = resp.body;
        status = resp.status;
        headers = resp.headers || {};
      } catch (fetchErr) {
        console.error(`CIN7 Stock page ${page} failed:`, fetchErr.message);
        break;
      }
      if (status === 429) {
        markCin7Backoff(`Stock page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const row of body) {
        const sku = row.code;
        const branchId = Number(row.branchId || 0);
        if (!sku || !branchId) continue;
        if (!stockByBranch[sku]) stockByBranch[sku] = {};
        stockByBranch[sku][branchId] = {
          soh: Number(row.stockOnHand || 0),
          available: Number(row.available || 0),
          branchName: row.branchName || ''
        };
      }
    } catch (e) { console.error(`CIN7 Stock page ${page} error:`, e.message); continue; }
  }

  for (const [sku, branches] of Object.entries(stockByBranch)) {
    const totalSoh = Object.values(branches).reduce((sum, b) => sum + (Number(b.soh) || 0), 0);
    const totalAvailable = Object.values(branches).reduce((sum, b) => sum + (Number(b.available) || 0), 0);
    if (products[sku]) {
      products[sku].soh = totalSoh;
      products[sku].available = totalAvailable;
    } else {
      products[sku] = { soh: totalSoh, available: totalAvailable, costAUD: 0, cbm: 0 };
    }
  }

  return { products, stockByBranch };
}

// ===== CIN7: FETCH PURCHASE ORDERS =====
async function fetchCin7POs() {
  if (!CIN7_USER || !CIN7_KEY) return [];
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const results = [];
  for (let page = 1; page <= 5; page++) {
    try {
      await throttleCin7Request();
      const { body, status, headers } = await apiRequest({
        hostname: 'api.cin7.com',
        path: `/api/v1/PurchaseOrders?page=${page}&rows=250`,
        headers: { 'Authorization': `Basic ${auth}` }
      });
      if (status === 429) {
        markCin7Backoff(`PurchaseOrders page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const po of body) {
        if (po.isVoid) continue; // Skip void POs only — keep Received for shipment tracker
        const items = {};
        for (const li of (po.lineItems || [])) {
          if (li.code && li.qty > 0) items[li.code] = (items[li.code] || 0) + li.qty;
        }
        if (Object.keys(items).length > 0) {
          results.push({
            reference: cleanPoReference(po.reference),
            status: po.status,
            stage: po.stage || '',
            arrival: po.estimatedArrivalDate || null, // ETA only — never fall back to ETD
            etd: po.estimatedDeliveryDate || null,
            estimatedArrivalDate: po.estimatedArrivalDate || null,
            fullyReceivedDate: po.fullyReceivedDate || null,
            customFields: po.customFields || {},
            company: po.company || '',
            total: po.total || 0,
            currencyCode: po.currencyCode || 'USD',
            deliveryCountry: po.deliveryCountry || '',
            deliveryCity: po.deliveryCity || '',
            trackingCode: po.trackingCode || '',
            port: po.port || '',
            logisticsCarrier: po.logisticsCarrier || '',
            internalComments: po.internalComments || '',
            freightTotal: po.freightTotal || 0,
            createdBy: po.createdBy || null,
            invoiceDate: po.invoiceDate || null,
            supplierInvoiceReference: po.supplierInvoiceReference || '',
            items
          });
        }
      }
    } catch (e) { console.error(`CIN7 POs page ${page} error:`, e.message); break; }
  }
  return mergeCin7POsByReference(results);
}

// ===== SHOPIFY: FETCH ORDERS & CALCULATE VELOCITY =====
async function fetchShopifyVelocity(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) return {};
  
  const skuUnits = {};
  const skuWeekly = {};
  const sku7d = {};
  const sku30d = {};
  const skuFirstSeen = {};
  const now7d = new Date(Date.now() - 7 * 86400000);
  const now30d = new Date(Date.now() - 30 * 86400000);
  const days = 30;
  const historyDays = 90; // longer window for weekly breakdown + last in-stock velocity
  const since = new Date(Date.now() - historyDays * 86400000).toISOString();
  let url = `/admin/api/2026-01/orders.json?status=any&limit=250&created_at_min=${since}&fields=id,created_at,line_items,financial_status`;
  
  for (let page = 1; page <= 30; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const orders = body.orders || [];
      if (orders.length === 0) break;
      
      for (const o of orders) {
        if (o.financial_status === 'refunded' || o.financial_status === 'voided') continue;
        // ISO week calculation
        const dt = new Date(o.created_at);
        const jan4 = new Date(dt.getFullYear(), 0, 4);
        const dayOfYear = Math.floor((dt - new Date(dt.getFullYear(), 0, 1)) / 86400000);
        const weekNum = Math.ceil((dayOfYear + jan4.getDay() + 1) / 7);
        const weekKey = dt.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
        
        for (const li of (o.line_items || [])) {
          if (li.sku) {
            skuUnits[li.sku] = (skuUnits[li.sku] || 0) + (li.quantity || 0);
            // 7-day and 30-day velocity tracking
            if (dt >= now7d) sku7d[li.sku] = (sku7d[li.sku] || 0) + (li.quantity || 0);
            if (dt >= now30d) sku30d[li.sku] = (sku30d[li.sku] || 0) + (li.quantity || 0);
            // First seen date
            if (!skuFirstSeen[li.sku] || dt < skuFirstSeen[li.sku]) skuFirstSeen[li.sku] = dt;
            // Weekly breakdown
            if (!skuWeekly[li.sku]) skuWeekly[li.sku] = {};
            skuWeekly[li.sku][weekKey] = (skuWeekly[li.sku][weekKey] || 0) + (li.quantity || 0);
          }
        }
      }
      
      // Get next page URL from Link header
      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) { console.error(`Shopify ${storeKey} page ${page} error:`, e.message); break; }
  }
  
  // Convert to weekly velocity (30-day window)
  const weeks = days / 7;
  const velocity = {};
  // Use sku30d (30-day counts) for velocity, not skuUnits (which covers 90 days)
  for (const [sku, units] of Object.entries(sku30d)) {
    velocity[sku] = Math.round((units / weeks) * 10) / 10;
  }
  // Also include SKUs that had sales in 90d but not 30d (so they appear with 0 vel)
  for (const sku of Object.keys(skuUnits)) {
    if (!(sku in velocity)) velocity[sku] = 0;
  }
  
  // Also store weekly breakdown for WMAPE calculation
  velocity._weeklyBreakdown = skuWeekly || {};
  velocity._7d = sku7d;
  velocity._30d = sku30d;
  velocity._firstSeen = {};
  for (const [sku, dt] of Object.entries(skuFirstSeen)) {
    velocity._firstSeen[sku] = dt.toISOString();
  }
  
  return velocity;
}

async function fetchShopifyOpenDemand(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) return {};

  const openDemand = {};
  let url = `/admin/api/2026-01/orders.json?status=open&limit=250&fields=id,financial_status,shipping_address,line_items`;

  for (let page = 1; page <= 40; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const orders = body.orders || [];
      if (orders.length === 0) break;

      for (const o of orders) {
        if (o.financial_status === 'refunded' || o.financial_status === 'voided') continue;
        const rawCountry = (o.shipping_address?.country_code || o.shipping_address?.country || '').toString().trim();
        if (!rawCountry) continue;
        const country = rawCountry.length === 2 ? rawCountry.toUpperCase() : rawCountry;
        if (!openDemand[country]) openDemand[country] = {};
        for (const li of (o.line_items || [])) {
          if (!li.sku) continue;
          const qty = Number(li.fulfillable_quantity ?? li.current_quantity ?? li.quantity ?? 0);
          if (qty <= 0) continue;
          openDemand[country][li.sku] = (openDemand[country][li.sku] || 0) + qty;
        }
      }

      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) {
      console.error(`Shopify open demand ${storeKey} error:`, e.message);
      break;
    }
  }

  return openDemand;
}

// ===== SHOPIFY: FETCH INVENTORY LEVELS =====
async function fetchShopifyInventory(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) { console.log('ShopifyInv: no store/token for ' + storeKey); return {}; }
  
  console.log('ShopifyInv: fetching from ' + store.domain);
  const inventory = {};
  let url = `/admin/api/2026-01/products.json?limit=250&fields=id,status,variants`;
  
  for (let page = 1; page <= 20; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const products = body.products || [];
      if (products.length === 0) break;
      
      for (const p of products) {
        const pStatus = p.status || 'active';
        for (const v of (p.variants || [])) {
          if (v.sku) {
            // Sum inventory when same SKU appears on multiple products (e.g. combo pre-orders)
            inventory[v.sku] = (inventory[v.sku] || 0) + (v.inventory_quantity || 0);
            // Track inactive SKUs

          }
        }
      }
      
      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) { console.error(`Shopify inventory ${storeKey} error:`, e.message); break; }
  }
  const realSkus = Object.keys(inventory).filter(k => !k.startsWith('__'));
  console.log('ShopifyInv ' + storeKey + ': ' + realSkus.length + ' SKUs fetched');
  return inventory;
}

// ===== FULL DATA REFRESH =====
async function refreshAllData(forceCin7 = false) {
  if (refreshPromise) {
    console.log('Refresh already in progress — reusing existing run');
    return refreshPromise;
  }

  refreshPromise = (async () => {
    console.log('Starting full data refresh...');
    const start = Date.now();
    
    try {
      const [lifelyVel, cushieVel, lifelyInv, cushieInv, lifelyOpenDemand, cushieOpenDemand] = await Promise.all([
        fetchShopifyVelocity('lifely'),
        fetchShopifyVelocity('cushie'),
        fetchShopifyInventory('lifely'),
        fetchShopifyInventory('cushie'),
        fetchShopifyOpenDemand('lifely'),
        fetchShopifyOpenDemand('cushie')
      ]);

      let cin7Products = {};
      let cin7StockByBranch = {};
      let cin7POs = [];
      let fetchedCin7Count = 0;
      let fetchedPoCount = 0;
      const cin7SkipReason = getCin7SkipReason(forceCin7);

      if (cin7SkipReason) {
        console.log(`Skipping CIN7 refresh, ${cin7SkipReason}. Reusing cached CIN7 data.`);
      } else {
        const cin7Data = await fetchCin7AllProducts();
        cin7Products = cin7Data.products || {};
        cin7StockByBranch = cin7Data.stockByBranch || {};
        cin7POs = await fetchCin7POs();
        fetchedCin7Count = Object.keys(cin7Products).length;
        fetchedPoCount = cin7POs.length;
      }

      let updated = false;

      if (fetchedCin7Count > 0) {
        dataCache.cin7Products = cin7Products;
        dataCache.cin7StockByBranch = cin7StockByBranch;
        dataCache.lastCin7Refresh = new Date().toISOString();
        cin7BackoffUntil = 0;
        if (cin7RecoveryTimer) {
          clearTimeout(cin7RecoveryTimer);
          cin7RecoveryTimer = null;
        }
        updated = true;
      } else if (Object.keys(dataCache.cin7Products).length > 0) {
        console.warn(`CIN7 products returned empty — preserving existing cache (${Object.keys(dataCache.cin7Products).length} SKUs)`);
      }

      if (fetchedPoCount > 0) {
        dataCache.cin7POs = mergeCin7POsByReference(cin7POs);
        dataCache.lastCin7Refresh = new Date().toISOString();
        savePoSnapshot(true, 'daily-cin7-refresh');
        updated = true;
      } else if (dataCache.cin7POs.length > 0) {
        console.warn(`CIN7 POs returned empty — preserving existing cache (${dataCache.cin7POs.length} POs)`);
      }

      if (Object.keys(lifelyVel).length > 0 || Object.keys(cushieVel).length > 0) {
        dataCache.shopifyVelocity = { lifely: lifelyVel, cushie: cushieVel };
        updated = true;
      } else if (Object.keys(dataCache.shopifyVelocity).length > 0) {
        console.warn('Shopify velocity returned empty — preserving existing cache');
      }

      if (Object.keys(lifelyInv).length > 0 || Object.keys(cushieInv).length > 0) {
        dataCache.shopifyInventory = { lifely: lifelyInv, cushie: cushieInv };
        updated = true;
      } else if (Object.keys(dataCache.shopifyInventory).length > 0) {
        console.warn('Shopify inventory returned empty — preserving existing cache');
      }

      if (Object.keys(lifelyOpenDemand).length > 0 || Object.keys(cushieOpenDemand).length > 0) {
        dataCache.shopifyOpenDemand = { lifely: lifelyOpenDemand, cushie: cushieOpenDemand };
        updated = true;
      } else if (Object.keys(dataCache.shopifyOpenDemand || {}).length > 0) {
        console.warn('Shopify open demand returned empty — preserving existing cache');
      }

      if (updated) {
        dataCache.lastRefresh = new Date().toISOString();
        const liveCin7Count = Object.keys(dataCache.cin7Products).length;
        dataCache.error = liveCin7Count > 0 ? null : 'CIN7 data unavailable (likely rate limited)';
        if (liveCin7Count > 0) saveCacheSnapshot(true, 'daily-cin7-refresh');
        if (dataCache.cin7POs.length > 0) savePoSnapshot(true, 'daily-cin7-refresh');
        refreshAIS(); // Update vessel tracking after data refresh
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const liveCin7Count = Object.keys(dataCache.cin7Products).length;
      const livePoCount = dataCache.cin7POs.length;
      console.log(`Data refresh complete in ${elapsed}s. Fetched CIN7: ${fetchedCin7Count} SKUs, ${fetchedPoCount} POs. Live cache: ${liveCin7Count} SKUs, ${livePoCount} POs.`);
    } catch (e) {
      console.error('Data refresh failed:', e.message);
      dataCache.error = e.message;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ===== SKU NORMALIZATION =====
// CIN7 tracks multi-box products as SKU-1, SKU-2 etc.
// Shopify and sales use the base SKU. We need to merge box variants.
function normalizeCIN7(cin7Raw) {
  const result = {};
  const boxPattern = /^(.+)-(\d)$/;
  const boxGroups = {};
  
  for (const [sku, data] of Object.entries(cin7Raw)) {
    const match = sku.match(boxPattern);
    if (match) {
      const base = match[1];
      if (!boxGroups[base]) boxGroups[base] = [];
      boxGroups[base].push(data);
    } else {
      // Non-box SKU — keep as-is
      result[sku] = data;
    }
  }
  
  // For box-split products, buildable = min across all boxes
  for (const [base, boxes] of Object.entries(boxGroups)) {
    const soh = Math.min(...boxes.map(b => typeof b === 'object' ? b.soh : b));
    const available = Math.min(...boxes.map(b => typeof b === 'object' ? (b.available || b.soh) : b));
    // Sum costs across all boxes (each box is a separate shipped piece)
    const costAUD = boxes.reduce((sum, b) => sum + (typeof b === 'object' ? (b.costAUD || 0) : 0), 0);
    const cbm = boxes.reduce((sum, b) => sum + (typeof b === 'object' ? (b.cbm || 0) : 0), 0);
    result[base] = { soh, available, costAUD, cbm };
  }
  
  return result;
}

// Radiant: map component SKUs to set SKUs
// Swatch Pack: LLAU-CB-CS-PACK = 1× each swatch colour (6 swatches)
// CIN7 tracks individual swatches: LLAU-CB-CS-{colour}
// PACK SOH = min(all swatch SOH), cost = sum(all swatch costs)
// Individual swatches inherit PACK velocity (they're only sold as a set)
const SWATCH_COLOURS = ['DSBL', 'DGY', 'PST', 'BABL', 'CTCN', 'MSM'];
function normalizeSwatchPack(cin7) {
  const result = { ...cin7 };
  const swatchKeys = SWATCH_COLOURS.map(c => 'LLAU-CB-CS-' + c);
  const sohValues = swatchKeys.map(k => {
    const d = cin7[k];
    return typeof d === 'object' ? (d.soh || 0) : (d || 0);
  });
  const costs = swatchKeys.map(k => {
    const d = cin7[k];
    return typeof d === 'object' ? (d.costAUD || 0) : 0;
  });
  const packSoh = Math.min(...sohValues);
  const packCost = costs.reduce((a, b) => a + b, 0);
  result['LLAU-CB-CS-PACK'] = { soh: packSoh, available: packSoh, costAUD: packCost };
  return result;
}

// Shopify sells: RDNT-{size}-{type}-SET (e.g. RDNT-Q-MF-SET)
// CIN7 tracks: RDNT-{size}-{type} (e.g. RDNT-Q-MF) + RDNT-{size}-BASE
// A SET = BASE + topper. Buildable = min(BASE, topper)
function normalizeRadiant(cin7, shopifySkus) {
  const result = {};
  // Preserve raw RDNT component SKUs so POs and drilldown can resolve them.
  // SET keys are added alongside and used for display/reorder.
  for (const [sku, data] of Object.entries(cin7)) {
    if (sku.startsWith('RDNT-')) result[sku] = data;
  }
  const sizes = ['D', 'K', 'Q'];
  const types = ['S', 'MF', 'F'];
  
  for (const size of sizes) {
    const baseKey = 'RDNT-' + size + '-BASE';
    const baseSoh = cin7[baseKey]?.soh || cin7[baseKey] || 0;
    
    for (const type of types) {
      const compKey = 'RDNT-' + size + '-' + type;
      const setKey = compKey + '-SET';
      const compSoh = cin7[compKey]?.soh || cin7[compKey] || 0;
      
      // Single topper set
      const baseCost = cin7[baseKey]?.costAUD || 0;
      const compCost = cin7[compKey]?.costAUD || 0;
      const baseCbm = cin7[baseKey]?.cbm || 0;
      const compCbm = cin7[compKey]?.cbm || 0;
      result[setKey] = { soh: Math.min(baseSoh, compSoh), available: Math.min(baseSoh, compSoh), costAUD: baseCost + compCost, cbm: baseCbm + compCbm };
      
      // Multi-topper combos (e.g. RDNT-Q-S-MF-SET = BASE + S + MF)
      for (const type2 of types) {
        if (type2 <= type) continue; // avoid duplicates
        const comp2Key = 'RDNT-' + size + '-' + type2;
        const comboSetKey = 'RDNT-' + size + '-' + type + '-' + type2 + '-SET';
        const comp2Soh = cin7[comp2Key]?.soh || cin7[comp2Key] || 0;
        const comp2Cost = cin7[comp2Key]?.costAUD || 0;
        const comp2Cbm = cin7[comp2Key]?.cbm || 0;
        result[comboSetKey] = { soh: Math.min(baseSoh, compSoh, comp2Soh), available: Math.min(baseSoh, compSoh, comp2Soh), costAUD: baseCost + compCost + comp2Cost, cbm: baseCbm + compCbm + comp2Cbm };
      }
    }
    
    // Protector
    const protKey = 'RDNT-PROT-' + size;
    if (cin7[protKey]) {
      result[protKey] = cin7[protKey];
    }
  }
  
  return result;
}

// Cushie: normalize AU SKUs
// CIN7: CUSB-Q-LTGN-1, CUSB-Q-LTGN-2 (box split) + CUSB-ARST-SET-LTGN (armrest sets)
// Shopify: CUSB-Q-LTGN-SET, CUSB-D-LTGN-SET etc.
function normalizeCushie(cin7Normalized) {
  const result = {};
  for (const [sku, data] of Object.entries(cin7Normalized)) {
    // Map CUSB-Q-LTGN -> CUSB-Q-LTGN-SET for Shopify matching
    if (sku.match(/^CUSB-(TW|D|Q|K)-(LTGN|DNM|TBRN|TWHT)$/) && !sku.includes('-SET')) {
      // Carry cost from base to SET
      const setData = typeof data === 'object' ? {...data} : {soh: data, available: data};
      if (!setData.costAUD && typeof data === 'object') setData.costAUD = data.costAUD || 0;
      result[sku + '-SET'] = setData;
    }
    result[sku] = data;
  }
  return result;
}


// ===== BUILD CK DATA FROM CACHE =====
function buildCKData(ckId) {
  const def = CK_DEFS[ckId];
  if (!def) return null;
  
  const prefix = def.prefix;
  const storeKey = def.store;
  const filter = def.filter || (() => true);
  const excludeCV = def.excludeCV || false;
  const poDestination = def.poDestination || null;
  const stockBranches = def.stockBranches || null;
  const strictStockBranches = def.strictStockBranches || false;
  
  let costs = {};
  // CIN7 stock — first collect raw, then normalize
  const cin7Raw = {};
  for (const [sku, data] of Object.entries(dataCache.cin7Products)) {
    if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
      if (excludeCV && sku.includes('-CV')) continue;
      if (stockBranches && Array.isArray(stockBranches)) {
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = stockBranches.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.available += Number(row.available || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, matched: 0 });
        cin7Raw[sku] = branchData.matched > 0
          ? { ...data, soh: branchData.soh, available: branchData.available }
          : (strictStockBranches ? { ...data, soh: 0, available: 0 } : data);
      } else {
        cin7Raw[sku] = data;
      }
    }
  }
  
  // Normalize: merge box-splits, map components to sets
  let cin7Normalized = normalizeCIN7(cin7Raw);
  
  // Special handling per CK
  if (ckId.startsWith('rdnt')) cin7Normalized = normalizeRadiant(cin7Normalized, Object.keys(dataCache.shopifyInventory[storeKey] || {}));
  if (ckId.startsWith('cusb')) cin7Normalized = normalizeCushie(cin7Normalized);
  if (ckId === 'llau-cb') cin7Normalized = normalizeSwatchPack(cin7Normalized);
  
  const cin7 = {};
  const cin7Available = {};
  let cbmMap = {};
  for (const [sku, data] of Object.entries(cin7Normalized)) {
    cin7[sku] = typeof data === 'object' ? data.soh : data;
      if (typeof data === 'object') {
        cin7Available[sku] = Number(data.available || 0);
      }
      if (typeof data === 'object' && data.costAUD) {
        if (!costs) costs = {};
        costs[sku] = data.costAUD;
      }
      if (typeof data === 'object' && data.cbm > 0) {
        cbmMap[sku] = data.cbm;
      }
  }
  
  // Shopify inventory
  const shopify = {};
  const storeInv = dataCache.shopifyInventory[storeKey] || {};
  for (const [sku, qty] of Object.entries(storeInv)) {
    if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
      if (excludeCV && sku.includes('-CV')) continue;
      
      
      shopify[sku] = qty;
    }
  }

  // LL NZ / US / CA / UK use Shopify open demand split by shipping country as the preorder source of truth.
  // This avoids mixing regional demand and avoids relying on legacy negative Shopify inventory for preorder commitments.
  if (ckId === 'llnz' || ckId === 'llna' || ckId === 'llca' || ckId === 'lluk') {
    const demandCountry = ckId === 'llca'
      ? 'CA'
      : (ckId === 'llnz'
        ? 'NZ'
        : (ckId === 'lluk' ? 'GB' : 'US'));
    const openDemand = dataCache.shopifyOpenDemand?.[storeKey]?.[demandCountry] || dataCache.shopifyOpenDemand?.[storeKey]?.['United Kingdom'] || {};
    for (const sku of Object.keys(cin7)) {
      shopify[sku] = -Number(openDemand[sku] || 0);
    }
  }
  
  // Velocity
  const velocity = {};
  const storeVel = dataCache.shopifyVelocity[storeKey] || {};
  for (const [sku, vel] of Object.entries(storeVel)) {
    if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
      if (excludeCV && sku.includes('-CV')) continue;
      
      
      velocity[sku] = vel;
    }
  }
  
  // Swatch pack: propagate PACK velocity to individual swatches
  if (ckId === 'llau-cb' && velocity['LLAU-CB-CS-PACK']) {
    const packVel = velocity['LLAU-CB-CS-PACK'];
    for (const colour of SWATCH_COLOURS) {
      const swatchKey = 'LLAU-CB-CS-' + colour;
      if (cin7[swatchKey] !== undefined) {
        velocity[swatchKey] = packVel; // each swatch consumed at pack rate
      }
    }
  }

  // Purchase Orders (open = for incoming calculations, all = for PO tab)
  const pos = [];
  const allPos = [];
  for (const po of dataCache.cin7POs) {
    if (poDestination && resolvePoDestination(po) !== poDestination) continue;
    const relevantItems = {};
    for (const [sku, qty] of Object.entries(po.items)) {
      if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
        if (excludeCV && sku.includes('-CV')) continue;
        relevantItems[sku] = qty;
      }
    }
    if (Object.keys(relevantItems).length > 0) {
      allPos.push({ ...po, items: relevantItems });
      if (po.stage !== 'Received') {
        pos.push({ ...po, items: relevantItems });
      }
    }
  }
  
  // Build human-readable names from SKU
  const names = {};
  const allSkus = new Set([...Object.keys(cin7), ...Object.keys(velocity), ...Object.keys(shopify)]);
  for (const sku of allSkus) {
    names[sku] = sku; // Default to SKU code; frontend can prettify
  }
  
  // BOM explosion for combos — component-level planning
  let bomData = null;
  if (ckId === 'llau-cbcf') {
    bomData = {};
    const allCin7 = dataCache.cin7Products;
    const lifelyShopify = dataCache.shopifyInventory?.lifely || {};
    const lifelyVelocity = dataCache.shopifyVelocity?.lifely || {};
    
    // Get all combo SKUs
    const comboSkus = [...new Set([...Object.keys(velocity), ...Object.keys(cin7)])];
    
    // Component-level aggregation
    const components = {};
    
    // Get incoming POs for components
    const componentIncoming = {};
    for (const po of dataCache.cin7POs) {
      if (po.stage === 'Received') continue;
      for (const [sku, qty] of Object.entries(po.items || {})) {
        if (sku.startsWith('LLAU-CB-') && !sku.includes('CBCF')) {
          componentIncoming[sku] = (componentIncoming[sku] || 0) + qty;
        }
        if (sku.startsWith('DD-21')) {
          componentIncoming[sku] = (componentIncoming[sku] || 0) + qty;
        }
      }
    }
    
    for (const comboSku of comboSkus) {
      const bom = explodeComboBOM(comboSku);
      if (!bom) continue;
      
      const comboVel = velocity[comboSku] || 0;
      
      // Bed component
      if (!components[bom.bed]) {
        const bedData = allCin7[bom.bed] || {};
        const bedSoh = typeof bedData === 'object' ? (bedData.soh || 0) : (bedData || 0);
        const standaloneVel = lifelyVelocity[bom.bed] || 0;
        const shopifyInv = lifelyShopify[bom.bed] || 0;
        // Decompose oversold: standalone oversold from Shopify
        const standaloneOversold = Math.min(shopifyInv, 0);
        components[bom.bed] = {
          soh: bedSoh,
          standaloneDemand: standaloneVel,
          comboDemand: 0,
          totalDemand: standaloneVel,
          incoming: componentIncoming[bom.bed] || 0,
          shopifyInv: shopifyInv,
          standaloneOversold: standaloneOversold,
          comboOversold: 0,
          combos: [],
          type: 'bed',
          size: getComboSize(comboSku)
        };
      }
      components[bom.bed].comboDemand += comboVel * bom.bedQty;
      components[bom.bed].totalDemand = components[bom.bed].standaloneDemand + components[bom.bed].comboDemand;
      // Combo oversold: from combo Shopify inventory
      const comboShopifyInv = lifelyShopify[comboSku] || 0;
      if (comboShopifyInv < 0) {
        components[bom.bed].comboOversold += comboShopifyInv;
      }
      components[bom.bed].combos.push(comboSku);
      
      // Mattress component (dedicated to combos — 0 standalone demand)
      if (!components[bom.mattress]) {
        const mattData = allCin7[bom.mattress] || {};
        const mattSoh = typeof mattData === 'object' ? (mattData.soh || 0) : (mattData || 0);
        components[bom.mattress] = {
          soh: mattSoh,
          standaloneDemand: 0, // Never sold standalone
          comboDemand: 0,
          totalDemand: 0,
          incoming: componentIncoming[bom.mattress] || 0,
          shopifyInv: lifelyShopify[bom.mattress] || 0,
          standaloneOversold: 0,
          comboOversold: 0,
          combos: [],
          type: 'mattress',
          size: getComboSize(comboSku)
        };
      }
      components[bom.mattress].comboDemand += comboVel * bom.mattressQty;
      components[bom.mattress].totalDemand = components[bom.mattress].comboDemand; // 100% combo
      components[bom.mattress].combos.push(comboSku);
    }
    
    // Calculate per-size bundle ATP and binding constraints
    const sizeData = {}; // S, KS, D
    for (const size of ['S', 'KS', 'D']) {
      const mattressSku = COMBO_BOM.mattress[size];
      const matt = components[mattressSku];
      const beds = Object.entries(components).filter(([k,v]) => v.type === 'bed' && v.size === size);
      
      // Total bed available for this size = sum of all colour bed SOH
      const totalBedSOH = beds.reduce((t, [k,v]) => t + v.soh, 0);
      const totalBedIncoming = beds.reduce((t, [k,v]) => t + v.incoming, 0);
      const totalBedDemand = beds.reduce((t, [k,v]) => t + v.totalDemand, 0);
      const totalBedOversold = beds.reduce((t, [k,v]) => t + v.standaloneOversold + v.comboOversold, 0);
      
      const mattSOH = matt ? matt.soh : 0;
      const mattIncoming = matt ? matt.incoming : 0;
      const mattDemand = matt ? matt.totalDemand : 0;
      
      const bedWks = totalBedDemand > 0 ? totalBedSOH / totalBedDemand : 99;
      const mattWks = mattDemand > 0 ? mattSOH / mattDemand : 99;
      const comboATP = Math.min(totalBedSOH, mattSOH);
      const constraint = bedWks <= mattWks ? 'bed' : 'mattress';
      
      sizeData[size] = {
        totalBedSOH, totalBedIncoming, totalBedDemand, totalBedOversold,
        mattSOH, mattIncoming, mattDemand, mattressSku,
        bedWks: Math.round(bedWks * 10) / 10,
        mattWks: Math.round(mattWks * 10) / 10,
        comboATP,
        constraint,
        beds: Object.fromEntries(beds)
      };
    }
    
    bomData._components = components;
    bomData._sizeData = sizeData;
    bomData._componentIncoming = componentIncoming;
  }

  // Remove inactive Shopify SKUs (draft/archived)
  const inactiveList = (dataCache.shopifyInventory?.[storeKey]?.['__inactive__']) || [];
  const inactiveSet = new Set(inactiveList);
  for (const sku of Object.keys(cin7)) {
    if (inactiveSet.has(sku)) { delete cin7[sku]; delete velocity[sku]; delete shopify[sku]; }
  }
  for (const sku of Object.keys(velocity)) {
    if (inactiveSet.has(sku)) { delete velocity[sku]; }
  }

  // === Per-SKU landed cost calculation ===
  // Source 1: Excel report (SOH Stock Value / SOH Stock Qty) = actual landed cost for existing stock
  // Source 2: CBM-based freight estimation for incoming POs
  // Skip swatches, covers, protectors — only main CK products
  const SKIP_LANDED = sku => /(-CV-|-CV$|-CS-|-CS$|-FS-|PROTECTOR|SWATCH|PACK$|SAMPLE)/i.test(sku);
  const landedCosts = {};
  
  // Step 1: Load actual landed costs from Excel for all matching SKUs
  for (const sku of Object.keys(cin7)) {
    if (SKIP_LANDED(sku)) continue;
    const fob = (costs ? costs[sku] : 0) || 0;
    const xl = excelLandedCosts[sku];
    if (xl && xl.landedPerUnit > 0) {
      const freightTariff = Math.max(0, xl.landedPerUnit - fob);
      landedCosts[sku] = {
        fob,
        freightPerUnit: freightTariff,
        tariffPerUnit: 0, // combined in freightPerUnit since Excel doesn't split them
        landedPerUnit: xl.landedPerUnit,
        cbm: cbmMap[sku] || 0,
        source: 'actual',
        sohQty: xl.sohQty,
        sohValue: xl.sohValue
      };
    }
  }
  
  // Step 2: For SKUs NOT in Excel, use CBM-based estimation from open POs
  for (const po of allPos) {
    if (po.stage === 'Received') continue;
    const destination = inferDestination(po);
    const landed = estimateLandedCost(po, destination);
    const containerFreight = landed.freight || 0;
    const tariffRate = landed.tariffRate || 0;
    
    // Calculate total CBM for this PO
    let totalPoCbm = 0;
    const skuItems = Object.entries(po.items || {});
    for (const [sku, qty] of skuItems) {
      if (!SKIP_LANDED(sku) && cbmMap[sku]) {
        totalPoCbm += cbmMap[sku] * qty;
      }
    }
    
    if (totalPoCbm <= 0 || containerFreight <= 0) continue;
    
    // Allocate freight to each SKU by its CBM share (only for SKUs without Excel data)
    for (const [sku, qty] of skuItems) {
      if (SKIP_LANDED(sku) || !cbmMap[sku]) continue;
      if (landedCosts[sku]?.source === 'actual') continue; // Already have real data
      
      const skuCbm = cbmMap[sku];
      const cbmShare = (skuCbm * qty) / totalPoCbm;
      const freightForSku = containerFreight * cbmShare / qty; // per unit
      const fob = (costs ? costs[sku] : 0) || 0;
      const tariffPerUnit = fob * tariffRate;
      const landedPerUnit = fob + freightForSku + tariffPerUnit;
      
      if (!landedCosts[sku]) {
        landedCosts[sku] = { fob, freightPerUnit: freightForSku, tariffPerUnit, landedPerUnit, cbm: skuCbm, source: 'estimated', poCount: 1 };
      } else {
        const lc = landedCosts[sku];
        lc.freightPerUnit = (lc.freightPerUnit * lc.poCount + freightForSku) / (lc.poCount + 1);
        lc.tariffPerUnit = (lc.tariffPerUnit * lc.poCount + tariffPerUnit) / (lc.poCount + 1);
        lc.landedPerUnit = lc.fob + lc.freightPerUnit + lc.tariffPerUnit;
        lc.poCount++;
      }
    }
  }
  
  return {
    ck: def,
    cin7,
    shopify,
    velocity,
    pos,
    allPos,
    names,
    sizes: def.sizes,
    costs,
    cbmMap,
    landedCosts,
    trendData: (() => {
      const vel = dataCache.shopifyVelocity?.[storeKey] || {};
      const d7 = vel._7d || {};
      const d30 = vel._30d || {};
      const firstSeen = vel._firstSeen || {};
      const weekly = vel._weeklyBreakdown || {};
      const result = {};
      const allSkus = [...new Set([...Object.keys(cin7), ...Object.keys(velocity)])];
      for (const sku of allSkus) {
        const v7 = (d7[sku] || 0) / 7 * 7; // weekly rate from 7d
        const v30 = (d30[sku] || 0) / 30 * 7; // weekly rate from 30d
        // Last 5 weeks sparkline
        const wk = weekly[sku] || {};
        const weekKeys = Object.keys(wk).sort().slice(-5);
        const sparkline = weekKeys.map(k => wk[k] || 0);
        // Last in-stock velocity: avg of last 4 weeks that had sales
        const allWeekKeys = Object.keys(wk).sort();
        const weeksWithSales = allWeekKeys.filter(k => wk[k] > 0);
        let lastInStockVel = null;
        if (weeksWithSales.length >= 2) {
          const lastActive = weeksWithSales.slice(-4);
          const avgSales = lastActive.reduce((t, k) => t + wk[k], 0) / lastActive.length;
          lastInStockVel = Math.round(avgSales * 10) / 10;
        }
        result[sku] = { v7: Math.round(v7*10)/10, v30: Math.round(v30*10)/10, sparkline, firstSeen: firstSeen[sku] || null, lastInStockVel };
      }
      return result;
    })(),
    bomData,
    weeklyData: (() => {
      const weekly = dataCache.shopifyVelocity?.[storeKey]?._weeklyBreakdown || {};
      const result = {};
      const allSkus = [...new Set([...Object.keys(cin7), ...Object.keys(velocity)])];
      for (const sku of allSkus) {
        if (weekly[sku]) result[sku] = weekly[sku];
      }
      return Object.keys(result).length > 0 ? result : null;
    })(),
    lastRefresh: dataCache.lastRefresh
  };
}

// ===== ROUTES =====

// Login
app.post('/api/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    const session = createSession();
    res.json({ ok: true, session });
  } else {
    res.json({ ok: false });
  }
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Public assets
app.use('/logos', express.static(path.join(__dirname, 'public', 'logos')));
app.use('/login', express.static(path.join(__dirname, 'public')));

// CK list
app.get('/api/ck-list', requireAuth, (req, res) => {
  const list = Object.entries(CK_DEFS).map(([id, def]) => {
    const data = buildCKData(id);
    const skuCount = data ? Object.keys(data.cin7).length + Object.keys(data.velocity).length : 0;
    return { id, name: def.name, logo: def.logo, skuCount };
  });
  res.json({ list, lastRefresh: dataCache.lastRefresh });
});

// CK data
// Infer destination from CIN7 deliveryCountry, port, or SKU prefixes
const PORT_TO_DEST = {
  'melbourne': 'Australia',
  'sydney': 'Australia',
  'brisbane': 'Australia',
  'toronto': 'Canada',
  'vancouver': 'Canada',
  'felixstowe': 'United Kingdom',
  'southampton': 'United Kingdom',
  'la': 'United States',
  'ny': 'United States',
  'los angeles': 'United States',
  'new york': 'United States',
  'long beach': 'United States',
  'savannah': 'United States',
  'singapore': 'Singapore',
  'auckland': 'New Zealand',
  'tauranga': 'New Zealand',
};
function inferDestination(po) {
  // 1. CIN7 deliveryCountry if filled
  if (po.deliveryCountry) return po.deliveryCountry;
  // 2. Port mapping
  if (po.port) {
    const portLower = po.port.toLowerCase().trim();
    if (PORT_TO_DEST[portLower]) return PORT_TO_DEST[portLower];
  }
  // 3. Delivery city mapping (e.g. Laverton North = Melbourne warehouse = Australia)
  if (po.deliveryCity) {
    const cityLower = po.deliveryCity.toLowerCase().trim();
    if (['laverton north', 'laverton', 'truganina', 'derrimut', 'altona', 'footscray'].includes(cityLower)) return 'Australia';
  }
  // 4. SKU prefix inference
  const skus = Object.keys(po.items || {});
  const dests = new Set();
  for (const sku of skus) {
    const u = sku.toUpperCase();
    if (u.startsWith('LLSG')) dests.add('Singapore');
    else if (u.match(/^(LFSB|CUSB).*-UK/)) dests.add('United Kingdom');
    else if (u.match(/^(V2-|V3-)/)) dests.add('United States');
    else if (u.match(/^LLNA/)) dests.add('United States');
    else if (u.match(/^(LLAU|DD|COCOON|RDNT|WFHCR|CMSS|LIFELY|LFSB|CUSB)/)) dests.add('Australia');
  }
  if (dests.size === 1) return [...dests][0];
  if (dests.size > 1) return [...dests].join(' / ');
  // 5. Fallback: all remaining unmatched POs go to Australia (Melbourne port)
  return 'Australia';
}

// Estimated freight + tariff by destination (from yk's shipping data)
const FREIGHT_TARIFF = {
  'United States':  { freight: 8404, freightCurrency: 'AUD', tariff: 0.19, tariffNote: '19% US tariff' },
  'Canada':         { freight: 8404, freightCurrency: 'AUD', tariff: 0.08, tariffNote: '~8% MFN (⚠️ 188% if upholstered seating)' },
  'United Kingdom': { freight: 7245, freightCurrency: 'AUD', tariff: 0,    tariffNote: '' },
  'Australia':      { freight: 7000, freightCurrency: 'AUD', tariff: 0,    tariffNote: '' },
  'Singapore':      { freight: 2898, freightCurrency: 'AUD', tariff: 0,    tariffNote: '0% (free trade)' },
  'New Zealand':    { freight: 2898, freightCurrency: 'AUD', tariff: 0,    tariffNote: '' },
};

function estimateLandedCost(po, destination) {
  const freightActual = po.freightTotal > 0 ? po.freightTotal : 0;
  const productValue = po.total || 0;
  const dest = FREIGHT_TARIFF[destination];
  const isEstimated = freightActual === 0;
  const freight = freightActual > 0 ? freightActual : (dest ? dest.freight : 0);
  const freightCurrency = freightActual > 0 ? (po.currencyCode || 'USD') : (dest ? dest.freightCurrency : 'USD');
  const tariffRate = dest ? dest.tariff : 0;
  const tariffAmount = productValue * tariffRate;
  const tariffNote = dest ? dest.tariffNote : '';
  return { freight, freightCurrency, tariffRate, tariffAmount, tariffNote, isEstimated, landedTotal: productValue + freight + tariffAmount };
}

// PO Data Quality Score
function scorePO(po) {
  const isInTransitOrReceived = po.stage === 'Received' || (po.etd && po.estimatedArrivalDate && new Date(po.etd) <= new Date() && (po.stage !== 'Draft' && po.stage !== 'Confirmed'));
  const isReceived = po.stage === 'Received';
  
  let score = 0;
  let maxScore = 0;
  const checks = [];
  
  // Always evaluated
  const addCheck = (name, points, filled) => { maxScore += points; if (filled) score += points; checks.push({ name, points, filled }); };
  
  addCheck('Created By', 5, !!po.createdBy);
  addCheck('ETA', 20, !!(po.estimatedArrivalDate || po.arrival));
  addCheck('Original ETA', 15, !!(po.customFields?.orders_1000));
  addCheck('ETD', 15, !!po.etd);
  addCheck('Port', 10, !!po.port);
  
  // Tracking code: only if in transit or received
  if (isInTransitOrReceived) {
    addCheck('Tracking Code', 15, !!po.trackingCode);
  }
  
  // Landed costs: check if freightTotal > 0 (actual landed cost entered)
  addCheck('Landed Costs', 10, po.freightTotal > 0);
  
  // Received-only checks
  if (isReceived) {
    addCheck('Fully Received Date', 5, !!po.fullyReceivedDate);
    addCheck('Invoice Date', 5, !!po.invoiceDate);
    addCheck('Supplier Inv No', 5, !!po.supplierInvoiceReference);
  }
  
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return { score, maxScore, pct, checks };
}

app.get('/api/all-pos', requireAuth, (req, res) => {
  const pos = dataCache.cin7POs.map(po => {
    const destination = inferDestination(po);
    const landed = estimateLandedCost(po, destination);
    const quality = scorePO(po);
    return {
      reference: po.reference,
      stage: po.stage || '',
      company: po.company || '',
      arrival: po.arrival || null,
      etd: po.etd || null,
      estimatedArrivalDate: po.estimatedArrivalDate || null,
      customFields: po.customFields || {},
      trackingCode: po.trackingCode || '',
      fullyReceivedDate: po.fullyReceivedDate || null,
      total: po.total || 0,
      currencyCode: po.currencyCode || 'USD',
      deliveryCountry: destination,
      freight: landed.freight,
      freightCurrency: landed.freightCurrency,
      tariffRate: landed.tariffRate,
      tariffAmount: landed.tariffAmount,
      tariffNote: landed.tariffNote,
      isEstFreight: landed.isEstimated,
      landedTotal: landed.landedTotal,
      createdBy: po.createdBy || null,
      invoiceDate: po.invoiceDate || null,
      supplierInvoiceReference: po.supplierInvoiceReference || '',
      port: po.port || '',
      freightTotal: po.freightTotal || 0,
      quality,
      items: po.items || {}
    };
  });
  res.json({ pos, lastRefresh: dataCache.lastRefresh, fx: { USDAUD: fxRate.USDAUD, lastFetch: fxRate.lastFetch } });
});

app.get('/api/ck/:id', requireAuth, (req, res) => {
  const data = buildCKData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Unknown CK' });
  res.json(data);
});

// Manual refresh
let _lastManualRefresh = 0;
app.post('/api/refresh', requireAuth, async (req, res) => {
  const now = Date.now();
  const cooldown = 10 * 60 * 1000; // 10 min cooldown between manual refreshes
  if (now - _lastManualRefresh < cooldown) {
    const waitMin = Math.ceil((cooldown - (now - _lastManualRefresh)) / 60000);
    return res.json({ ok: false, error: `Please wait ${waitMin} min before refreshing again`, lastRefresh: dataCache.lastRefresh });
  }
  _lastManualRefresh = now;
  await refreshAllData(true);
  res.json({ ok: true, lastRefresh: dataCache.lastRefresh });
});

// Chat endpoint
app.post('/api/chat', requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) return res.json({ reply: 'Chat is not configured (no Gemini API key).' });
  
  const { message, history, ckId } = req.body;
  const ckData = ckId ? buildCKData(ckId) : null;
  
  let context = 'You are a demand planning assistant for Lifely. ';
  if (ckData) {
    context += `Currently viewing: ${ckData.ck.name}. `;
    context += `Stock data: ${JSON.stringify(ckData.cin7).substring(0, 2000)}. `;
    context += `Velocity: ${JSON.stringify(ckData.velocity).substring(0, 1000)}. `;
  }
  
  const contents = [
    { role: 'user', parts: [{ text: context }] },
    ...(history || []).slice(-10).map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];
  
  try {
    const postData = JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
    });
    
    const { body } = await apiRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, postData);
    
    const reply = body?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.';
    res.json({ reply });
  } catch (e) {
    res.json({ reply: `Error: ${e.message}` });
  }
});

// ===== SHIPMENT TRACKER =====

// Supplier → origin mapping
const SUPPLIER_ORIGINS = {
  'GUANGDONG EONJOY': { city: 'Guangzhou', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' },
  'EON Technology': { city: 'Foshan', country: 'China', lat: 23.02, lng: 113.12, port: 'Nansha' },
  'FOSHAN EON': { city: 'Foshan', country: 'China', lat: 23.02, lng: 113.12, port: 'Nansha' },
  'Aibang': { city: 'Dongguan', country: 'China', lat: 23.04, lng: 113.72, port: 'Yantian' },
  'Dongguan Aibang': { city: 'Dongguan', country: 'China', lat: 23.04, lng: 113.72, port: 'Yantian' },
  'NOVA FURNITURE': { city: 'Guangzhou', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' },
  'GUANGDONG NOVA': { city: 'Guangzhou', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' },
  'Nobel Home': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
  'Nisco': { city: 'Jiangsu', country: 'China', lat: 32.06, lng: 118.77, port: 'Shanghai' },
  'Shenzhen Ouluo': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
  'VISTATECH': { city: 'Huizhou', country: 'China', lat: 23.11, lng: 114.42, port: 'Yantian' },
  'VISTA CHEN': { city: 'Huizhou', country: 'China', lat: 23.11, lng: 114.42, port: 'Yantian' },
  'Caoxian': { city: 'Heze', country: 'China', lat: 35.24, lng: 115.44, port: 'Qingdao' },
  'Junqi': { city: 'Ganzhou', country: 'China', lat: 25.83, lng: 114.93, port: 'Nansha' },
  'SHIJIAZHUANG': { city: 'Shijiazhuang', country: 'China', lat: 38.04, lng: 114.51, port: 'Tianjin' },
  'Shaoxing': { city: 'Shaoxing', country: 'China', lat: 30.00, lng: 120.58, port: 'Ningbo' },
  'Foshan Jinruili': { city: 'Foshan', country: 'China', lat: 23.02, lng: 113.12, port: 'Nansha' },
  'Windo Living': { city: 'Bangkok', country: 'Thailand', lat: 13.76, lng: 100.50, port: 'Laem Chabang' },
  'CIMC': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
  'makesense': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
};

const DESTINATIONS = {
  'Australia': { city: 'Melbourne', lat: -37.81, lng: 144.96, port: 'Melbourne' },
  'USA':       { city: 'Los Angeles', lat: 33.74, lng: -118.26, port: 'Los Angeles' },
  'Canada':    { city: 'Vancouver', lat: 49.29, lng: -123.11, port: 'Vancouver' },
  'UK':        { city: 'Felixstowe', lat: 51.96, lng: 1.35, port: 'Felixstowe' },
  'NZ':        { city: 'Auckland', lat: -36.84, lng: 174.76, port: 'Auckland' },
  'Singapore': { city: 'Singapore', lat: 1.26, lng: 103.84, port: 'Singapore' },
  'default':   { city: 'Melbourne', lat: -37.81, lng: 144.96, port: 'Melbourne' }
};

// Determine destination from PO reference and SKU prefixes
function getDestination(po) {
  const ref = (po.reference || '').toUpperCase();
  const skus = Object.keys(po.items || {});

  // 1. PO reference prefix takes priority
  if (ref.startsWith('PO-CA'))  return DESTINATIONS['Canada'];
  if (ref.startsWith('PO-US'))  return DESTINATIONS['USA'];
  if (ref.startsWith('PO-UK'))  return DESTINATIONS['UK'];
  if (ref.startsWith('PO-NZ'))  return DESTINATIONS['NZ'];
  if (ref.startsWith('PO-SG'))  return DESTINATIONS['Singapore'];
  if (ref.startsWith('PO-AU'))  return DESTINATIONS['Australia'];

  // 2. Check SKU prefixes — if majority are NA, route to US
  const naCount = skus.filter(s => s.startsWith('LLNA')).length;
  const ukCount = skus.filter(s => s.includes('-UK')).length;
  const sgCount = skus.filter(s => s.startsWith('LLSG')).length;
  const total = skus.length || 1;

  if (naCount / total > 0.5) return DESTINATIONS['USA'];
  if (ukCount / total > 0.5) return DESTINATIONS['UK'];
  if (sgCount / total > 0.5) return DESTINATIONS['Singapore'];

  // 3. Fallback: Australia
  return DESTINATIONS['default'];
}

function getSupplierOrigin(company) {
  if (!company) return { city: 'Unknown', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' };
  for (const [key, origin] of Object.entries(SUPPLIER_ORIGINS)) {
    if (company.toLowerCase().includes(key.toLowerCase())) return origin;
  }
  return { city: 'Unknown', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' };
}

// ===== AIS VESSEL TRACKING =====
const vesselPositions = {}; // { vesselName: { lat, lng, heading, speed, timestamp } }
let aisWs = null;
let aisReconnectTimer = null;
let aisSubscribedVessels = [];

function extractVesselNames() {
  // Extract vessel names from PO tracking codes (format: "CONTAINER / VESSEL" or "CONTAINER/VESSEL")
  const vessels = new Set();
  for (const po of dataCache.cin7POs || []) {
    const tc = po.trackingCode || '';
    // Match "CONTAINER / VESSEL_NAME" or "CONTAINER/VESSEL_NAME"
    const match = tc.match(/[A-Z]{4}\d{6,7}\s*\/\s*(.+)/i);
    if (match) {
      let vesselName = match[1].trim();
      // Remove voyage number suffix (e.g. "/023E")
      vesselName = vesselName.replace(/\/\d+[A-Z]*$/, '').trim();
      if (vesselName.length > 2) vessels.add(vesselName.toUpperCase());
    }
  }
  return Array.from(vessels);
}

function connectAIS() {
  if (!AIS_API_KEY) { console.log('[AIS] No API key, skipping'); return; }
  
  const vessels = extractVesselNames();
  if (vessels.length === 0) { console.log('[AIS] No vessels to track'); return; }
  
  // Don't reconnect if same vessels
  if (aisWs && aisWs.readyState === WebSocket.OPEN && 
      JSON.stringify(aisSubscribedVessels) === JSON.stringify(vessels)) return;
  
  // Close existing
  if (aisWs) { try { aisWs.close(); } catch(e){} }
  
  console.log(`[AIS] Connecting to track ${vessels.length} vessels: ${vessels.join(', ')}`);
  aisSubscribedVessels = vessels;
  // Clear stale positions from previous connection
  Object.keys(vesselPositions).forEach(k => delete vesselPositions[k]);
  
  try {
    aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream');
    
    aisWs.on('open', () => {
      console.log('[AIS] Connected');
      // Subscribe by vessel name
      // Use targeted bounding boxes to reduce stream volume:
      // Box 1: China seas + SE Asia + Indian Ocean (departures & AU route)
      // Box 2: Pacific Ocean (US/CA route)
      // Box 3: Indian Ocean + Suez + Med (UK route)
      aisWs.send(JSON.stringify({
        APIKey: AIS_API_KEY,
        BoundingBoxes: [
          [[-45, 90], [45, 180]],    // China → Australia corridor
          [[20, 120], [50, -120]],   // Trans-Pacific (note: API may not handle antimeridian)
          [[-10, 30], [45, 110]],    // Indian Ocean + Suez + Med
          [[-45, -180], [50, -100]]  // Eastern Pacific / Americas
        ],
        FilterMessageTypes: ['PositionReport']
      }));
    });
    
    // Build a Set of vessel names we're tracking for fast client-side filtering
    // (FilterShipNames API param doesn't actually filter on aisstream)
    const vesselSet = new Set(vessels);
    
    aisWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.MessageType === 'PositionReport' && msg.MetaData) {
          const name = (msg.MetaData.ShipName || '').trim().toUpperCase();
          const pos = msg.Message?.PositionReport;
          // Only cache positions for vessels we're actually tracking
          if (name && pos && vesselSet.has(name)) {
            vesselPositions[name] = {
              lat: pos.Latitude,
              lng: pos.Longitude,
              heading: pos.TrueHeading || 0,
              speed: pos.Sog || 0,
              timestamp: msg.MetaData.time_utc || new Date().toISOString(),
              mmsi: msg.MetaData.MMSI || null
            };
            console.log(`[AIS] ✅ ${name}: ${pos.Latitude.toFixed(3)}, ${pos.Longitude.toFixed(3)} @ ${pos.Sog || 0}kn`);
          }
        }
      } catch(e) { /* ignore parse errors */ }
    });
    
    aisWs.on('close', () => {
      console.log('[AIS] Disconnected, reconnecting in 30s');
      aisReconnectTimer = setTimeout(connectAIS, 30000);
    });
    
    aisWs.on('error', (err) => {
      console.log('[AIS] Error:', err.message);
    });
    
    // AIS stream stays open — aisstream sends updates as vessels report
    // Close after 5 min to save resources, reopen on next data refresh
    setTimeout(() => {
      if (aisWs && aisWs.readyState === WebSocket.OPEN) {
        console.log('[AIS] Closing after 5min cycle');
        aisWs.close();
      }
    }, 5 * 60 * 1000);
    
  } catch(e) {
    console.log('[AIS] Connection failed:', e.message);
  }
}

// Reconnect AIS after each CIN7 data refresh (new POs may have new vessels)
function refreshAIS() {
  if (AIS_API_KEY) connectAIS();
}

function buildShipmentData() {
  const shipments = [];
  const now = new Date();
  
  for (const po of dataCache.cin7POs) {
    // Include active POs (we already filter out Received in fetchCin7POs)
    const origin = getSupplierOrigin(po.company || '');
    const dest = getDestination(po);
    
    // ETD = estimatedDeliveryDate (departure from origin)
    let etd = null;
    if (po.etd) {
      etd = new Date(po.etd);
    }
    
    // Original ETA = customFields.orders_1000 (set when PO created)
    let originalEta = null;
    if (po.customFields?.orders_1000) {
      const cf = po.customFields.orders_1000;
      const parsed = new Date(cf.replace(/(\d+)-(\d+)-(\d+)/, (m, d, mo, y) => {
        return y + '-' + mo.padStart(2,'0') + '-' + d.padStart(2,'0');
      }));
      if (!isNaN(parsed.getTime())) originalEta = parsed;
      if (!originalEta || isNaN(originalEta.getTime())) {
        const direct = new Date(cf);
        if (!isNaN(direct.getTime())) originalEta = direct;
      }
    }

    // Revised ETA = estimatedArrivalDate (updated when shipping info comes in)
    let revisedEta = null;
    if (po.estimatedArrivalDate) {
      revisedEta = new Date(po.estimatedArrivalDate);
      if (isNaN(revisedEta.getTime())) revisedEta = null;
    }

    // ETA for display/calculations: use revised if available, else original
    let eta = revisedEta || originalEta;
    
    // Actual received date
    let receivedDate = null;
    if (po.fullyReceivedDate) {
      receivedDate = new Date(po.fullyReceivedDate);
    }
    
    // ETD already parsed above from estimatedDeliveryDate
    
    // Calculate progress (0-1) and status — unified with PO tab logic
    let progress = 0;
    let status = 'production';
    
    // If it has a received date OR stage is "Received", it's arrived
    if (receivedDate || po.stage === 'Received') {
      progress = 1;
      status = 'arrived';
    } else if (etd && etd <= now) {
      // ETD has passed — shipped. Determine if still in transit or overdue.
      if (eta && eta <= now) {
        // ETA passed but not received — overdue, still show as in_transit on tracker
        progress = 1;
        status = 'in_transit';
      } else if (etd && eta) {
        // Normal in transit: progress based on ETD-ETA window
        const totalDays = (eta - etd) / (24 * 60 * 60 * 1000);
        const elapsedDays = (now - etd) / (24 * 60 * 60 * 1000);
        progress = totalDays > 0 ? Math.min(1, elapsedDays / totalDays) : 0.5;
        status = 'in_transit';
      } else {
        // ETD passed but no ETA — still in transit, unknown progress
        progress = 0.5;
        status = 'in_transit';
      }
    }
    // else: ETD not set or in future — still in production (default)
    
    // Count items
    const totalUnits = Object.values(po.items || {}).reduce((a, b) => a + b, 0);
    const skuCount = Object.keys(po.items || {}).length;
    
    // Days until arrival
    const daysUntil = eta ? Math.ceil((eta - now) / (24 * 60 * 60 * 1000)) : null;
    
    shipments.push({
      reference: po.reference,
      supplier: po.company || 'Unknown',
      status: po.status,
      stage: po.stage || '',
      origin,
      destination: dest,
      etd: etd ? etd.toISOString() : null,
      eta: eta ? eta.toISOString() : null,
      originalEta: originalEta ? originalEta.toISOString() : null,
      revisedEta: revisedEta ? revisedEta.toISOString() : null,
      etaStatus: (originalEta && revisedEta) ? (revisedEta > originalEta ? 'delayed' : revisedEta < originalEta ? 'early' : 'on_time') : null,
      receivedDate: receivedDate ? receivedDate.toISOString() : null,
      daysUntil,
      progress,
      shipmentStatus: status,
      totalUnits,
      skuCount,
      total: po.total || 0,
      currency: po.currencyCode || 'USD',
      items: po.items || {},
      trackingCode: po.trackingCode || null,
      port: po.port || null,
      internalComments: po.internalComments || null,
      vesselPosition: null, // filled below
      vesselName: null
    });
  }
  
  // Attach AIS vessel positions
  for (const s of shipments) {
    if (!s.trackingCode) continue;
    const match = (s.trackingCode || '').match(/[A-Z]{4}\d{6,7}\s*\/\s*(.+)/i);
    if (match) {
      let vn = match[1].trim().replace(/\/\d+[A-Z]*$/, '').trim().toUpperCase();
      s.vesselName = vn;
      if (vesselPositions[vn]) {
        s.vesselPosition = vesselPositions[vn];
      }
    }
  }
  
  return shipments.sort((a, b) => {
    if (!a.eta) return 1;
    if (!b.eta) return -1;
    return new Date(a.eta) - new Date(b.eta);
  });
}

app.get('/api/shipments', requireAuth, (req, res) => {
  res.json({ shipments: buildShipmentData(), lastRefresh: dataCache.lastRefresh });
});

// Serve shipment tracker page
app.get('/tracker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tracker.html')));

// Health check endpoint (no auth needed — used by keep-alive and monitoring)
app.get('/api/health', (req, res) => {
  const cin7Count = Object.keys(dataCache.cin7Products).length;
  const poCount = dataCache.cin7POs.length;
  res.json({ ok: cin7Count > 0, cin7: cin7Count, pos: poCount, lastRefresh: dataCache.lastRefresh, error: dataCache.error || null, uptime: Math.round(process.uptime()) });
});

// Main app
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// ===== START =====
app.listen(PORT, () => {
  console.log(`Demand Planner running on port ${PORT}`);
  refreshAllData(); // Initial fetch
  setInterval(refreshAllData, 24 * 60 * 60 * 1000); // Refresh every 24 hours
  
  // Keep-alive: ping self every 10 min to prevent Render free tier spin-down
  setInterval(() => {
    const url = `http://localhost:${PORT}/api/health`;
    https.get(url, () => {}).on('error', () => {});
    // Also use http since it's localhost
    require('http').get(url, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
});



// ===== INCOMING POs TAB =====
const DD_21CM_SKUS = new Set(['DD-21107CF','DD-21137CF','DD-21153CF','DD-21183CF','DD-21915CF']);

function classifySKU(code, destCountry) {
  const c = (code || '').toUpperCase();
  // NZ uses LLAU- SKUs — check destination first
  if (destCountry === 'NZ' && c.startsWith('LLAU-') && !c.includes('-CV')) return 'LL Beds — NZ';
  if (destCountry === 'NZ' && c.startsWith('LLAU-') && c.includes('-CV')) return 'LL Covers — NZ';
  
  if (c.startsWith('LLAU-CB-') && !c.includes('-CV') && !c.includes('-CS-') && !c.includes('-FS-') && !c.includes('CBCF')) return 'LL Beds — AU';
  if (c.startsWith('LLAU-CB-') && c.includes('-CV')) return 'LL Covers — AU';
  if (c.startsWith('LLAU-CB-CS-') || c.startsWith('LLAU-CB-FS-')) return null; // swatches
  if (c.startsWith('LLNA-CB-') && !c.includes('-CV') && !c.includes('CFDS') && !c.includes('CBCF')) return 'LL Beds — US/CA';
  if (c.startsWith('LLNA-CB-') && c.includes('-CV')) return 'LL Covers — US/CA';
  if (c.startsWith('LLNA-CFDS-') || c.startsWith('LLNA-CBCF-')) return null; // combo sku shouldn't be in POs
  if (c.startsWith('LLUK-CB-') && !c.includes('-CV')) return 'LL Beds — UK';
  if (c.startsWith('LLUK-CB-') && c.includes('-CV')) return 'LL Covers — UK';
  if (c.startsWith('LLSG-') && !c.includes('-CV')) return 'LL Beds — SG';
  if (c.startsWith('LLSG-') && c.includes('-CV')) return 'LL Covers — SG';
  if (DD_21CM_SKUS.has(code)) return 'Deep Dream 21CM';
  if (c.startsWith('DD-')) return 'Deep Dream Other';
  if (c.startsWith('V2-')) return 'Cushie V2 — ' + (destCountry || 'US');
  if (c.startsWith('V3-')) return 'Snuggle V3 — ' + (destCountry || 'AU');
  if ((c.startsWith('CUSB-') || c.startsWith('LFSB-')) && c.includes('-UK')) return 'Cushie V2 — UK';
  if (c.startsWith('CUSB-') || c.startsWith('LFSB-')) return 'Cushie V2 — ' + (destCountry || 'AU');
  if (c.startsWith('CMSS-')) return 'Modular Sleeper';
  if (c.startsWith('LIFELY-') || c.startsWith('LFSF-')) return 'Lifely Sofa';
  if (c.startsWith('RDNT-')) return 'Radiant';
  if (c.startsWith('COCOON-')) return 'Cocoon Bed';
  if (c.startsWith('WFHCR-')) return 'WFH Chair';
  return 'Case Goods';
}

function destToCountryCode(dest) {
  if (!dest) return 'AU';
  const d = dest.toLowerCase();
  if (d.includes('united states') || d.includes('usa')) return 'US';
  if (d.includes('canada')) return 'CA';
  if (d.includes('united kingdom')) return 'UK';
  if (d.includes('singapore')) return 'SG';
  if (d.includes('new zealand')) return 'NZ';
  if (d.includes('australia')) return 'AU';
  // Fallback from PO reference
  return 'AU';
}

function destFromRef(ref) {
  const r = (ref || '').toUpperCase();
  if (r.startsWith('PO-AU') || r.startsWith('PO-LF')) return 'Australia';
  if (r.startsWith('PO-US') || r.startsWith('PO-10')) return 'United States';
  if (r.startsWith('PO-CA')) return 'Canada';
  if (r.startsWith('PO-UK')) return 'United Kingdom';
  if (r.startsWith('PO-NZ')) return 'New Zealand';
  if (r.startsWith('PO-SG')) return 'Singapore';
  return null;
}

function resolvePoDestination(po) {
  let destination = inferDestination(po);
  if (!destination || destination === 'Australia') {
    const refDest = destFromRef(cleanPoReference(po.reference));
    if (refDest) destination = refDest;
    else destination = 'Australia';
  }
  return destination;
}

app.get('/api/incoming-pos', requireAuth, (req, res) => {
  const allCKGroups = new Set();
  const allMonths = new Set();
  const allCountries = new Set();
  const cleanPoReference = ref => (ref || '').replace(/-cover$/i, '');
  
  // Build global landed cost lookup from ALL CK panels
  const globalLanded = {};
  for (const ckId of Object.keys(CK_DEFS)) {
    try {
      const ckData = buildCKData(ckId);
      if (ckData && ckData.landedCosts) {
        for (const [sku, lc] of Object.entries(ckData.landedCosts)) {
          if (!globalLanded[sku] || lc.source === 'actual') globalLanded[sku] = lc;
        }
      }
    } catch(e) { /* skip if CK fails */ }
  }
  
  const pos = [];
  for (const po of (dataCache.cin7POs || [])) {
    // Skip received
    if (po.fullyReceivedDate || po.stage === 'Received') continue;
    
    // Determine destination
    let destination = resolvePoDestination(po);
    const countryCode = destToCountryCode(destination);
    allCountries.add(countryCode);
    
    // ETA
    const etaRaw = po.estimatedArrivalDate || po.arrival || null;
    let eta = null, etaMonth = 'TBD';
    if (etaRaw) {
      const dt = new Date(etaRaw);
      if (!isNaN(dt)) {
        if (dt < new Date('2026-04-01')) {
          eta = '2026-04-01';
          etaMonth = 'April 2026';
        } else {
          eta = dt.toISOString().split('T')[0];
          const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          etaMonth = months[dt.getMonth()] + ' ' + dt.getFullYear();
        }
      }
    }
    allMonths.add(etaMonth);
    
    // Line items with CK classification + landed costs from CK panels
    const lineItems = [];
    const poGroups = new Set();
    let totalUnits = 0;
    let totalFOB = 0, totalFreight = 0, totalTariff = 0;
    
    for (const [sku, qty] of Object.entries(po.items || {})) {
      const ckGroup = classifySKU(sku, countryCode);
      if (!ckGroup) continue;
      
      poGroups.add(ckGroup);
      allCKGroups.add(ckGroup);
      totalUnits += qty;
      
      // Use landed costs from CK panels
      const lc = globalLanded[sku];
      const fobPerUnit = lc ? lc.fob : 0;
      const freightPerUnit = lc ? lc.freightPerUnit : 0;
      const tariffPerUnit = lc ? (lc.tariffPerUnit || 0) : 0;
      const landedPerUnit = lc ? lc.landedPerUnit : 0;
      
      totalFOB += fobPerUnit * qty;
      totalFreight += freightPerUnit * qty;
      totalTariff += tariffPerUnit * qty;
      
      lineItems.push({
        sku,
        name: sku,
        qty,
        fobPerUnit: Math.round(fobPerUnit * 100) / 100,
        freightPerUnit: Math.round(freightPerUnit * 100) / 100,
        landedPerUnit: Math.round(landedPerUnit * 100) / 100,
        ckGroup,
        source: lc ? lc.source : 'none'
      });
    }
    
    if (lineItems.length === 0) continue;
    
    const productTotal = Math.round(totalFOB);
    const freightEst = Math.round(totalFreight);
    const tariffEst = Math.round(totalTariff);
    const landedTotal = productTotal + freightEst + tariffEst;
    
    pos.push({
      reference: cleanPoReference(po.reference),
      supplier: po.company || '',
      destination: countryCode,
      destinationFull: destination,
      eta,
      etaMonth,
      productTotal,
      freightEst,
      tariffEst,
      landedTotal,
      stage: po.stage || 'Open',
      totalUnits,
      ckGroups: [...poGroups].sort(),
      lineItems
    });
  }
  
  // Sort by ETA
  pos.sort((a, b) => {
    if (!a.eta && !b.eta) return 0;
    if (!a.eta) return 1;
    if (!b.eta) return -1;
    return a.eta.localeCompare(b.eta);
  });
  
  // Summary totals
  const summary = {
    totalProductAUD: pos.reduce((s, p) => s + p.productTotal, 0),
    totalFreightAUD: pos.reduce((s, p) => s + p.freightEst, 0),
    totalTariffAUD: pos.reduce((s, p) => s + p.tariffEst, 0),
    totalLandedAUD: pos.reduce((s, p) => s + p.landedTotal, 0),
    totalUnits: pos.reduce((s, p) => s + p.totalUnits, 0),
    poCount: pos.length
  };
  
  res.json({
    pos,
    summary,
    months: [...allMonths].sort(),
    countries: [...allCountries].sort(),
    ckGroups: [...allCKGroups].sort()
  });
});

// Serve incoming-pos page
app.get('/incoming-pos', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'incoming-pos.html'));
});
