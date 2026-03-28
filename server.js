const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

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
  'llau-cb':   { name: 'LL AU Beds',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: true, filter: sku => !sku.includes('CBCF'), sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llau-cbcf': { name: 'LL AU Combos',            prefix: 'LLAU-CBCF-', logo: 'little-lifely.png', store: 'lifely', excludeCV: true, sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llna':     { name: 'Little Lifely NA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: true, sizes: {'-TW-':'Twin','-F-':'Full'} },
  'llsg':     { name: 'Little Lifely SG',       prefix: 'LLSG',   logo: 'little-lifely.png', store: 'lifely', sizes: {'-SS-':'Super Single','-S-':'Single','-Q-':'Queen'} },
  'dd':       { name: 'Deep Dream',             prefix: 'DD',     logo: 'deep-dream.png',    store: 'lifely', sizes: {'915':'Single','107':'King Single','137':'Double','153':'Queen','183':'King'} },
  'cocoon':   { name: 'Cocoon Bed',             prefix: 'COCOON', logo: 'cocoon-bed.png',    store: 'lifely', sizes: {'-DOUBLE-':'Double','-QUEEN-':'Queen','-KING-':'King'} },
  'rdnt':     { name: 'Radiant',                prefix: 'RDNT',   logo: 'radiant.png',       store: 'lifely', sizes: {'-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'wfhcr':    { name: 'WFH Chair',              prefix: 'WFHCR',  logo: 'wfh-chair.png',     store: 'lifely', sizes: {} },
  'cusb-au':  { name: 'Cushie AU',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', filter: sku => (sku.startsWith('CUSB') || sku.startsWith('LFSB')) && !sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },
  'cusb-us':  { name: 'Cushie US',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', filter: sku => sku.startsWith('V2-') || sku.startsWith('V3-'), excludeCV: true, sizes: {'-TB-':'Twin','-DB-':'Full','-QB-':'Queen','-KB-':'King','-CH-':'Chaise','-OS-':'Ottoman','-OB-':'Ottoman Bed','-RMST-':'Armrest','-ARM-':'Armrest'} },
  'cusb-uk':  { name: 'Cushie UK',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', filter: sku => (sku.startsWith('CUSB') || sku.startsWith('LFSB')) && sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },
  
  'cmss':     { name: 'Modular Sleeper',        prefix: 'CMSS',   logo: 'lifely-sofa.png',   store: 'lifely', sizes: {'-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'lifely-sofa': { name: 'Modular Sofa',        prefix: 'LIFELY', logo: 'lifely-sofa.png',   store: 'lifely', sizes: {} }
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
  cin7Products: {},   // sku -> {soh, available}
  cin7POs: [],        // [{reference, status, stage, arrival, items: {sku: qty}}]
  shopifyVelocity: {}, // store -> {sku -> weekly_velocity}
  shopifyInventory: {} // store -> {sku -> inventory_level}
};

// ===== HTTPS REQUEST HELPER =====
function apiRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), headers: res.headers, status: res.statusCode }); }
        catch(e) { resolve({ body: data, headers: res.headers, status: res.statusCode }); }
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
  if (!CIN7_USER || !CIN7_KEY) { console.log('CIN7 SKIPPED: no credentials. USER=' + (CIN7_USER ? 'set' : 'empty') + ' KEY=' + (CIN7_KEY ? 'set' : 'empty')); return {}; }
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const results = {};
  for (let page = 1; page <= 20; page++) {
    try {
      console.log('CIN7 Products: fetching page ' + page);
      let body, status;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const resp = await apiRequest({
            hostname: 'api.cin7.com',
            path: `/api/v1/Products?page=${page}&rows=250`,
            headers: { 'Authorization': `Basic ${auth}` }
          });
          body = resp.body;
          status = resp.status;
          break;
        } catch (retryErr) {
          console.error(`CIN7 page ${page} attempt ${attempt} failed:`, retryErr.message);
          if (attempt === 2) throw retryErr;
          await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
        }
      }
      console.log('CIN7 Products page ' + page + ': status=' + status + ' isArray=' + Array.isArray(body) + ' length=' + (Array.isArray(body) ? body.length : 'N/A'));
      if (!Array.isArray(body) || body.length === 0) break;
      // Rate limit: CIN7 allows 3 req/sec, add delay between pages
      await new Promise(r => setTimeout(r, 1500));
      // Rate limit: CIN7 allows 3 req/sec, add delay between pages
      await new Promise(r => setTimeout(r, 1500));
      for (const product of body) {
        const variants = product.productOptions || [];
        for (const v of variants) {
          if (v.code) {
            results[v.code] = { soh: v.stockOnHand || 0, available: v.stockAvailable || 0, costAUD: v.priceColumns?.costAUD || 0 };
          }
        }
        // Also store parent level if it has SOH
        if (product.styleCode && product.stockOnHand > 0) {
          results[product.styleCode] = { soh: product.stockOnHand, available: product.stockAvailable || 0 };
        }
      }
    } catch (e) { console.error(`CIN7 Products page ${page} error:`, e.message); continue; }
  }
  return results;
}

// ===== CIN7: FETCH PURCHASE ORDERS =====
async function fetchCin7POs() {
  if (!CIN7_USER || !CIN7_KEY) return [];
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const results = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const { body } = await apiRequest({
        hostname: 'api.cin7.com',
        path: `/api/v1/PurchaseOrders?page=${page}&rows=50`,
        headers: { 'Authorization': `Basic ${auth}` }
      });
      if (!Array.isArray(body) || body.length === 0) break;
      for (const po of body) {
        if (po.isVoid) continue; // Skip void POs only — keep Received for shipment tracker
        const items = {};
        for (const li of (po.lineItems || [])) {
          if (li.code && li.qty > 0) items[li.code] = (items[li.code] || 0) + li.qty;
        }
        if (Object.keys(items).length > 0) {
          results.push({
            reference: po.reference,
            status: po.status,
            stage: po.stage || '',
            arrival: po.estimatedDeliveryDate || null,
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
            items
          });
        }
      }
    } catch (e) { console.error(`CIN7 POs page ${page} error:`, e.message); break; }
  }
  return results;
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
  const days = 90;
  const since = new Date(Date.now() - days * 86400000).toISOString();
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
  
  // Convert to weekly velocity
  const weeks = days / 7;
  const velocity = {};
  for (const [sku, units] of Object.entries(skuUnits)) {
    velocity[sku] = Math.round((units / weeks) * 10) / 10;
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

// ===== SHOPIFY: FETCH INVENTORY LEVELS =====
async function fetchShopifyInventory(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) return {};
  
  const inventory = {};
  let url = `/admin/api/2026-01/products.json?limit=250&fields=variants,status`;
  
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
            inventory[v.sku] = v.inventory_quantity || 0;
            // Track inactive SKUs
            if (pStatus === 'draft' || pStatus === 'archived') {
              if (!inactiveSkus) inactiveSkus = new Set();
              inactiveSkus.add(v.sku);
            }
          }
        }
      }
      
      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) { console.error(`Shopify inventory ${storeKey} error:`, e.message); break; }
  }
  return inventory;
}

// ===== FULL DATA REFRESH =====
async function refreshAllData() {
  console.log('Starting full data refresh...');
  const start = Date.now();
  
  try {
    const [cin7Products, cin7POs, lifelyVel, cushieVel, lifelyInv, cushieInv] = await Promise.all([
      fetchCin7AllProducts(),
      fetchCin7POs(),
      fetchShopifyVelocity('lifely'),
      fetchShopifyVelocity('cushie'),
      fetchShopifyInventory('lifely'),
      fetchShopifyInventory('cushie')
    ]);
    
    dataCache.cin7Products = cin7Products;

    dataCache.cin7POs = cin7POs;
    dataCache.shopifyVelocity = { lifely: lifelyVel, cushie: cushieVel };
    dataCache.shopifyInventory = { lifely: lifelyInv, cushie: cushieInv };
    dataCache.lastRefresh = new Date().toISOString();
    
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const cin7Count = Object.keys(cin7Products).length;
    console.log(`Data refresh complete in ${elapsed}s. CIN7: ${cin7Count} SKUs, ${cin7POs.length} POs. Shopify: Lifely ${Object.keys(lifelyVel).length} SKUs, Cushie ${Object.keys(cushieVel).length} SKUs.`);
    
    // If CIN7 returned empty, retry after 15s (likely cold start / network issue)
    if (cin7Count === 0 && !dataCache._retrying) {
      console.log('CIN7 returned 0 SKUs — scheduling retry in 15s...');
      dataCache._retrying = true;
      setTimeout(async () => {
        console.log('CIN7 retry starting...');
        try {
          const retryProducts = await fetchCin7AllProducts();
          const retryPOs = await fetchCin7POs();
          if (Object.keys(retryProducts).length > 0) {
            dataCache.cin7Products = retryProducts;
            dataCache.cin7POs = retryPOs;
            dataCache.lastRefresh = new Date().toISOString();
            console.log('CIN7 retry SUCCESS: ' + Object.keys(retryProducts).length + ' SKUs');
          } else {
            console.log('CIN7 retry still empty');
          }
        } catch (e) {
          console.error('CIN7 retry failed:', e.message);
        }
        dataCache._retrying = false;
      }, 15000);
    }
  } catch (e) {
    console.error('Data refresh failed:', e.message);
    dataCache.error = e.message;
  }
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
    result[base] = { soh, available };
  }
  
  return result;
}

// Radiant: map component SKUs to set SKUs
// Shopify sells: RDNT-{size}-{type}-SET (e.g. RDNT-Q-MF-SET)
// CIN7 tracks: RDNT-{size}-{type} (e.g. RDNT-Q-MF) + RDNT-{size}-BASE
// A SET = BASE + topper. Buildable = min(BASE, topper)
function normalizeRadiant(cin7, shopifySkus) {
  const result = {};
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
      result[setKey] = { soh: Math.min(baseSoh, compSoh), available: Math.min(baseSoh, compSoh) };
      
      // Multi-topper combos (e.g. RDNT-Q-S-MF-SET = BASE + S + MF)
      for (const type2 of types) {
        if (type2 <= type) continue; // avoid duplicates
        const comp2Key = 'RDNT-' + size + '-' + type2;
        const comboSetKey = 'RDNT-' + size + '-' + type + '-' + type2 + '-SET';
        const comp2Soh = cin7[comp2Key]?.soh || cin7[comp2Key] || 0;
        result[comboSetKey] = { soh: Math.min(baseSoh, compSoh, comp2Soh), available: Math.min(baseSoh, compSoh, comp2Soh) };
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
      result[sku + '-SET'] = data;
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
  
  let costs = {};
  // CIN7 stock — first collect raw, then normalize
  const cin7Raw = {};
  for (const [sku, data] of Object.entries(dataCache.cin7Products)) {
    if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
      if (excludeCV && sku.includes('-CV')) continue;
      if (sku.includes('-CS-')) continue;
      if (sku.includes('-FRM')) continue;
      cin7Raw[sku] = data;
    }
  }
  
  // Normalize: merge box-splits, map components to sets
  let cin7Normalized = normalizeCIN7(cin7Raw);
  
  // Special handling per CK
  if (ckId.startsWith('rdnt')) cin7Normalized = normalizeRadiant(cin7Normalized, Object.keys(dataCache.shopifyInventory[storeKey] || {}));
  if (ckId.startsWith('cusb')) cin7Normalized = normalizeCushie(cin7Normalized);
  
  const cin7 = {};
  for (const [sku, data] of Object.entries(cin7Normalized)) {
    cin7[sku] = typeof data === 'object' ? data.soh : data;
      if (typeof data === 'object' && data.costAUD) {
        if (!costs) costs = {};
        costs[sku] = data.costAUD;
      }
  }
  
  // Shopify inventory
  const shopify = {};
  const storeInv = dataCache.shopifyInventory[storeKey] || {};
  for (const [sku, qty] of Object.entries(storeInv)) {
    if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
      if (excludeCV && sku.includes('-CV')) continue;
      if (sku.includes('-CS-')) continue;
      if (sku.includes('-FRM')) continue;
      shopify[sku] = qty;
    }
  }
  
  // Velocity
  const velocity = {};
  const storeVel = dataCache.shopifyVelocity[storeKey] || {};
  for (const [sku, vel] of Object.entries(storeVel)) {
    if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
      if (excludeCV && sku.includes('-CV')) continue;
      if (sku.includes('-CS-')) continue;
      if (sku.includes('-FRM')) continue;
      velocity[sku] = vel;
    }
  }
  
  // Purchase Orders
  const pos = [];
  for (const po of dataCache.cin7POs) {
    if (po.stage === 'Received') continue; // Don't count received POs as incoming stock
    const relevantItems = {};
    for (const [sku, qty] of Object.entries(po.items)) {
      if ((prefix === 'MULTI' ? filter(sku) : sku.startsWith(prefix) && filter(sku))) {
        if (excludeCV && sku.includes('-CV')) continue;
        relevantItems[sku] = qty;
      }
    }
    if (Object.keys(relevantItems).length > 0) {
      pos.push({ ...po, items: relevantItems });
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
  const storeInvFull = dataCache.shopifyInventory[storeKey] || {};
  for (const sku of Object.keys(cin7)) {
    if (storeInvFull['_inactive_' + sku]) { delete cin7[sku]; delete velocity[sku]; delete shopify[sku]; }
  }
  for (const sku of Object.keys(velocity)) {
    if (storeInvFull['_inactive_' + sku]) { delete velocity[sku]; }
  }

  return {
    ck: def,
    cin7,
    shopify,
    velocity,
    pos,
    names,
    sizes: def.sizes,
    costs,
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
        result[sku] = { v7: Math.round(v7*10)/10, v30: Math.round(v30*10)/10, sparkline, firstSeen: firstSeen[sku] || null };
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
app.get('/api/ck/:id', requireAuth, (req, res) => {
  const data = buildCKData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Unknown CK' });
  res.json(data);
});

// Manual refresh
app.post('/api/refresh', requireAuth, async (req, res) => {
  await refreshAllData();
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
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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
  'default': { city: 'Melbourne', lat: -37.81, lng: 144.96, port: 'Melbourne' }
};

function getSupplierOrigin(company) {
  if (!company) return { city: 'Unknown', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' };
  for (const [key, origin] of Object.entries(SUPPLIER_ORIGINS)) {
    if (company.toLowerCase().includes(key.toLowerCase())) return origin;
  }
  return { city: 'Unknown', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' };
}

function buildShipmentData() {
  const shipments = [];
  const now = new Date();
  
  for (const po of dataCache.cin7POs) {
    // Include active POs (we already filter out Received in fetchCin7POs)
    const origin = getSupplierOrigin(po.company || '');
    const dest = DESTINATIONS[po.deliveryCountry || 'default'] || DESTINATIONS['default'];
    
    // ETD = estimatedDeliveryDate (departure from China)
    let etd = null;
    if (po.arrival) {
      etd = new Date(po.arrival);
    }
    
    // ETA = customFields.orders_1000 (Original ETA Date)
    let eta = null;
    if (po.customFields?.orders_1000) {
      const cf = po.customFields.orders_1000;
      // Handle various date formats: "2-3-2026", "16-Mar-2026", "5-5-2026"
      const parsed = new Date(cf.replace(/(\d+)-(\d+)-(\d+)/, (m, d, mo, y) => {
        return y + '-' + mo.padStart(2,'0') + '-' + d.padStart(2,'0');
      }));
      if (!isNaN(parsed.getTime())) eta = parsed;
      // If that didn't work, try direct parse (handles "16-Mar-2026")
      if (!eta || isNaN(eta.getTime())) {
        const direct = new Date(cf);
        if (!isNaN(direct.getTime())) eta = direct;
      }
    }
    if (!eta && po.estimatedArrivalDate) {
      eta = new Date(po.estimatedArrivalDate);
    }
    
    // Actual received date
    let receivedDate = null;
    if (po.fullyReceivedDate) {
      receivedDate = new Date(po.fullyReceivedDate);
    }
    
    // ETD already parsed above from estimatedDeliveryDate
    
    // Calculate progress (0-1)
    let progress = 0;
    let status = 'production';
    
    // If it has a received date OR stage is "Received", it's arrived — regardless of other fields
    if (receivedDate || po.stage === 'Received') {
      progress = 1;
      status = 'arrived';
    } else if (etd && eta) {
      const totalDays = (eta - etd) / (24 * 60 * 60 * 1000);
      const elapsedDays = (now - etd) / (24 * 60 * 60 * 1000);
      if (elapsedDays < 0) {
        progress = 0;
        status = 'production';
      } else if (elapsedDays >= totalDays) {
        progress = 1;
        status = 'arrived';
      } else {
        progress = elapsedDays / totalDays;
        status = 'in_transit';
      }
    }
    
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
      internalComments: po.internalComments || null
    });
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

// Main app
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// ===== START =====
app.listen(PORT, () => {
  console.log(`Demand Planner running on port ${PORT}`);
  refreshAllData(); // Initial fetch
  setInterval(refreshAllData, 60 * 60 * 1000); // Hourly refresh
});
