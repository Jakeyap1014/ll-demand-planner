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
  'cusb-au':  { name: 'Cushie AU',              prefix: 'CUSB',   logo: 'cushie.png',        store: 'lifely', filter: sku => !sku.includes('-UK'), sizes: {'-TW-':'Twin','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'cusb-us':  { name: 'Cushie US',              prefix: 'CUSB',   logo: 'cushie.png',        store: 'cushie', sizes: {'-TW-':'Twin','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'cusb-uk':  { name: 'Cushie UK',              prefix: 'CUSB',   logo: 'cushie.png',        store: 'lifely', filter: sku => sku.includes('-UK'), sizes: {'-TW-':'Twin','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'lfsb':     { name: 'Lifely Sofa Bed',        prefix: 'LFSB',   logo: 'lifely-sofa.png',   store: 'lifely', sizes: {'-TW-':'Twin','-D-':'Double','-Q-':'Queen'} },
  'cmss':     { name: 'Modular Sleeper',        prefix: 'CMSS',   logo: 'lifely-sofa.png',   store: 'lifely', sizes: {'-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'lifely-sofa': { name: 'Modular Sofa',        prefix: 'LIFELY', logo: 'lifely-sofa.png',   store: 'lifely', sizes: {} }
};

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
  for (let page = 1; page <= 10; page++) {
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
      for (const product of body) {
        const variants = product.productOptions || [];
        for (const v of variants) {
          if (v.code) {
            results[v.code] = { soh: v.stockOnHand || 0, available: v.stockAvailable || 0 };
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
  const days = 90;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let url = `/admin/api/2026-01/orders.json?status=any&limit=250&created_at_min=${since}&fields=id,line_items,financial_status`;
  
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
        for (const li of (o.line_items || [])) {
          if (li.sku) skuUnits[li.sku] = (skuUnits[li.sku] || 0) + (li.quantity || 0);
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
  return velocity;
}

// ===== SHOPIFY: FETCH INVENTORY LEVELS =====
async function fetchShopifyInventory(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) return {};
  
  const inventory = {};
  let url = `/admin/api/2026-01/products.json?limit=250&fields=variants`;
  
  for (let page = 1; page <= 10; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const products = body.products || [];
      if (products.length === 0) break;
      
      for (const p of products) {
        for (const v of (p.variants || [])) {
          if (v.sku) inventory[v.sku] = v.inventory_quantity || 0;
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
// Embedded CIN7 fallback data (updated by Caesar periodically)
const cin7Fallback = {products: {"COCOON-KING-IVR-1":{"soh":11.0,"available":11.0},"COCOON-KING-IVR-2":{"soh":11.0,"available":11.0},"COCOON-QUEEN-IVR-1":{"soh":7.0,"available":5.0},"COCOON-QUEEN-IVR-2":{"soh":7.0,"available":5.0},"COCOON-DOUBLE-IVR-1":{"soh":3.0,"available":3.0},"COCOON-DOUBLE-IVR-2":{"soh":3.0,"available":3.0},"COCOON-KING-CRML-1":{"soh":31.0,"available":26.0},"COCOON-KING-CRML-2":{"soh":31.0,"available":26.0},"COCOON-QUEEN-CRML-1":{"soh":7.0,"available":7.0},"COCOON-QUEEN-CRML-2":{"soh":7.0,"available":7.0},"COCOON-DOUBLE-CRML-1":{"soh":7.0,"available":7.0},"COCOON-DOUBLE-CRML-2":{"soh":6.0,"available":6.0},"COCOON-KING-MSGRN-1":{"soh":25.0,"available":24.0},"COCOON-KING-MSGRN-2":{"soh":25.0,"available":24.0},"COCOON-QUEEN-MSGRN-1":{"soh":12.0,"available":12.0},"COCOON-QUEEN-MSGRN-2":{"soh":12.0,"available":12.0},"COCOON-DOUBLE-MSGRN-1":{"soh":9.0,"available":9.0},"COCOON-DOUBLE-MSGRN-2":{"soh":9.0,"available":9.0},"CUSB-ARST-SET-LTGN":{"soh":62.0,"available":53.0},"CUSB-D-LTGN-1":{"soh":12.0,"available":8.0},"CUSB-D-LTGN-2":{"soh":12.0,"available":8.0},"CUSB-K-LTGN-1":{"soh":18.0,"available":17.0},"CUSB-K-LTGN-2":{"soh":18.0,"available":17.0},"CUSB-Q-LTGN-1":{"soh":17.0,"available":14.0},"CUSB-Q-LTGN-2":{"soh":16.0,"available":13.0},"CUSB-TW-LTGN-1":{"soh":13.0,"available":12.0},"CUSB-TW-LTGN-2":{"soh":13.0,"available":12.0},"LFSB-AMST-WHT-CV":{"soh":2.0,"available":2.0},"LLAU-CB-KS-DSBL-CV":{"soh":1.0,"available":0.0},"LLAU-CB-D-DSBL-CV":{"soh":1.0,"available":-3.0},"LLAU-CB-S-DGY-CV":{"soh":1.0,"available":-1.0},"LLAU-CB-D-DGY-CV":{"soh":5.0,"available":0.0},"LLAU-CB-S-PST-CV":{"soh":2.0,"available":-4.0},"LLAU-CB-KS-PST-CV":{"soh":1.0,"available":-1.0},"LLAU-CB-D-BABL-CV":{"soh":1.0,"available":-8.0},"LLAU-CB-KS-CTCN-CV":{"soh":2.0,"available":-2.0},"LLAU-CB-S-MSM-CV":{"soh":1.0,"available":-2.0},"LLAU-CB-D-MSM-CV":{"soh":2.0,"available":-8.0},"LLSG-CB-S-DGY-CV":{"soh":3.0,"available":3.0},"LLSG-CB-SS-DGY-CV":{"soh":1.0,"available":1.0},"LLSG-CB-Q-DGY-CV":{"soh":2.0,"available":2.0},"LLSG-CB-S-PST-CV":{"soh":1.0,"available":1.0},"LLSG-CB-SS-PST-CV":{"soh":1.0,"available":1.0},"LLSG-CB-Q-PST-CV":{"soh":1.0,"available":1.0},"LLSG-CB-S-BABL-CV":{"soh":2.0,"available":2.0},"LLSG-CB-SS-BABL-CV":{"soh":2.0,"available":2.0},"LLSG-CB-Q-BABL-CV":{"soh":2.0,"available":2.0},"LLSG-CB-S-CTCN-CV":{"soh":2.0,"available":2.0},"LLSG-CB-SS-CTCN-CV":{"soh":6.0,"available":6.0},"LLSG-CB-Q-CTCN-CV":{"soh":2.0,"available":2.0},"LLSG-CB-S-MSM-CV":{"soh":4.0,"available":4.0},"LLSG-CB-SS-MSM-CV":{"soh":3.0,"available":3.0},"LLSG-CB-Q-MSM-CV":{"soh":1.0,"available":1.0},"LLAU-CB-CS-DSBL":{"soh":264.0,"available":246.0},"LLAU-CB-CS-DGY":{"soh":263.0,"available":245.0},"LLAU-CB-CS-PST":{"soh":263.0,"available":245.0},"LLAU-CB-CS-BABL":{"soh":263.0,"available":245.0},"LLAU-CB-CS-CTCN":{"soh":263.0,"available":245.0},"LLAU-CB-CS-MSM":{"soh":263.0,"available":245.0},"LFSB-AMST-CV-CHC":{"soh":3.0,"available":3.0},"LFSB-AMST-CV-LTGN":{"soh":6.0,"available":6.0},"LFSB-AMST-CV-WHT":{"soh":3.0,"available":3.0},"RDNT-PROT-D":{"soh":29.0,"available":29.0},"RDNT-PROT-Q":{"soh":25.0,"available":25.0},"RDNT-PROT-K":{"soh":34.0,"available":34.0},"JSPH-DC-WNT-ECO":{"soh":41.0,"available":41.0},"LUK-BS-NAL-ECO":{"soh":34.0,"available":34.0},"WFHCR-CRM":{"soh":16.0,"available":16.0},"HANK-CT-WNT-ECO-1":{"soh":33.0,"available":31.0},"HANK-CT-WNT-ECO-2":{"soh":33.0,"available":31.0},"HANK-SB160-WNT-ECO-1":{"soh":21.0,"available":20.0},"HANK-SB160-WNT-ECO-2":{"soh":22.0,"available":21.0},"HANK-SB160-WNT-ECO-3":{"soh":19.0,"available":18.0},"ALX-BF-K-NAL-ECO-1":{"soh":40.0,"available":40.0},"ALX-BF-K-NAL-ECO-2":{"soh":40.0,"available":40.0},"ALX-BF-K-NAL-ECO-3":{"soh":41.0,"available":41.0},"ALX-BF-Q-NAL-ECO-1":{"soh":44.0,"available":43.0},"ALX-BF-Q-NAL-ECO-2":{"soh":44.0,"available":43.0},"ALX-BF-Q-NAL-ECO-3":{"soh":44.0,"available":43.0},"BNC-6COD-WNT-ECO-1":{"soh":28.0,"available":27.0},"BNC-6COD-WNT-ECO-2":{"soh":28.0,"available":27.0},"BNC-6COD-WNT-ECO-3":{"soh":28.0,"available":27.0},"GEM-RTDSK-WNT-ECO-1":{"soh":43.0,"available":43.0},"GEM-RTDSK-WNT-ECO-2":{"soh":43.0,"available":43.0},"GEM-RTDSK-WNT-ECO-3":{"soh":43.0,"available":43.0},"IRSA-BF-K-WNT-ECO-1":{"soh":46.0,"available":46.0},"IRSA-BF-K-WNT-ECO-2":{"soh":46.0,"available":46.0},"IRSA-BF-K-WNT-ECO-3":{"soh":46.0,"available":46.0},"IRSA-BF-Q-WNT-ECO-1":{"soh":47.0,"available":47.0},"IRSA-BF-Q-WNT-ECO-2":{"soh":47.0,"available":47.0},"IRSA-BF-Q-WNT-ECO-3":{"soh":47.0,"available":47.0},"JAM-BF-K-OAK-ECO-1":{"soh":37.0,"available":37.0},"JAM-BF-K-OAK-ECO-2":{"soh":37.0,"available":37.0},"JAM-BF-K-OAK-ECO-3":{"soh":37.0,"available":37.0},"JAM-BF-Q-OAK-ECO-1":{"soh":41.0,"available":41.0},"JAM-BF-Q-OAK-ECO-2":{"soh":41.0,"available":41.0},"JAM-BF-Q-OAK-ECO-3":{"soh":41.0,"available":41.0},"KTH-SB180-WNT-ECO-1":{"soh":33.0,"available":33.0},"KTH-SB180-WNT-ECO-2":{"soh":33.0,"available":33.0},"KTH-SB180-WNT-ECO-3":{"soh":33.0,"available":33.0},"KTH-SB180-WNT-ECO-4":{"soh":33.0,"available":33.0},"LARY-6COD-ECO-1":{"soh":1.0,"available":-1.0},"LARY-6COD-ECO-2":{"soh":1.0,"available":-1.0},"LARY-6COD-ECO-3":{"soh":1.0,"available":-1.0},"MAX-SC-ECO-1":{"soh":26.0,"available":26.0},"MAX-SC-ECO-2":{"soh":26.0,"available":26.0},"MAX-SC-ECO-3":{"soh":26.0,"available":26.0},"MAX-SC-ECO-4":{"soh":25.0,"available":25.0},"WIBR-DSK-ECO-1":{"soh":16.0,"available":16.0},"WIBR-DSK-ECO-2":{"soh":17.0,"available":17.0},"LLAU-CB-S-DSBL":{"soh":22.0,"available":10.0},"LLAU-CB-KS-DSBL":{"soh":8.0,"available":-6.0},"LLAU-CB-D-DSBL":{"soh":113.0,"available":96.0},"LLAU-CB-S-DGY":{"soh":106.0,"available":87.0},"LLAU-CB-KS-DGY":{"soh":48.0,"available":29.0},"LLAU-CB-D-DGY":{"soh":44.0,"available":21.0},"LLAU-CB-S-PST":{"soh":11.0,"available":-24.0},"LLAU-CB-KS-PST":{"soh":44.0,"available":1.0},"LLAU-CB-D-PST":{"soh":152.0,"available":116.0},"LLAU-CB-S-BABL":{"soh":3.0,"available":-48.0},"LLAU-CB-KS-BABL":{"soh":14.0,"available":-41.0},"LLAU-CB-D-BABL":{"soh":37.0,"available":-4.0},"LLAU-CB-S-CTCN":{"soh":158.0,"available":116.0},"LLAU-CB-KS-CTCN":{"soh":123.0,"available":93.0},"LLAU-CB-D-CTCN":{"soh":211.0,"available":154.0},"LLAU-CB-S-MSM":{"soh":223.0,"available":102.0},"LLAU-CB-KS-MSM":{"soh":50.0,"available":-38.0},"LLAU-CB-D-MSM":{"soh":124.0,"available":37.0},"LLSG-CB-S-DGY":{"soh":12.0,"available":11.0},"LLSG-CB-SS-DGY":{"soh":4.0,"available":4.0},"LLSG-CB-Q-DGY":{"soh":10.0,"available":9.0},"LLSG-CB-S-PST":{"soh":4.0,"available":4.0},"LLSG-CB-SS-PST":{"soh":6.0,"available":6.0},"LLSG-CB-Q-PST":{"soh":4.0,"available":4.0},"LLSG-CB-S-BABL":{"soh":10.0,"available":10.0},"LLSG-CB-SS-BABL":{"soh":10.0,"available":9.0},"LLSG-CB-Q-BABL":{"soh":10.0,"available":10.0},"LLSG-CB-S-CTCN":{"soh":11.0,"available":10.0},"LLSG-CB-SS-CTCN":{"soh":18.0,"available":15.0},"LLSG-CB-Q-CTCN":{"soh":10.0,"available":10.0},"LLSG-CB-S-MSM":{"soh":16.0,"available":12.0},"LLSG-CB-SS-MSM":{"soh":12.0,"available":12.0},"LLSG-CB-Q-MSM":{"soh":5.0,"available":4.0},"HLO-DC-WHT-ECO":{"soh":18.0,"available":18.0},"NIC-BS-BLK-ECO":{"soh":45.0,"available":45.0},"ALCE-BS-ECO":{"soh":3.0,"available":3.0},"LIAM-DC-WHT-ECO":{"soh":38.0,"available":38.0},"ERC-BS-CUSH-NAL-ECO":{"soh":38.0,"available":38.0},"JCB-DC-NAL-ECO":{"soh":41.0,"available":41.0},"CUSB-ARST-SET-TBRN":{"soh":30.0,"available":27.0},"CUSB-ARST-SET-TWHT":{"soh":79.0,"available":76.0},"CUSB-ARST-SET-DNM":{"soh":72.0,"available":66.0},"CUSB-D-DNM-1":{"soh":17.0,"available":15.0},"CUSB-D-DNM-2":{"soh":17.0,"available":15.0},"CUSB-D-TBRN-1":{"soh":5.0,"available":4.0},"CUSB-D-TBRN-2":{"soh":5.0,"available":4.0},"CUSB-D-TWHT-1":{"soh":13.0,"available":13.0},"CUSB-D-TWHT-2":{"soh":13.0,"available":13.0},"CUSB-K-DNM-1":{"soh":6.0,"available":5.0},"CUSB-K-DNM-2":{"soh":6.0,"available":5.0},"CUSB-K-TBRN-1":{"soh":7.0,"available":7.0},"CUSB-K-TBRN-2":{"soh":7.0,"available":7.0},"CUSB-K-TWHT-1":{"soh":17.0,"available":17.0},"CUSB-K-TWHT-2":{"soh":17.0,"available":17.0},"CUSB-Q-DNM-1":{"soh":29.0,"available":28.0},"CUSB-Q-DNM-2":{"soh":29.0,"available":28.0},"CUSB-Q-TBRN-1":{"soh":7.0,"available":6.0},"CUSB-Q-TBRN-2":{"soh":7.0,"available":6.0},"CUSB-Q-TWHT-1":{"soh":31.0,"available":29.0},"CUSB-Q-TWHT-2":{"soh":31.0,"available":29.0},"CUSB-TW-DNM-1":{"soh":14.0,"available":13.0},"CUSB-TW-DNM-2":{"soh":14.0,"available":13.0},"CUSB-TW-TBRN-1":{"soh":6.0,"available":5.0},"CUSB-TW-TBRN-2":{"soh":6.0,"available":5.0},"CUSB-TW-TWHT-1":{"soh":13.0,"available":12.0},"CUSB-TW-TWHT-2":{"soh":13.0,"available":12.0},"SILV-MR16-OW-ECO":{"soh":39.0,"available":39.0},"OLV-MR18-WNT-ECO":{"soh":32.0,"available":32.0},"MEG-MR16-WNT-ECO":{"soh":37.0,"available":37.0},"JILN-6COD-OAK-ECO-1":{"soh":26.0,"available":26.0},"JILN-6COD-OAK-ECO-2":{"soh":26.0,"available":26.0},"ODEN-DSK-ADJ-OAK-ECO-1":{"soh":27.0,"available":27.0},"ODEN-DSK-ADJ-OAK-ECO-2":{"soh":27.0,"available":27.0},"CAM-DSK-ADJ-WG-ECO-1":{"soh":34.0,"available":33.0},"CAM-DSK-ADJ-WG-ECO-2":{"soh":34.0,"available":33.0},"JOSE-BF-GL-K-ECO-2":{"soh":1.0,"available":1.0},"JOSE-BF-GL-K-ECO-3":{"soh":1.0,"available":1.0},"JOSE-BF-GL-K-ECO-4":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-1":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-2":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-3":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-4":{"soh":1.0,"available":1.0},"PVO-SBCH-140-ECO":{"soh":19.0,"available":19.0},"RDNT-D-BASE":{"soh":52.0,"available":51.0},"RDNT-D-S":{"soh":33.0,"available":31.0},"RDNT-D-MF":{"soh":47.0,"available":47.0},"RDNT-D-F":{"soh":22.0,"available":22.0},"RDNT-Q-BASE":{"soh":170.0,"available":167.0},"RDNT-Q-S":{"soh":68.0,"available":66.0},"RDNT-Q-MF":{"soh":41.0,"available":37.0},"RDNT-Q-F":{"soh":45.0,"available":45.0},"RDNT-K-BASE":{"soh":100.0,"available":97.0},"RDNT-K-S":{"soh":37.0,"available":35.0},"RDNT-K-MF":{"soh":2.0,"available":1.0},"LYLA-BF-GL-K-ECO-1":{"soh":2.0,"available":-3.0},"LYLA-BF-GL-K-ECO-2":{"soh":2.0,"available":-3.0},"LYLA-BF-GL-K-ECO-3":{"soh":2.0,"available":-3.0},"LYLA-BF-GL-Q-ECO-2":{"soh":1.0,"available":-1.0},"LYLA-BF-GL-Q-ECO-3":{"soh":1.0,"available":-1.0},"LYLA-BF-GL-Q-ECO-4":{"soh":1.0,"available":-1.0},"LFSB-CHS-CHC-1":{"soh":5.0,"available":5.0},"LFSB-CHS-CHC-2":{"soh":5.0,"available":5.0},"LFSB-Q-CHC-1":{"soh":40.0,"available":40.0},"LFSB-Q-CHC-2":{"soh":40.0,"available":40.0},"LFSB-TW-CHC-1":{"soh":21.0,"available":21.0},"LFSB-TW-CHC-2":{"soh":21.0,"available":21.0},"LFSB-Q-LTGN-1":{"soh":74.0,"available":67.0},"LFSB-Q-LTGN-2":{"soh":75.0,"available":68.0},"LFSB-D-LTGN-1":{"soh":5.0,"available":1.0},"LFSB-D-LTGN-2":{"soh":4.0,"available":0.0},"LFSB-TW-LTGN-1":{"soh":155.0,"available":152.0},"LFSB-TW-LTGN-2":{"soh":162.0,"available":159.0},"LFSB-D-WHT-1":{"soh":18.0,"available":17.0},"LFSB-D-WHT-2":{"soh":18.0,"available":17.0},"LFSB-CHS-WHT-1":{"soh":7.0,"available":7.0},"LFSB-CHS-WHT-2":{"soh":7.0,"available":7.0},"LFSB-TW-WHT-1":{"soh":26.0,"available":25.0},"LFSB-TW-WHT-2":{"soh":27.0,"available":26.0},"BRN-6COD-ECO-1":{"soh":20.0,"available":20.0},"BRN-6COD-ECO-2":{"soh":20.0,"available":20.0},"BRN-6COD-ECO-3":{"soh":20.0,"available":20.0},"OKL-TV200-ECO-1":{"soh":1.0,"available":1.0},"OKL-TV200-ECO-2":{"soh":1.0,"available":1.0},"OKL-TV200-ECO-3":{"soh":1.0,"available":1.0},"CMSS-SB-S-CHC":{"soh":4.0,"available":4.0},"ADN-TV180-ASH-ECO-1":{"soh":1.0,"available":1.0},"BRL-BWD-BT-ECO":{"soh":6.0,"available":6.0},"HANK-CT-ASH-ECO-1":{"soh":1.0,"available":1.0},"HANK-SB160-ASH-ECO-1":{"soh":3.0,"available":3.0},"HANK-SB160-ASH-ECO-2":{"soh":3.0,"available":3.0},"HANK-CST-ASH-ECO-1":{"soh":1.0,"available":0.0},"HANK-CST-ASH-ECO-2":{"soh":1.0,"available":0.0},"HANK-TV180-ASH-ECO-1":{"soh":1.0,"available":1.0},"HANK-TV180-ASH-ECO-2":{"soh":1.0,"available":1.0},"SENA-CT-DKGN-ECO":{"soh":17.0,"available":17.0},"FELX-V2-BB-K-ECO-1":{"soh":2.0,"available":2.0},"FELX-V2-BB-K-ECO-3":{"soh":2.0,"available":2.0},"TOB-BCH-ECO":{"soh":9.0,"available":8.0},"PAV-BF-K-ECO-1":{"soh":7.0,"available":7.0},"PAV-BF-K-ECO-2":{"soh":7.0,"available":7.0},"PAV-BF-K-ECO-3":{"soh":7.0,"available":7.0},"PAV-BF-Q-ECO-1":{"soh":14.0,"available":14.0},"PAV-BF-Q-ECO-2":{"soh":13.0,"available":13.0},"PAV-BF-Q-ECO-3":{"soh":14.0,"available":14.0},"FMA-SB160-WNT-ECO-1":{"soh":2.0,"available":2.0},"FMA-SB160-WNT-ECO-2":{"soh":2.0,"available":2.0},"FMA-SB160-WNT-ECO-3":{"soh":1.0,"available":1.0},"LFSF-AMLS-CV-DKGN":{"soh":18.0,"available":12.0},"LFSF-CRNR-CV-DKGN":{"soh":67.0,"available":61.0},"LFSF-OTM-CV-DKGN":{"soh":23.0,"available":19.0},"LFSF-OTM-CV-CHC":{"soh":6.0,"available":-9.0},"LFSF-CRNR-CV-CRMPIP":{"soh":3.0,"available":-20.0},"LFSF-AMLS-CV-BLST":{"soh":17.0,"available":13.0},"LFSF-CRNR-CV-BLST":{"soh":13.0,"available":9.0},"LFSF-OTM-CV-BLST":{"soh":4.0,"available":0.0},"ODEN-SC-OAK-ECO-3":{"soh":11.0,"available":11.0},"DIRI-DS-CRM-ECO-2":{"soh":2.0,"available":1.0},"DIRI-DS-CRM-ECO-3":{"soh":2.0,"available":2.0},"AFI-BF-Q-WHT-ECO-1":{"soh":1.0,"available":0.0},"AFI-BF-Q-WHT-ECO-2":{"soh":2.0,"available":1.0},"TATE-EDT-WNT-ECO-1":{"soh":3.0,"available":-27.0},"TATE-EDT-WNT-ECO-2":{"soh":3.0,"available":-27.0},"TATE-EDT-WNT-ECO-3":{"soh":3.0,"available":-27.0},"WILY-ED160-WNT-ECO-1":{"soh":4.0,"available":3.0},"WILY-ED160-WNT-ECO-2":{"soh":4.0,"available":3.0},"WILY-ED160-WNT-ECO-3":{"soh":4.0,"available":3.0},"IRNE-TV180-OAK-ECO-1":{"soh":1.0,"available":0.0},"IRNE-TV180-OAK-ECO-2":{"soh":1.0,"available":0.0},"IRNE-TV200-OAK-ECO-1":{"soh":7.0,"available":5.0},"IRNE-TV200-OAK-ECO-2":{"soh":1.0,"available":-1.0},"THEO-TV200-ASH-ECO-2":{"soh":1.0,"available":1.0},"FMA-6COD-WNT-ECO-1":{"soh":63.0,"available":63.0},"FMA-6COD-WNT-ECO-2":{"soh":64.0,"available":64.0},"FMA-6COD-WNT-ECO-3":{"soh":64.0,"available":64.0},"KTZ-CT120-WHT-ECO-1":{"soh":1.0,"available":1.0},"KTZ-CT120-WHT-ECO-2":{"soh":1.0,"available":1.0},"KTZ-ST-WHT-ECO-1":{"soh":10.0,"available":10.0},"KTZ-ST-WHT-ECO-2":{"soh":11.0,"available":11.0},"JOSE-BF-Q-FG-ECO-1":{"soh":1.0,"available":1.0},"JOSE-BF-Q-FG-ECO-2":{"soh":1.0,"available":1.0},"JOSE-BF-K-FG-ECO-2":{"soh":2.0,"available":0.0},"EVE-BF-Q-NAL-ECO-1":{"soh":3.0,"available":3.0},"EVE-BF-Q-NAL-ECO-2":{"soh":2.0,"available":2.0},"EVE-BF-Q-NAL-ECO-3":{"soh":3.0,"available":3.0},"EVE-BF-Q-NAL-ECO-4":{"soh":3.0,"available":3.0},"EVE-BF-K-NAL-ECO-1":{"soh":1.0,"available":1.0},"EVE-BF-K-NAL-ECO-2":{"soh":1.0,"available":1.0},"EVE-BF-K-NAL-ECO-3":{"soh":1.0,"available":1.0},"EVE-BF-K-NAL-ECO-4":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-1":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-2":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-3":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-4":{"soh":1.0,"available":1.0},"LOLA-HBSF-NAL-ECO-1":{"soh":1.0,"available":1.0},"LOLA-HBSF-NAL-ECO-2":{"soh":1.0,"available":1.0},"LOLA-LBSF-NAL-ECO-1":{"soh":21.0,"available":21.0},"LOLA-LBSF-NAL-ECO-2":{"soh":21.0,"available":21.0},"HDSN-EDT-OAK-ECO-2":{"soh":7.0,"available":7.0},"THEO-SB180-ASH-ECO-1":{"soh":2.0,"available":1.0},"THEO-SB180-ASH-ECO-2":{"soh":1.0,"available":0.0},"THEO-SB180-ASH-ECO-3":{"soh":2.0,"available":1.0},"BLC-TV200-WNT-ECO-1":{"soh":2.0,"available":2.0},"BLC-TV200-WNT-ECO-2":{"soh":1.0,"available":1.0},"AVRY-FLAMP-CG-ECO-1":{"soh":13.0,"available":12.0},"AVRY-FLAMP-CG-ECO-2":{"soh":14.0,"available":13.0},"VRT-B140-FNG-ECO-2":{"soh":1.0,"available":1.0},"ODEN-SC-OAK-ECO-1":{"soh":9.0,"available":9.0},"ODEN-SC-OAK-ECO-2":{"soh":10.0,"available":10.0},"KTZ-DT110-WHT-ECO-1":{"soh":10.0,"available":10.0},"KTZ-DT110-WHT-ECO-2":{"soh":7.0,"available":7.0},"HAZ-CT-NAL-ECO":{"soh":2.0,"available":1.0},"ODEN-SC-OAK-ECO":{"soh":1.0,"available":1.0},"LFSF-AMLS-FC":{"soh":176.0,"available":106.0},"LFSF-CRNR-FC":{"soh":293.0,"available":204.0},"LFSF-OTM-FC":{"soh":74.0,"available":18.0},"LFSF-AMLS-CV-WHT":{"soh":2.0,"available":-2.0},"LFSF-AMCR-CV-WHT":{"soh":4.0,"available":4.0},"LFSF-CRNR-CV-WHT":{"soh":19.0,"available":16.0},"LFSF-OTM-CV-WHT":{"soh":7.0,"available":6.0},"LFSF-AMLS-CV-OG":{"soh":151.0,"available":148.0},"LFSF-CRNR-CV-OG":{"soh":206.0,"available":196.0},"LFSF-OTM-CV-OG":{"soh":42.0,"available":41.0},"LFSF-AMCR-CV-RST":{"soh":5.0,"available":5.0},"LFSF-CRNR-CV-LB":{"soh":28.0,"available":-27.0},"LFSF-OTM-CV-LB":{"soh":17.0,"available":-13.0},"LFSB-SOTM-CHC":{"soh":5.0,"available":5.0},"LFSB-S-CHC":{"soh":16.0,"available":16.0},"LFSB-AMST-CHC":{"soh":60.0,"available":57.0},"LFSB-Q-CV-CHC":{"soh":2.0,"available":2.0},"LFSB-TW-CV-CHC":{"soh":1.0,"available":1.0},"LFSB-SOTM-LTGN":{"soh":1.0,"available":-9.0},"LFSB-S-LTGN":{"soh":7.0,"available":7.0},"LFSB-AMST-LTGN":{"soh":204.0,"available":192.0},"LFSB-Q-CV-LTGN":{"soh":3.0,"available":3.0},"LFSB-D-CV-LTGN":{"soh":1.0,"available":1.0},"LFSB-TW-CV-LTGN":{"soh":3.0,"available":3.0},"LFSB-S-WHT":{"soh":8.0,"available":8.0},"LFSB-AMST-WHT":{"soh":44.0,"available":36.0},"LFSB-Q-CV-WHT":{"soh":1.0,"available":1.0},"LFSB-D-CV-WHT":{"soh":1.0,"available":1.0},"LFSB-TW-CV-WHT":{"soh":1.0,"available":1.0},"ACHE-FLAMP-ECO-1":{"soh":1.0,"available":0.0},"ALLY-TV225-WHT-ECO-2":{"soh":2.0,"available":1.0},"AMLA-DESK-ECO-1":{"soh":3.0,"available":3.0},"AMLA-DESK-ECO-2":{"soh":1.0,"available":1.0},"ARH-5DC80-WHT-ECO-1":{"soh":2.0,"available":2.0},"ARH-5DC80-WHT-ECO-2":{"soh":2.0,"available":2.0},"ARH-SB160-WHT-ECO-1":{"soh":1.0,"available":1.0},"ARH-SB160-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARH-TV220-WHT-ECO-1":{"soh":2.0,"available":2.0},"ARH-TV220-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARLO-6COD-WHT-ECO-1":{"soh":20.0,"available":20.0},"ARLO-6COD-WHT-ECO-2":{"soh":20.0,"available":20.0},"ARLO-6COD-WHT-ECO-3":{"soh":19.0,"available":19.0},"ARLO-CST-WHT-ECO-1":{"soh":3.0,"available":3.0},"ARLO-CST-WHT-ECO-2":{"soh":3.0,"available":3.0},"ARLO-SB-WHT-ECO-1":{"soh":1.0,"available":1.0},"ARLO-SB-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARLO-SB-WHT-ECO-3":{"soh":1.0,"available":1.0},"ARLO-TV-WHT-ECO-1":{"soh":1.0,"available":1.0},"ARLO-TV-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARLO-TV160-WHT-ECO-1":{"soh":2.0,"available":1.0},"ARLO-TV160-WHT-ECO-2":{"soh":2.0,"available":1.0},"BLC-6COD-OAK-ECO-1":{"soh":11.0,"available":7.0},"BLC-6COD-OAK-ECO-2":{"soh":11.0,"available":7.0},"BLC-6COD-OAK-ECO-3":{"soh":12.0,"available":8.0},"BLC-6COD-WNT-ECO-1":{"soh":1.0,"available":0.0},"BLC-6COD-WNT-ECO-2":{"soh":2.0,"available":1.0},"BLC-6COD-WNT-ECO-3":{"soh":4.0,"available":3.0},"BLC-BBK-OAK-ECO-1":{"soh":2.0,"available":1.0},"BLC-BBK-OAK-ECO-2":{"soh":2.0,"available":1.0},"BLC-BBK-OAK-ECO-3":{"soh":1.0,"available":0.0},"BLC-BBQ-OAK-ECO-1":{"soh":1.0,"available":1.0},"BLC-BBQ-OAK-ECO-2":{"soh":1.0,"available":1.0},"BLC-BBQ-OAK-ECO-3":{"soh":1.0,"available":1.0},"BLC-TV200-OAK-ECO-1":{"soh":31.0,"available":31.0},"BLC-TV200-OAK-ECO-2":{"soh":30.0,"available":30.0},"BLC-V2-BBK-OAK-ECO-1":{"soh":1.0,"available":1.0},"BLC-V2-BBQ-OAK-ECO-2":{"soh":1.0,"available":-8.0},"CAM-DSK150-WG-ECO-2":{"soh":2.0,"available":0.0},"CLB-D170-WNT-ECO-2":{"soh":1.0,"available":1.0},"CLEO-SB-OAK-ECO-1":{"soh":1.0,"available":1.0},"CLEO-SB-OAK-ECO-2":{"soh":1.0,"available":1.0},"CLUD-CT-WHT-ECO-2":{"soh":1.0,"available":1.0},"CLV2-WB147-D-ECO-1":{"soh":1.0,"available":0.0},"CLV2-WB147-D-WNT-ECO-1":{"soh":1.0,"available":-1.0},"CLV2-WB163-Q-ECO-1":{"soh":2.0,"available":-8.0},"CLV2-WB163-Q-ECO-2":{"soh":2.0,"available":-8.0},"CLV2-WB193-K-ECO-1":{"soh":2.0,"available":2.0},"CLV2-WB193-K-ECO-2":{"soh":1.0,"available":1.0},"CLV2-WB193-K-WNT-ECO-1":{"soh":3.0,"available":2.0},"CLV2-WB193-K-WNT-ECO-2":{"soh":1.0,"available":0.0},"CRSN-SB-NATR-ECO-1":{"soh":1.0,"available":1.0},"CRSN-SB-NATR-ECO-2":{"soh":1.0,"available":1.0},"DRIS-SB160-WNT-ECO-1":{"soh":2.0,"available":2.0},"DRIS-SB160-WNT-ECO-2":{"soh":1.0,"available":1.0},"ELLA-BF-K-ECO-1":{"soh":2.0,"available":2.0},"ELLA-BF-K-ECO-2":{"soh":1.0,"available":1.0},"ELLA-BF-K-ECO-3":{"soh":2.0,"available":2.0},"ELLA-BF-K-ECO-4":{"soh":1.0,"available":1.0},"ELLA-BF-Q-ECO-1":{"soh":3.0,"available":3.0},"ELLA-BF-Q-ECO-2":{"soh":4.0,"available":4.0},"ELLA-BF-Q-ECO-3":{"soh":4.0,"available":4.0},"ELLA-BF-Q-ECO-4":{"soh":4.0,"available":4.0},"ELNA-TV180-OAK-ECO-1":{"soh":1.0,"available":1.0},"EVE-BF-K-ECO-1":{"soh":4.0,"available":4.0},"EVE-BF-K-ECO-2":{"soh":4.0,"available":4.0},"EVE-BF-K-ECO-3":{"soh":2.0,"available":2.0},"EVE-BF-K-ECO-4":{"soh":2.0,"available":2.0},"EVE-BF-Q-ECO-1":{"soh":9.0,"available":8.0},"EVE-BF-Q-ECO-2":{"soh":9.0,"available":8.0},"EVE-BF-Q-ECO-3":{"soh":9.0,"available":8.0},"EVE-BF-Q-ECO-4":{"soh":9.0,"available":8.0},"FELX-BB-K-ECO-1":{"soh":2.0,"available":2.0},"FELX-BB-K-ECO-2":{"soh":2.0,"available":2.0},"FELX-BB-Q-ECO-1":{"soh":2.0,"available":2.0},"FELX-BB-Q-ECO-2":{"soh":1.0,"available":1.0},"HDSN-DSK-OAK-ECO-1":{"soh":1.0,"available":-5.0},"HDSN-DSK-OAK-ECO-2":{"soh":1.0,"available":-5.0},"HDSN-DT180-OAK-ECO-2":{"soh":7.0,"available":6.0},"IRNE-SB180-OAK-ECO-1":{"soh":3.0,"available":0.0},"JADN-FLAMP-ECO-1":{"soh":1.0,"available":1.0},"KTZ-DT-WHT-ECO-2":{"soh":2.0,"available":1.0},"MVS-DS-OAK-ECO-2":{"soh":2.0,"available":2.0},"MVS-DS-OAK-ECO-3":{"soh":2.0,"available":2.0},"ODEN-3COD-OAK-ECO-1":{"soh":1.0,"available":1.0},"ODEN-D120-OAK-ECO-1":{"soh":1.0,"available":-3.0},"ODEN-D120-OAK-ECO-2":{"soh":2.0,"available":-2.0},"ODEN-TV180-OAK-ECO-1":{"soh":3.0,"available":-4.0},"ODEN-TV180-OAK-ECO-2":{"soh":3.0,"available":-4.0},"OWEN-FLAMP-ECO-1":{"soh":1.0,"available":1.0},"OWEN-FLAMP-ECO-2":{"soh":1.0,"available":1.0},"PBLE-D140-WHT-ECO-1":{"soh":1.0,"available":1.0},"PBLE-D140-WHT-ECO-2":{"soh":1.0,"available":1.0},"SRT-DS100-WHT-ECO-1":{"soh":2.0,"available":1.0},"SRT-DS100-WHT-ECO-2":{"soh":1.0,"available":0.0},"SRT-DT-WHT-ECO-1":{"soh":2.0,"available":2.0},"SRT-DT-WHT-ECO-2":{"soh":1.0,"available":1.0},"TATE-CD160-OAK-ECO-2":{"soh":1.0,"available":0.0},"TATE-CT120-OAK-ECO-1":{"soh":1.0,"available":1.0},"TATE-CT120-OAK-ECO-2":{"soh":2.0,"available":2.0},"TATE-ED120-OAK-WHT-ECO-1":{"soh":1.0,"available":1.0},"TATE-ED120-OAK-WHT-ECO-2":{"soh":1.0,"available":1.0},"TATE-EDT-NAL-ECO-1":{"soh":4.0,"available":-35.0},"TATE-EDT-NAL-ECO-2":{"soh":2.0,"available":-37.0},"TATE-RDT-NATURAL-ECO-1":{"soh":4.0,"available":3.0},"TATE-RDT-NATURAL-ECO-2":{"soh":2.0,"available":1.0},"TATE-RODT-BLACK-ECO-1":{"soh":3.0,"available":3.0},"TATE-RODT-BLACK-ECO-2":{"soh":1.0,"available":1.0},"TATE-RODT-BLACK-ECO-3":{"soh":3.0,"available":3.0},"TATE-RODT-NATURAL-ECO-1":{"soh":2.0,"available":2.0},"TATE-RODT-NATURAL-ECO-2":{"soh":2.0,"available":2.0},"TATE-RODT220-BLACK-ECO-1":{"soh":3.0,"available":2.0},"TATE-RODT220-BLACK-ECO-2":{"soh":1.0,"available":0.0},"TATE-RODT220-BLACK-ECO-3":{"soh":3.0,"available":2.0},"TATE-RODT220-NATURAL-ECO-1":{"soh":4.0,"available":4.0},"TATE-RODT220-NATURAL-ECO-3":{"soh":4.0,"available":4.0},"TATE-SB160-NATURAL-ECO-2":{"soh":1.0,"available":1.0},"TATE-SB160-WNT-ECO-2":{"soh":1.0,"available":1.0},"TATE-TV-NATURAL-ECO-1":{"soh":1.0,"available":1.0},"TATE-TV200-BLACK-ECO-1":{"soh":12.0,"available":11.0},"TATE-TV200-BLACK-ECO-2":{"soh":10.0,"available":9.0},"TATE-TV200-NATURAL-ECO-1":{"soh":2.0,"available":1.0},"TATE-TV200-NATURAL-ECO-2":{"soh":4.0,"available":3.0},"TNTY-CST-OAK-ECO-1":{"soh":2.0,"available":2.0},"TNTY-CST-OAK-ECO-2":{"soh":1.0,"available":1.0},"WILY-ED160-BLK-ECO-1":{"soh":9.0,"available":9.0},"WILY-ED160-BLK-ECO-3":{"soh":5.0,"available":5.0},"ODEN-BEDROOM-SET-2":{"soh":1.0,"available":1.0},"ODEN-BEDROOM-SET-1":{"soh":1.0,"available":1.0},"LIFELY-SOFA-4S-RIGHT-OG":{"soh":1.0,"available":1.0},"ODEN-TV180-OAK-1":{"soh":5.0,"available":5.0},"ODEN-TV180-OAK-2":{"soh":5.0,"available":5.0},"AFI-BF-K-ECO-1":{"soh":1.0,"available":1.0},"AFI-BF-K-ECO-2":{"soh":2.0,"available":2.0},"AFI-BF-K-WHT-ECO":{"soh":1.0,"available":1.0},"ALXS-CHR-WHT-ECO":{"soh":3.0,"available":1.0},"AMBR-DC-GRN-ECO":{"soh":2.0,"available":2.0},"AMBR-DC-WHT-ECO":{"soh":6.0,"available":0.0},"ARLO-BT-WHT-ECO":{"soh":1.0,"available":1.0},"BLC-BT-OAK-ECO":{"soh":4.0,"available":-1.0},"BLC-BT-WNT-ECO":{"soh":1.0,"available":1.0},"CARY-OTM-GY-ECO":{"soh":5.0,"available":5.0},"CARY-SOFA-CORNER-GY-ECO":{"soh":7.0,"available":7.0},"CARY-SOFA-RIGHT-GY-ECO":{"soh":3.0,"available":1.0},"CL-WB102-S-ECO":{"soh":10.0,"available":10.0},"CL-WB147-D-ECO":{"soh":1.0,"available":1.0},"CL-WB147-D-WNT-ECO":{"soh":1.0,"available":1.0},"CL-WB163-Q-ECO":{"soh":7.0,"available":6.0},"CL-WB193-K-WNT-ECO":{"soh":1.0,"available":1.0},"CPA-V3-BT603-WOK-ECO":{"soh":1.0,"available":-1.0},"FRK-AC-GRN-ECO":{"soh":1.0,"available":-1.0},"HANK-BT-WNT-ECO":{"soh":26.0,"available":18.0},"HAZ-CT-WNT-ECO":{"soh":8.0,"available":6.0},"IRNE-BT-OAK-ECO":{"soh":2.0,"available":-5.0},"KTZ-ST-WHT-ECO":{"soh":1.0,"available":1.0},"LOLA-BSF-NAL-ECO":{"soh":129.0,"available":129.0},"LORA-AC-ORG-ECO":{"soh":1.0,"available":1.0},"LYLA-BF-Q-ECO":{"soh":1.0,"available":1.0},"NOAH-DB140-WHT-ECO":{"soh":4.0,"available":1.0},"NOAH-DB160-WHT-ECO":{"soh":1.0,"available":0.0},"ODEN-BT-OAK-ECO":{"soh":1.0,"available":-1.0},"TATE-CT-NATURAL-ECO":{"soh":2.0,"available":2.0},"TATE-RODT-BLACK-ECO":{"soh":1.0,"available":1.0},"TATE-SB-BLACK-ECO":{"soh":1.0,"available":1.0},"TATE-SB-NATURAL-ECO":{"soh":1.0,"available":1.0},"TATE-SB160-NATURAL-ECO":{"soh":3.0,"available":3.0},"TIM-OC-BRN-ECO":{"soh":1.0,"available":1.0},"WILY-ED160-WNT-ECO":{"soh":4.0,"available":4.0},"EVE-BF-K-NAL-ECO":{"soh":3.0,"available":3.0},"NOAH-DC-WNT-ECO":{"soh":4.0,"available":1.0},"MORI-RUG-200-ECO":{"soh":1.0,"available":1.0},"MORI-RUG-160-ECO":{"soh":1.0,"available":1.0},"JOSE-BF-K-ECO-1":{"soh":1.0,"available":1.0},"MLW-RUG-160-MG":{"soh":1.0,"available":1.0},"MLW-RUG-200-MG":{"soh":4.0,"available":4.0},"IRNE-TV180-OAK":{"soh":1.0,"available":1.0},"DIRI-DS-CRM-1":{"soh":1.0,"available":1.0},"DIRI-DS-CRM-2":{"soh":2.0,"available":2.0},"DIRI-DS-CRM-3":{"soh":1.0,"available":1.0},"LIFELY-FS-LB":{"soh":498.0,"available":496.0},"LIFELY-FS-OG":{"soh":498.0,"available":496.0},"LIFELY-FS-RST":{"soh":498.0,"available":498.0},"LIFELY-FS-WHT":{"soh":498.0,"available":498.0},"LIFELY-OTM-LB-1":{"soh":2.0,"available":2.0},"LIFELY-OTM-LB-2":{"soh":1.0,"available":1.0},"LIFELY-OTM-RST-1":{"soh":2.0,"available":2.0},"LIFELY-OTM-WHT":{"soh":1.0,"available":1.0},"LIFELY-OTM-WHT-1":{"soh":5.0,"available":5.0},"LIFELY-SOFA-AMCR-LB-1":{"soh":2.0,"available":1.0},"LIFELY-SOFA-AMCR-LB-2":{"soh":3.0,"available":2.0},"LIFELY-SOFA-AMCR-OG-1":{"soh":3.0,"available":3.0},"LIFELY-SOFA-AMCR-RST-1":{"soh":3.0,"available":3.0},"LIFELY-SOFA-AMCR-RST-2":{"soh":4.0,"available":4.0},"LIFELY-SOFA-AMCR-WHT-1":{"soh":10.0,"available":9.0},"LIFELY-SOFA-AMCR-WHT-2":{"soh":7.0,"available":6.0},"LIFELY-SOFA-AMLS-LB-1":{"soh":1.0,"available":1.0},"LIFELY-SOFA-AMLS-RST-1":{"soh":1.0,"available":1.0},"LIFELY-SOFA-AMLS-WHT-1":{"soh":3.0,"available":3.0},"LIFELY-SOFA-CRNR-LB-1":{"soh":5.0,"available":5.0},"LIFELY-SOFA-CRNR-LB-2":{"soh":2.0,"available":2.0},"LIFELY-SOFA-CRNR-RST-1":{"soh":2.0,"available":2.0},"LIFELY-OTM-OG-2":{"soh":2.0,"available":1.0},"LIFELY-OTM-OG-1":{"soh":7.0,"available":6.0},"LIFELY-SOFA-AMLS-OG-2":{"soh":1.0,"available":1.0},"LIFELY-SOFA-AMLS-OG-1":{"soh":2.0,"available":2.0},"LIFELY-SOFA-CRNR-OG-2":{"soh":1.0,"available":1.0},"LIFELY-SOFA-CRNR-OG-1":{"soh":2.0,"available":2.0},"CARY-SOFA-RIGHT-GY":{"soh":2.0,"available":2.0},"CARY-SOFA-LEFT-GY":{"soh":2.0,"available":2.0},"CARY-SOFA-GY":{"soh":2.0,"available":2.0},"CARY-SOFA-CORNER-GY":{"soh":2.0,"available":2.0},"CARY-OTM-GY":{"soh":2.0,"available":2.0},"MLW-RUG-240":{"soh":3.0,"available":1.0},"MLW-RUG-160-SF":{"soh":2.0,"available":2.0},"MLW-RUG-200-SF":{"soh":1.0,"available":1.0},"BEN-RUG-240":{"soh":1.0,"available":1.0},"LYLA-BF-K-1":{"soh":2.0,"available":2.0},"LYLA-BF-K-2":{"soh":2.0,"available":2.0},"LYLA-BF-Q-2":{"soh":1.0,"available":1.0},"JOSE-V2-BF-K-1":{"soh":1.0,"available":1.0},"JOSE-V2-BF-K-2":{"soh":2.0,"available":2.0},"KAEL-SOFA-3S-BG-1":{"soh":7.0,"available":7.0},"KAEL-SOFA-3S-BG-2":{"soh":7.0,"available":7.0},"WILY-ED160-BLK-1":{"soh":7.0,"available":7.0},"WILY-ED160-BLK-2":{"soh":2.0,"available":2.0},"WILY-ED160-BLK-3":{"soh":2.0,"available":2.0},"MVS-DS-OAK-2":{"soh":2.0,"available":2.0},"MVS-DS-OAK-3":{"soh":2.0,"available":2.0},"TATE-EDT-NAL-1":{"soh":2.0,"available":2.0},"TATE-EDT-NAL-2":{"soh":5.0,"available":5.0},"TATE-EDT-NAL-3":{"soh":2.0,"available":2.0},"BLC-CT-BLK-1":{"soh":1.0,"available":1.0},"BLC-CT-BLK-2":{"soh":4.0,"available":4.0},"ELLA-BF-K-4":{"soh":7.0,"available":7.0},"ELLA-BF-Q-3":{"soh":1.0,"available":1.0},"ELLA-BF-Q-4":{"soh":1.0,"available":1.0},"CLB-D170-WNT-1":{"soh":3.0,"available":3.0},"CLB-D170-WNT-2":{"soh":4.0,"available":4.0},"CLUD-CT-RST-1":{"soh":1.0,"available":1.0},"ALLY-4CODBT-WHT":{"soh":1.0,"available":1.0},"BLC-V2SET-Q-OAK":{"soh":2.0,"available":2.0},"MS153-M-S":{"soh":1.0,"available":1.0},"FRK-AC-TD":{"soh":1.0,"available":1.0},"AMBR-DC-GRN":{"soh":2.0,"available":2.0},"HANK-BT-ASH":{"soh":3.0,"available":3.0},"ILIA-BT-WHT":{"soh":1.0,"available":1.0},"JAX-DS-ABR":{"soh":2.0,"available":2.0},"CAM-DSK150-WG":{"soh":2.0,"available":2.0},"IRNE-SB180-OAK-1":{"soh":1.0,"available":1.0},"ELNA-BF-Q-2":{"soh":7.0,"available":7.0},"ELNA-BF-Q-3":{"soh":1.0,"available":1.0},"ELNA-BF-K":{"soh":5.0,"available":5.0},"ELNA-BF-K-1":{"soh":1.0,"available":1.0},"ELNA-BF-K-2":{"soh":2.0,"available":2.0},"ELNA-BF-K-3":{"soh":3.0,"available":3.0},"ELNA-BF-K-4":{"soh":2.0,"available":2.0},"OSSI-DT120-OAK-1":{"soh":2.0,"available":2.0},"OSSI-DT120-OAK-2":{"soh":1.0,"available":1.0},"TATE-EDT-BLK-1":{"soh":12.0,"available":11.0},"TATE-EDT-BLK-2":{"soh":12.0,"available":11.0},"PARTS-GENERIC":{"soh":9.0,"available":9.0},"EMMA-DT180-OAK-3":{"soh":4.0,"available":4.0},"RAI-DT100-OAK-2":{"soh":1.0,"available":1.0},"RAI-DT100-OAK-1":{"soh":1.0,"available":1.0},"OWEN-FLAMP-2":{"soh":1.0,"available":1.0},"MAY-TV200-OAK-2":{"soh":1.0,"available":1.0}}, pos: [{"reference":"PO-2173","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"11-Jun-26"},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":7672.5796,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"FRK-AC-TD-ECO":50.0}},{"reference":"PO-2172","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"22-Jun-26"},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":40259.7305,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"BLC-6COD-WNT-ECO":25.0,"BLC-BBK-OAK-ECO":25.0,"BLC-BT-OAK-ECO":50.0,"BLC-V2-BBQ-OAK-ECO":25.0,"IRNE-SB180-OAK-ECO":25.0,"IRNE-TV200-OAK-ECO":25.0,"NOAH-DC-WHT-ECO":60.0}},{"reference":"PO-2171","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"6-Jun-26"},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":40259.7305,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"BLC-6COD-WNT-ECO":25.0,"BLC-BBK-OAK-ECO":25.0,"BLC-BT-OAK-ECO":50.0,"BLC-V2-BBQ-OAK-ECO":25.0,"IRNE-SB180-OAK-ECO":25.0,"IRNE-TV200-OAK-ECO":25.0,"NOAH-DC-WHT-ECO":60.0}},{"reference":"PO-2170","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"6-Jun-26"},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":13159.8945,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"AFI-BF-K-ECO":22.0,"AFI-BF-Q-ECO":22.0}},{"reference":"PO-2169","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"16-Jun-26"},"company":"Aibang Home Furnishings Co.,Ltd.","total":35748.5352,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EMMA-DT180-OAK-ECO":25.0,"EVE-BF-K-ECO":20.0,"EVE-BF-Q-ECO":20.0,"HANK-BT-WNT-ECO":75.0,"HDSN-DSK-OAK-ECO":25.0,"HDSN-DT180-OAK-ECO":25.0,"ODEN-D120-OAK-ECO":25.0,"LARY-6COD-ECO":25.0}},{"reference":"PO-2168","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"1-Jun-26"},"company":"Aibang Home Furnishings Co.,Ltd.","total":35748.5352,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EMMA-DT180-OAK-ECO":25.0,"EVE-BF-K-ECO":20.0,"EVE-BF-Q-ECO":20.0,"HANK-BT-WNT-ECO":75.0,"HDSN-DSK-OAK-ECO":25.0,"HDSN-DT180-OAK-ECO":25.0,"ODEN-D120-OAK-ECO":25.0,"LARY-6COD-ECO":25.0}},{"reference":"PO-2167","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"4-Jun-26"},"company":"Caoxian Dianshang Furniture Co., Ltd","total":33777.1094,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CL-WB102-S-ECO":20.0,"CL-WB117-KS-ECO":60.0,"CL-WB163-Q-ECO":90.0,"CL-WB163-Q-WNT-ECO":50.0,"CLV2-WB147-D-WNT-ECO":20.0,"CLV2-WB163-Q-ECO":25.0,"CLV2-WB163-Q-WNT-ECO":100.0,"CLV2-WB193-K-WNT-ECO":25.0}},{"reference":"PO-2166","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"4-Jun-26"},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":14989.9473,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LYLA-BF-GL-K-ECO":22.0,"LYLA-BF-GL-Q-ECO":18.0}},{"reference":"PO-2157","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":"4-May-26"},"company":"Aibang Home Furnishings Co.,Ltd.","total":42216.9492,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EMMA-DT180-OAK-ECO":25.0,"HANK-BT-ASH-ECO":50.0,"HANK-BT-WNT-ECO":60.0,"HDSN-DSK-OAK-ECO":25.0,"ODEN-TV180-OAK-ECO":25.0,"TATE-EDT-NAL-ECO":25.0,"TATE-EDT-WNT-ECO":35.0}},{"reference":"PO-2156","status":"APPROVED","stage":"","arrival":"2026-03-24T05:43:00Z","estimatedArrivalDate":"2026-04-08T06:43:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"20-Apr-26"},"company":"Aibang Home Furnishings Co.,Ltd.","total":41968.2099,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EMMA-DT180-OAK-ECO":25.0,"HANK-BT-ASH-ECO":50.0,"HANK-BT-WNT-ECO":60.0,"HDSN-DSK-OAK-ECO":25.0,"ODEN-TV180-OAK-ECO":25.0,"TATE-EDT-NAL-ECO":25.0,"TATE-EDT-WNT-ECO":35.0}},{"reference":"PO-2154","status":"APPROVED","stage":"","arrival":"2026-03-21T05:42:00Z","estimatedArrivalDate":"2026-04-10T06:42:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"24-Apr-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":47478.5635,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-137DMF":50.0,"DD-153QMF":90.0,"DD-183KMF":50.0,"DD-21107CF":50.0,"DD-21137CF":110.0,"DD-21915CF":60.0}},{"reference":"PO-2153","status":"APPROVED","stage":"","arrival":"2026-03-19T05:41:00Z","estimatedArrivalDate":"2026-04-05T06:41:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"22-Apr-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":48541.7346,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-137DMF":40.0,"DD-153QMF":60.0,"DD-183KMF":40.0,"DD-21107CF":100.0,"DD-21137CF":140.0,"DD-21915CF":100.0}},{"reference":"PO-2152","status":"APPROVED","stage":"","arrival":"2026-02-26T05:39:00Z","estimatedArrivalDate":"2026-03-14T05:39:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"17-Mar-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":51492.2569,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-137DMF":30.0,"DD-183KMF":10.0,"DD-21107CF":200.0,"DD-21137CF":200.0,"DD-21915CF":200.0}},{"reference":"PO-LF0015-1","status":"APPROVED","stage":"Received","arrival":"2026-02-02T13:00:00Z","estimatedArrivalDate":"2026-02-18T13:00:00Z","fullyReceivedDate":"2026-03-08T22:35:00Z","customFields":{"orders_1000":"2-Mar-26"},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":54874.7145,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSF-AMLS-FC":150.0,"LFSF-CRNR-FC":80.0,"LFSF-OTM-FC":40.0,"LFSF-AMLS-CV-OG":50.0,"LFSF-CRNR-CV-OG":100.0,"LFSF-OTM-CV-OG":20.0,"LFSF-AMLS-CV-DKGN":30.0,"LFSF-CRNR-CV-DKGN":50.0,"LFSF-OTM-CV-DKGN":20.0,"LFSF-AMLS-CV-BLST":30.0,"LFSF-CRNR-CV-BLST":40.0,"LFSF-OTM-CV-BLST":20.0}},{"reference":"PO-LF0015-2","status":"APPROVED","stage":"Received","arrival":"2026-02-25T13:00:00Z","estimatedArrivalDate":"2026-03-13T13:00:00Z","fullyReceivedDate":"2026-03-17T23:39:00Z","customFields":{"orders_1000":"10-Mar-26"},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":52069.536,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSF-AMLS-FC":50.0,"LFSF-CRNR-FC":180.0,"LFSF-OTM-FC":40.0,"LFSF-AMLS-CV-OG":50.0,"LFSF-CRNR-CV-OG":80.0,"LFSF-AMLS-CV-DKGN":20.0,"LFSF-CRNR-CV-DKGN":50.0,"LFSF-OTM-CV-DKGN":10.0,"LFSF-AMLS-CV-BLST":20.0,"LFSF-CRNR-CV-BLST":20.0,"LFSF-OTM-CV-BLST":10.0}},{"reference":"PO-AU002-11","status":"APPROVED","stage":"","arrival":"2026-02-11T05:00:00Z","estimatedArrivalDate":"2026-03-26T13:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"25-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":61598.5267,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DSBL":27.0,"LLAU-CB-KS-DSBL":68.0,"LLAU-CB-D-DSBL":53.0,"LLAU-CB-D-DGY":3.0,"LLAU-CB-S-PST":3.0,"LLAU-CB-D-MSM":140.0}},{"reference":"PO-AU002-12","status":"APPROVED","stage":"","arrival":"2026-02-11T05:01:00Z","estimatedArrivalDate":"2026-03-26T13:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"25-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":60210.2035,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DSBL":26.0,"LLAU-CB-KS-DSBL":67.0,"LLAU-CB-D-DSBL":52.0,"LLAU-CB-KS-CTCN":2.0,"LLAU-CB-D-MSM":140.0}},{"reference":"PO-UK001","status":"APPROVED","stage":"","arrival":"2026-03-29T13:00:00Z","estimatedArrivalDate":"2026-06-11T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":41635.1202,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSB-AMST-DNM-UK":25.0,"LFSB-AMST-LTGN-UK":85.0,"LFSB-AMST-WHT-UK":33.0,"LFSB-CHS-DNM-UK":1.0,"LFSB-CHS-LTGN-UK":3.0,"LFSB-CHS-WHT-UK":1.0,"LFSB-D-DNM-UK":4.0,"LFSB-D-LTGN-UK":14.0,"LFSB-D-WHT-UK":11.0,"LFSB-Q-DNM-UK":15.0,"LFSB-Q-LTGN-UK":40.0,"LFSB-Q-WHT-UK":10.0,"LFSB-S-DNM-UK":1.0,"LFSB-S-LTGN-UK":1.0,"LFSB-SOTM-DNM-UK":3.0,"LFSB-SOTM-LTGN-UK":5.0,"LFSB-SOTM-WHT-UK":3.0,"LFSB-S-WHT-UK":1.0,"LFSB-TW-DNM-UK":10.0,"LFSB-TW-LTGN-UK":46.0,"LFSB-TW-WHT-UK":14.0}},{"reference":"PO-UK002","status":"APPROVED","stage":"","arrival":"2026-03-29T13:00:00Z","estimatedArrivalDate":"2026-06-11T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":89293.6687,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CUSB-ARST-SET-DNM-UK":44.0,"CUSB-ARST-SET-LTGN-UK":67.0,"CUSB-ARST-SET-TBRN-UK":32.0,"CUSB-ARST-SET-TWHT-UK":54.0,"CUSB-D-DNM-UK":11.0,"CUSB-D-LTGN-UK":14.0,"CUSB-D-TBRN-UK":8.0,"CUSB-D-TWHT-UK":12.0,"CUSB-K-DNM-UK":6.0,"CUSB-K-LTGN-UK":12.0,"CUSB-K-TBRN-UK":6.0,"CUSB-K-TWHT-UK":12.0,"CUSB-Q-DNM-UK":16.0,"CUSB-Q-LTGN-UK":27.0,"CUSB-Q-TBRN-UK":10.0,"CUSB-Q-TWHT-UK":18.0,"CUSB-TW-DNM-UK":11.0,"CUSB-TW-LTGN-UK":14.0,"CUSB-TW-TBRN-UK":8.0,"CUSB-TW-TWHT-UK":12.0}},{"reference":"PO-UK003","status":"APPROVED","stage":"","arrival":"2026-03-29T13:00:00Z","estimatedArrivalDate":"2026-06-11T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":39669.7932,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLUK-CB-S-FRM":43.0,"LLUK-CB-SD-FRM":38.0,"LLUK-CB-D-FRM":51.0,"LLUK-CB-S-DGY-CV":6.0,"LLUK-CB-SD-DGY-CV":6.0,"LLUK-CB-D-DGY-CV":17.0,"LLUK-CB-S-PST-CV":15.0,"LLUK-CB-SD-PST-CV":5.0,"LLUK-CB-D-PST-CV":12.0,"LLUK-CB-S-BABL-CV":5.0,"LLUK-CB-SD-BABL-CV":12.0,"LLUK-CB-D-BABL-CV":15.0,"LLUK-CB-S-CTCN-CV":12.0,"LLUK-CB-SD-CTCN-CV":5.0,"LLUK-CB-D-CTCN-CV":12.0,"LLUK-CB-S-MSM-CV":16.0,"LLUK-CB-SD-MSM-CV":22.0,"LLUK-CB-D-MSM-CV":5.0}},{"reference":"PO-2164","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-06-03T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"4-Jun-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":52459.8762,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":176.0,"DD-21137CF":322.0,"DD-21915CF":161.0}},{"reference":"PO-2163","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-06-03T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"4-Jun-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":52549.6738,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":176.0,"DD-21137CF":323.0,"DD-21915CF":161.0}},{"reference":"PO-2162","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-05-14T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"15-May-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":20621.8958,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":95.0,"DD-21137CF":100.0,"DD-21915CF":70.0}},{"reference":"PO-2161","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-05-14T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"15-May-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":53063.2533,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":160.0,"DD-21137CF":350.0,"DD-21915CF":150.0}},{"reference":"PO-2160","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-05-14T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"15-May-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":53063.2533,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":160.0,"DD-21137CF":350.0,"DD-21915CF":150.0}},{"reference":"PO-AU002-3","status":"APPROVED","stage":"Received","arrival":"2026-02-06T05:05:00Z","estimatedArrivalDate":"2026-02-21T13:00:00Z","fullyReceivedDate":"2026-03-06T05:09:00Z","customFields":{"orders_1000":"9-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":77995.5434,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DGY":40.0,"LLAU-CB-S-PST":6.0,"LLAU-CB-KS-PST":42.0,"LLAU-CB-D-PST":162.0,"LLAU-CB-KS-BABL":30.0,"LLAU-CB-S-DSBL-CV":1.0,"LLAU-CB-KS-DSBL-CV":1.0,"LLAU-CB-D-DSBL-CV":4.0,"LLAU-CB-S-DGY-CV":5.0,"LLAU-CB-KS-DGY-CV":11.0,"LLAU-CB-D-DGY-CV":11.0,"LLAU-CB-S-PST-CV":7.0,"LLAU-CB-KS-PST-CV":15.0,"LLAU-CB-D-PST-CV":11.0,"LLAU-CB-S-BABL-CV":4.0,"LLAU-CB-KS-BABL-CV":7.0,"LLAU-CB-D-BABL-CV":21.0,"LLAU-CB-S-CTCN-CV":4.0,"LLAU-CB-KS-CTCN-CV":20.0,"LLAU-CB-D-CTCN-CV":17.0,"LLAU-CB-S-MSM-CV":16.0,"LLAU-CB-KS-MSM-CV":32.0,"LLAU-CB-D-MSM-CV":55.0}},{"reference":"PO-AU002-4","status":"APPROVED","stage":"Received","arrival":"2026-02-06T05:06:00Z","estimatedArrivalDate":"2026-02-21T13:00:00Z","fullyReceivedDate":"2026-03-03T06:26:00Z","customFields":{"orders_1000":"9-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":63996.6294,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DGY":14.0,"LLAU-CB-KS-DGY":25.0,"LLAU-CB-KS-BABL":39.0,"LLAU-CB-D-BABL":77.0,"LLAU-CB-S-CTCN":180.0}},{"reference":"PO-AU002-5","status":"APPROVED","stage":"Received","arrival":"2026-02-06T05:07:00Z","estimatedArrivalDate":"2026-02-21T13:00:00Z","fullyReceivedDate":"2026-03-05T01:40:00Z","customFields":{"orders_1000":"9-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":59709.6218,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-D-DGY":10.0,"LLAU-CB-KS-CTCN":158.0,"LLAU-CB-D-CTCN":124.0}},{"reference":"PO-AU002-6","status":"APPROVED","stage":"Received","arrival":"2026-02-01T05:08:00Z","estimatedArrivalDate":"2026-02-17T13:00:00Z","fullyReceivedDate":"2026-02-27T03:58:00Z","customFields":{"orders_1000":"2-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":65729.4557,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-D-DSBL":60.0,"LLAU-CB-S-DGY":30.0,"LLAU-CB-KS-DGY":30.0,"LLAU-CB-D-DGY":13.0,"LLAU-CB-KS-PST":5.0,"LLAU-CB-D-PST":76.0,"LLAU-CB-D-BABL":32.0,"LLAU-CB-D-CTCN":37.0,"LLAU-CB-D-MSM":35.0}},{"reference":"PO-AU002-7","status":"APPROVED","stage":"Received","arrival":"2026-02-01T05:29:00Z","estimatedArrivalDate":"2026-02-17T13:00:00Z","fullyReceivedDate":"2026-02-27T03:47:00Z","customFields":{"orders_1000":"2-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":65940.1972,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-D-DSBL":60.0,"LLAU-CB-S-DGY":30.0,"LLAU-CB-KS-DGY":30.0,"LLAU-CB-D-DGY":13.0,"LLAU-CB-KS-PST":5.0,"LLAU-CB-D-PST":76.0,"LLAU-CB-D-BABL":32.0,"LLAU-CB-D-CTCN":38.0,"LLAU-CB-D-MSM":35.0}},{"reference":"PO-AU002-8","status":"APPROVED","stage":"Received","arrival":"2026-02-06T05:33:00Z","estimatedArrivalDate":"2026-02-20T13:00:00Z","fullyReceivedDate":"2026-03-04T20:27:00Z","customFields":{"orders_1000":"16-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":65465.605,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DSBL":11.0,"LLAU-CB-D-DSBL":30.0,"LLAU-CB-D-DGY":32.0,"LLAU-CB-S-PST":22.0,"LLAU-CB-KS-PST":15.0,"LLAU-CB-D-CTCN":27.0,"LLAU-CB-S-MSM":122.0,"LLAU-CB-KS-MSM":70.0}},{"reference":"PO-AU002-9","status":"APPROVED","stage":"Received","arrival":"2026-02-06T05:38:00Z","estimatedArrivalDate":"2026-03-20T13:00:00Z","fullyReceivedDate":"2026-03-06T05:30:00Z","customFields":{"orders_1000":"16-Mar-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":66059.9752,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DSBL":20.0,"LLAU-CB-D-DSBL":20.0,"LLAU-CB-D-DGY":35.0,"LLAU-CB-KS-PST":30.0,"LLAU-CB-D-BABL":8.0,"LLAU-CB-D-CTCN":30.0,"LLAU-CB-S-MSM":136.0,"LLAU-CB-KS-MSM":6.0,"LLAU-CB-D-MSM":45.0}},{"reference":"PO-AU002-10","status":"APPROVED","stage":"Received","arrival":"2026-02-06T05:00:00Z","estimatedArrivalDate":"2026-02-20T13:00:00Z","fullyReceivedDate":"2026-03-04T20:37:00Z","customFields":{"orders_1000":"16-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":63625.7131,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-D-DSBL":59.0,"LLAU-CB-S-DGY":2.0,"LLAU-CB-KS-PST":15.0,"LLAU-CB-S-BABL":15.0,"LLAU-CB-D-CTCN":33.0,"LLAU-CB-KS-MSM":65.0,"LLAU-CB-D-MSM":115.0}},{"reference":"PO-AU002-1","status":"APPROVED","stage":"Received","arrival":"2026-01-16T04:59:00Z","estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-06T05:47:00Z","customFields":{"orders_1000":"9-2-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":63968.9449,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DGY":17.0,"LLAU-CB-KS-DGY":10.0,"LLAU-CB-D-DGY":12.0,"LLAU-CB-S-PST":2.0,"LLAU-CB-KS-PST":12.0,"LLAU-CB-D-PST":40.0,"LLAU-CB-KS-BABL":8.0,"LLAU-CB-D-BABL":13.0,"LLAU-CB-S-CTCN":25.0,"LLAU-CB-KS-CTCN":20.0,"LLAU-CB-D-CTCN":38.0,"LLAU-CB-S-MSM":36.0,"LLAU-CB-KS-MSM":12.0,"LLAU-CB-D-MSM":70.0}},{"reference":"PO-AU002-2","status":"APPROVED","stage":"Received","arrival":"2026-01-16T05:02:00Z","estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-06T05:52:00Z","customFields":{"orders_1000":"9-2-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":63968.9449,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DGY":17.0,"LLAU-CB-KS-DGY":10.0,"LLAU-CB-D-DGY":12.0,"LLAU-CB-S-PST":2.0,"LLAU-CB-KS-PST":12.0,"LLAU-CB-D-PST":40.0,"LLAU-CB-KS-BABL":8.0,"LLAU-CB-D-BABL":13.0,"LLAU-CB-S-CTCN":25.0,"LLAU-CB-KS-CTCN":20.0,"LLAU-CB-D-CTCN":38.0,"LLAU-CB-S-MSM":36.0,"LLAU-CB-KS-MSM":12.0,"LLAU-CB-D-MSM":70.0}},{"reference":"PO-2143","status":"APPROVED","stage":"Received","arrival":"2026-01-15T04:31:00Z","estimatedArrivalDate":"2026-02-02T13:00:00Z","fullyReceivedDate":"2026-02-11T00:46:00Z","customFields":{"orders_1000":"16-2-2026"},"company":"Aibang Home Furnishings Co.,Ltd.","total":41991.5158,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"HAZ-CT-WNT-ECO":20.0,"HDSN-DT180-OAK-ECO":20.0,"PBLE-D140-WHT-ECO":18.0,"HDSN-DT180-OAK-ECO-1":20.0,"HDSN-DT180-OAK-ECO-2":20.0,"PBLE-D140-WHT-ECO-1":18.0,"PBLE-D140-WHT-ECO-2":18.0,"BNC-6COD-WNT-ECO":20.0,"BNC-6COD-WNT-ECO-1":20.0,"BNC-6COD-WNT-ECO-2":20.0,"BNC-6COD-WNT-ECO-3":20.0,"GEM-RTDSK-WNT-ECO":25.0,"GEM-RTDSK-WNT-ECO-1":25.0,"GEM-RTDSK-WNT-ECO-2":25.0,"GEM-RTDSK-WNT-ECO-3":25.0,"HANK-CT-WNT-ECO":50.0,"HANK-CT-WNT-ECO-1":50.0,"HANK-CT-WNT-ECO-2":50.0,"HANK-SB160-WNT-ECO":50.0,"HANK-SB160-WNT-ECO-1":50.0,"HANK-SB160-WNT-ECO-2":50.0,"HANK-SB160-WNT-ECO-3":50.0}},{"reference":"PO-2148","status":"APPROVED","stage":"Received","arrival":"2026-01-17T04:34:00Z","estimatedArrivalDate":"2026-02-02T13:00:00Z","fullyReceivedDate":"2026-02-18T21:14:00Z","customFields":{"orders_1000":"15-2-2026"},"company":"Aibang Home Furnishings Co.,Ltd.","total":42323.4478,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CAM-DSK150-WG-ECO":25.0,"HANK-BT-WNT-ECO":114.0,"ODEN-D120-OAK-ECO":50.0,"TATE-EDT-WNT-ECO":30.0,"CAM-DSK150-WG-ECO-1":25.0,"CAM-DSK150-WG-ECO-2":25.0,"ODEN-D120-OAK-ECO-1":50.0,"ODEN-D120-OAK-ECO-2":50.0,"ODEN-SC-OAK-ECO":30.0,"TATE-EDT-WNT-ECO-1":30.0,"TATE-EDT-WNT-ECO-2":30.0,"TATE-EDT-WNT-ECO-3":30.0,"ODEN-SC-OAK-ECO-1":30.0,"ODEN-SC-OAK-ECO-2":30.0,"ODEN-SC-OAK-ECO-3":30.0,"MAX-SC-ECO":30.0,"MAX-SC-ECO-1":30.0,"MAX-SC-ECO-2":30.0,"MAX-SC-ECO-3":30.0,"MAX-SC-ECO-4":30.0}},{"reference":"PO-2124-1","status":"APPROVED","stage":"Received","arrival":"2026-01-19T04:55:00Z","estimatedArrivalDate":"2026-02-13T13:00:00Z","fullyReceivedDate":"2026-03-03T06:12:00Z","customFields":{"orders_1000":"24-2-2026"},"company":"Aibang Home Furnishings Co.,Ltd.","total":42381.3593,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"KTZ-DT110-WHT-ECO":9.0,"KTZ-DT110-WHT-ECO-1":9.0,"KTZ-DT110-WHT-ECO-2":9.0,"BRL-BWD-BT-ECO":20.0,"SILV-MR16-OW-ECO":25.0,"OLV-MR18-WNT-ECO":25.0,"MEG-MR16-WNT-ECO":25.0,"JILN-6COD-OAK-ECO":25.0,"JILN-6COD-OAK-ECO-1":25.0,"JILN-6COD-OAK-ECO-2":25.0,"ODEN-DSK-ADJ-OAK-ECO":13.0,"ODEN-DSK-ADJ-OAK-ECO-1":13.0,"ODEN-DSK-ADJ-OAK-ECO-2":13.0,"CAM-DSK-ADJ-WG-ECO":13.0,"CAM-DSK-ADJ-WG-ECO-1":13.0,"CAM-DSK-ADJ-WG-ECO-2":13.0,"ALX-BF-K-NAL-ECO":10.0,"ALX-BF-K-NAL-ECO-1":10.0,"ALX-BF-K-NAL-ECO-2":10.0,"ALX-BF-K-NAL-ECO-3":10.0,"ALX-BF-Q-NAL-ECO":10.0,"ALX-BF-Q-NAL-ECO-1":10.0,"ALX-BF-Q-NAL-ECO-2":10.0,"ALX-BF-Q-NAL-ECO-3":10.0,"IRSA-BF-K-WNT-ECO":10.0,"IRSA-BF-K-WNT-ECO-1":10.0,"IRSA-BF-K-WNT-ECO-2":10.0,"IRSA-BF-K-WNT-ECO-3":10.0,"IRSA-BF-Q-WNT-ECO":10.0,"IRSA-BF-Q-WNT-ECO-1":10.0,"IRSA-BF-Q-WNT-ECO-2":10.0,"IRSA-BF-Q-WNT-ECO-3":10.0,"JAM-BF-K-OAK-ECO":10.0,"JAM-BF-K-OAK-ECO-1":10.0,"JAM-BF-K-OAK-ECO-2":10.0,"JAM-BF-K-OAK-ECO-3":10.0,"JAM-BF-Q-OAK-ECO":10.0,"JAM-BF-Q-OAK-ECO-1":10.0,"JAM-BF-Q-OAK-ECO-2":10.0,"JAM-BF-Q-OAK-ECO-3":10.0,"KTH-SB180-WNT-ECO":10.0,"KTH-SB180-WNT-ECO-1":10.0,"KTH-SB180-WNT-ECO-2":10.0,"KTH-SB180-WNT-ECO-3":10.0,"KTH-SB180-WNT-ECO-4":10.0,"WIBR-DSK-ECO":20.0,"WIBR-DSK-ECO-1":20.0,"WIBR-DSK-ECO-2":20.0}},{"reference":"PO-2149","status":"APPROVED","stage":"Received","arrival":"2026-01-29T04:56:00Z","estimatedArrivalDate":"2026-02-14T13:00:00Z","fullyReceivedDate":"2026-02-25T21:58:00Z","customFields":{"orders_1000":"2-3-2026"},"company":"Aibang Home Furnishings Co.,Ltd.","total":37475.8282,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CAM-DSK150-WG-ECO":25.0,"HANK-BT-WNT-ECO":72.0,"HDSN-DSK-OAK-ECO":50.0,"ODEN-D120-OAK-ECO":30.0,"TATE-EDT-WNT-ECO":20.0,"CAM-DSK150-WG-ECO-1":25.0,"CAM-DSK150-WG-ECO-2":25.0,"HDSN-DSK-OAK-ECO-1":50.0,"HDSN-DSK-OAK-ECO-2":50.0,"ODEN-D120-OAK-ECO-1":30.0,"ODEN-D120-OAK-ECO-2":30.0,"ODEN-SC-OAK-ECO":20.0,"TATE-EDT-WNT-ECO-1":20.0,"TATE-EDT-WNT-ECO-2":20.0,"TATE-EDT-WNT-ECO-3":20.0,"ODEN-SC-OAK-ECO-1":20.0,"ODEN-SC-OAK-ECO-2":20.0,"ODEN-SC-OAK-ECO-3":20.0,"MAX-SC-ECO":30.0,"MAX-SC-ECO-1":30.0,"MAX-SC-ECO-2":30.0,"MAX-SC-ECO-3":30.0,"MAX-SC-ECO-4":30.0}},{"reference":"PO-2155-1","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-05-08T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"9-May-26"},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":18068.9171,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"PAV-BF-K-ECO":9.0,"PAV-BF-Q-ECO":12.0,"WFHCR-CRM":55.0}},{"reference":"PO-2133-1","status":"APPROVED","stage":"Received","arrival":"2026-02-05T05:35:00Z","estimatedArrivalDate":"2026-02-20T13:00:00Z","fullyReceivedDate":"2026-02-27T03:34:00Z","customFields":{"orders_1000":"6-Mar-2026"},"company":"Aibang Home Furnishings Co.,Ltd.","total":37002.6485,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EVE-BF-K-ECO":2.0,"HANK-BT-WNT-ECO":14.0,"HDSN-DT180-OAK-ECO":1.0,"PBLE-D140-WHT-ECO":2.0,"TATE-EDT-NAL-ECO":1.0,"EVE-BF-K-ECO-1":2.0,"EVE-BF-K-ECO-2":2.0,"EVE-BF-K-ECO-3":2.0,"EVE-BF-K-ECO-4":2.0,"HDSN-DT180-OAK-ECO-1":1.0,"HDSN-DT180-OAK-ECO-2":1.0,"PBLE-D140-WHT-ECO-1":2.0,"PBLE-D140-WHT-ECO-2":2.0,"TATE-EDT-NAL-ECO-1":1.0,"TATE-EDT-NAL-ECO-2":1.0,"TATE-EDT-NAL-ECO-3":1.0,"KTZ-DT110-WHT-ECO":16.0,"KTZ-DT110-WHT-ECO-1":16.0,"KTZ-DT110-WHT-ECO-2":16.0,"ODEN-DSK-ADJ-OAK-ECO":20.0,"ODEN-DSK-ADJ-OAK-ECO-1":20.0,"ODEN-DSK-ADJ-OAK-ECO-2":20.0,"CAM-DSK-ADJ-WG-ECO":20.0,"CAM-DSK-ADJ-WG-ECO-1":20.0,"CAM-DSK-ADJ-WG-ECO-2":20.0,"ALX-BF-K-NAL-ECO":15.0,"ALX-BF-K-NAL-ECO-1":15.0,"ALX-BF-K-NAL-ECO-2":15.0,"ALX-BF-K-NAL-ECO-3":15.0,"ALX-BF-Q-NAL-ECO":15.0,"ALX-BF-Q-NAL-ECO-1":15.0,"ALX-BF-Q-NAL-ECO-2":15.0,"ALX-BF-Q-NAL-ECO-3":15.0,"IRSA-BF-K-WNT-ECO":15.0,"IRSA-BF-K-WNT-ECO-1":15.0,"IRSA-BF-K-WNT-ECO-2":15.0,"IRSA-BF-K-WNT-ECO-3":15.0,"IRSA-BF-Q-WNT-ECO":15.0,"IRSA-BF-Q-WNT-ECO-1":15.0,"IRSA-BF-Q-WNT-ECO-2":15.0,"IRSA-BF-Q-WNT-ECO-3":15.0,"JAM-BF-K-OAK-ECO":13.0,"JAM-BF-K-OAK-ECO-1":13.0,"JAM-BF-K-OAK-ECO-2":13.0,"JAM-BF-K-OAK-ECO-3":13.0,"JAM-BF-Q-OAK-ECO":15.0,"JAM-BF-Q-OAK-ECO-1":15.0,"JAM-BF-Q-OAK-ECO-2":15.0,"JAM-BF-Q-OAK-ECO-3":15.0,"KTH-SB180-WNT-ECO":15.0,"KTH-SB180-WNT-ECO-1":15.0,"KTH-SB180-WNT-ECO-2":15.0,"KTH-SB180-WNT-ECO-3":15.0,"KTH-SB180-WNT-ECO-4":15.0}},{"reference":"PO-2109","status":"APPROVED","stage":"Received","arrival":"2026-01-15T04:33:00Z","estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-11T00:54:00Z","customFields":{"orders_1000":"14-2-2026"},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":46671.0506,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"BLC-6COD-OAK-ECO":40.0,"BLC-TV200-OAK-ECO":30.0,"IRNE-TV180-OAK-ECO":20.0,"IRNE-TV200-OAK-ECO":15.0,"TATE-TV200-BLACK-ECO":10.0,"BLC-6COD-OAK-ECO-1":40.0,"BLC-6COD-OAK-ECO-2":40.0,"BLC-6COD-OAK-ECO-3":40.0,"BLC-TV200-OAK-ECO-1":30.0,"BLC-TV200-OAK-ECO-2":30.0,"TATE-TV200-BLACK-ECO-1":10.0,"TATE-TV200-BLACK-ECO-2":10.0,"LFSF-CRNR-FC":7.0,"IRNE-TV180-OAK-ECO-1":20.0,"IRNE-TV180-OAK-ECO-2":20.0,"IRNE-TV200-OAK-ECO-1":15.0,"IRNE-TV200-OAK-ECO-2":15.0,"SENA-CT-DKGN-ECO":25.0,"BRN-6COD-ECO":19.0,"BRN-6COD-ECO-1":19.0,"BRN-6COD-ECO-2":19.0,"BRN-6COD-ECO-3":19.0,"PVO-SBCH-140-ECO":25.0,"LIAM-DC-WHT-ECO":18.0,"ERC-BS-CUSH-NAL-ECO":20.0,"JCB-DC-NAL-ECO":20.0,"JSPH-DC-WNT-ECO":20.0,"LUK-BS-NAL-ECO":19.0}},{"reference":"PO-2144-1","status":"APPROVED","stage":"Received","arrival":"2026-01-19T04:33:00Z","estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-16T03:24:00Z","customFields":{"orders_1000":"16-2-2026"},"company":"WINSTON FURNITURE CO., LIMITED","total":21950.7333,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"COCOON-KING-IVR":12.0,"COCOON-QUEEN-IVR":13.0,"COCOON-DOUBLE-IVR":13.0,"COCOON-KING-MSGRN":12.0,"COCOON-QUEEN-MSGRN":13.0,"COCOON-DOUBLE-MSGRN":14.0,"COCOON-KING-IVR-1":12.0,"COCOON-KING-IVR-2":12.0,"COCOON-QUEEN-IVR-1":13.0,"COCOON-QUEEN-IVR-2":13.0,"COCOON-DOUBLE-IVR-1":13.0,"COCOON-DOUBLE-IVR-2":13.0,"COCOON-KING-MSGRN-1":12.0,"COCOON-KING-MSGRN-2":12.0,"COCOON-QUEEN-MSGRN-1":13.0,"COCOON-QUEEN-MSGRN-2":13.0,"COCOON-DOUBLE-MSGRN-1":14.0,"COCOON-DOUBLE-MSGRN-2":14.0}},{"reference":"PO-2144-2","status":"APPROVED","stage":"Received","arrival":"2026-01-22T04:52:00Z","estimatedArrivalDate":"2026-02-07T13:00:00Z","fullyReceivedDate":"2026-02-19T02:05:00Z","customFields":{"orders_1000":"24-2-2026"},"company":"WINSTON FURNITURE CO., LIMITED","total":52630.0067,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"COCOON-KING-IVR":24.0,"COCOON-QUEEN-IVR":10.0,"COCOON-DOUBLE-IVR":2.0,"COCOON-KING-CRML":54.0,"COCOON-QUEEN-CRML":33.0,"COCOON-DOUBLE-CRML":20.0,"COCOON-KING-MSGRN":23.0,"COCOON-QUEEN-MSGRN":10.0,"COCOON-DOUBLE-MSGRN":1.0,"COCOON-KING-IVR-1":24.0,"COCOON-KING-IVR-2":24.0,"COCOON-QUEEN-IVR-1":10.0,"COCOON-QUEEN-IVR-2":10.0,"COCOON-DOUBLE-IVR-1":2.0,"COCOON-DOUBLE-IVR-2":2.0,"COCOON-KING-CRML-1":54.0,"COCOON-KING-CRML-2":54.0,"COCOON-QUEEN-CRML-1":33.0,"COCOON-QUEEN-CRML-2":33.0,"COCOON-DOUBLE-CRML-1":20.0,"COCOON-DOUBLE-CRML-2":20.0,"COCOON-KING-MSGRN-1":23.0,"COCOON-KING-MSGRN-2":23.0,"COCOON-QUEEN-MSGRN-1":10.0,"COCOON-QUEEN-MSGRN-2":10.0,"COCOON-DOUBLE-MSGRN-1":1.0,"COCOON-DOUBLE-MSGRN-2":1.0}},{"reference":"PO-LF0010-2","status":"APPROVED","stage":"Received","arrival":"2025-12-30T05:34:00Z","estimatedArrivalDate":"2026-01-26T13:00:00Z","fullyReceivedDate":"2026-01-30T06:45:00Z","customFields":{"orders_1000":"3-2-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":31648.6561,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSB-Q-CHC":20.0,"LFSB-D-CHC":5.0,"LFSB-AMST-CHC":20.0,"LFSB-Q-LTGN":40.0,"LFSB-D-LTGN":15.0,"LFSB-SOTM-LTGN":5.0,"LFSB-TW-LTGN":35.0,"LFSB-AMST-LTGN":60.0,"LFSB-Q-WHT":20.0,"LFSB-D-WHT":15.0,"LFSB-SOTM-WHT":10.0,"LFSB-TW-WHT":10.0,"LFSB-AMST-WHT":45.0,"LFSB-Q-CHC-1":20.0,"LFSB-Q-CHC-2":20.0,"LFSB-D-CHC-1":5.0,"LFSB-D-CHC-2":5.0,"LFSB-Q-LTGN-1":40.0,"LFSB-Q-LTGN-2":40.0,"LFSB-D-LTGN-1":15.0,"LFSB-D-LTGN-2":15.0,"LFSB-TW-LTGN-1":35.0,"LFSB-TW-LTGN-2":35.0,"LFSB-Q-WHT-1":20.0,"LFSB-Q-WHT-2":20.0,"LFSB-D-WHT-1":15.0,"LFSB-D-WHT-2":15.0,"LFSB-TW-WHT-1":10.0,"LFSB-TW-WHT-2":10.0}},{"reference":"PO-2159","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-05-16T14:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"17-May-26"},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":30690.3051,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"WFHCR-CRM":160.0}},{"reference":"PO-2155","status":"APPROVED","stage":"Received","arrival":"2026-02-03T05:37:00Z","estimatedArrivalDate":"2026-03-17T13:00:00Z","fullyReceivedDate":"2026-02-23T03:37:00Z","customFields":{"orders_1000":"17-Mar-2026"},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":27530.5807,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"PAV-BF-K-ECO":3.0,"PAV-BF-K-ECO-1":3.0,"PAV-BF-K-ECO-2":3.0,"PAV-BF-K-ECO-3":3.0,"PAV-BF-Q-ECO":2.0,"PAV-BF-Q-ECO-1":2.0,"PAV-BF-Q-ECO-2":2.0,"PAV-BF-Q-ECO-3":2.0,"WFHCR-CRM":135.0}},{"reference":"PO-LF0010-3","status":"APPROVED","stage":"Received","arrival":"2026-01-13T05:03:00Z","estimatedArrivalDate":"2026-02-07T13:00:00Z","fullyReceivedDate":"2026-02-17T00:11:00Z","customFields":{"orders_1000":"21-2-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":32540.6351,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSB-Q-CHC":20.0,"LFSB-D-CHC":5.0,"LFSB-TW-CHC":10.0,"LFSB-AMST-CHC":30.0,"LFSB-Q-LTGN":27.0,"LFSB-D-LTGN":15.0,"LFSB-SOTM-LTGN":5.0,"LFSB-TW-LTGN":70.0,"LFSB-AMST-LTGN":100.0,"LFSB-Q-WHT":10.0,"LFSB-D-WHT":10.0,"LFSB-TW-WHT":10.0,"LFSB-AMST-WHT":30.0,"LFSB-Q-CHC-1":20.0,"LFSB-Q-CHC-2":20.0,"LFSB-D-CHC-1":5.0,"LFSB-D-CHC-2":5.0,"LFSB-TW-CHC-1":10.0,"LFSB-TW-CHC-2":10.0,"LFSB-Q-LTGN-1":27.0,"LFSB-Q-LTGN-2":27.0,"LFSB-D-LTGN-1":15.0,"LFSB-D-LTGN-2":15.0,"LFSB-TW-LTGN-1":70.0,"LFSB-TW-LTGN-2":70.0,"LFSB-Q-WHT-1":10.0,"LFSB-Q-WHT-2":10.0,"LFSB-D-WHT-1":10.0,"LFSB-D-WHT-2":10.0,"LFSB-TW-WHT-1":10.0,"LFSB-TW-WHT-2":10.0}},{"reference":"PO-LF0010-4","status":"APPROVED","stage":"Received","arrival":"2026-01-21T05:25:00Z","estimatedArrivalDate":"2026-03-15T13:00:00Z","fullyReceivedDate":"2026-02-18T20:59:00Z","customFields":{"orders_1000":"1-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":33542.081,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSB-Q-CHC":20.0,"LFSB-S-CHC":5.0,"LFSB-TW-CHC":10.0,"LFSB-AMST-CHC":30.0,"LFSB-Q-LTGN":43.0,"LFSB-S-LTGN":5.0,"LFSB-TW-LTGN":70.0,"LFSB-AMST-LTGN":100.0,"LFSB-D-WHT":10.0,"LFSB-CHS-WHT":5.0,"LFSB-S-WHT":5.0,"LFSB-TW-WHT":20.0,"LFSB-AMST-WHT":30.0,"LFSB-Q-CHC-1":20.0,"LFSB-Q-CHC-2":20.0,"LFSB-TW-CHC-1":10.0,"LFSB-TW-CHC-2":10.0,"LFSB-Q-LTGN-1":43.0,"LFSB-Q-LTGN-2":43.0,"LFSB-TW-LTGN-1":70.0,"LFSB-TW-LTGN-2":70.0,"LFSB-D-WHT-1":10.0,"LFSB-D-WHT-2":10.0,"LFSB-CHS-WHT-1":5.0,"LFSB-CHS-WHT-2":5.0,"LFSB-TW-WHT-1":20.0,"LFSB-TW-WHT-2":20.0}},{"reference":"PO-2101-1","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-27T13:00:00Z","fullyReceivedDate":"2026-01-25T07:15:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":41316.5035,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"FMA-6COD-WNT-ECO":25.0,"GBRL-GLS-CT-ECO":15.0,"KTZ-CT-WHT-ECO":50.0,"KTZ-ST-WHT-ECO":30.0,"LOLA-BSF-NAL-ECO":40.0,"ODEN-TV180-OAK-ECO":23.0,"TATE-EDT-NAL-ECO":42.0,"EVE-BF-Q-NAL-ECO":15.0,"GBRL-GLS-CT-ECO-1":15.0,"GBRL-GLS-CT-ECO-2":15.0,"KTZ-CT-WHT-ECO-1":50.0,"KTZ-CT-WHT-ECO-2":50.0,"ODEN-TV180-OAK-ECO-1":23.0,"ODEN-TV180-OAK-ECO-2":23.0,"TATE-EDT-NAL-ECO-1":42.0,"TATE-EDT-NAL-ECO-2":42.0,"TATE-EDT-NAL-ECO-3":42.0,"FMA-6COD-WNT-ECO-1":25.0,"FMA-6COD-WNT-ECO-2":25.0,"FMA-6COD-WNT-ECO-3":25.0,"KTZ-ST-WHT-ECO-1":30.0,"KTZ-ST-WHT-ECO-2":30.0,"EVE-BF-Q-NAL-ECO-1":15.0,"EVE-BF-Q-NAL-ECO-2":15.0,"EVE-BF-Q-NAL-ECO-3":15.0,"EVE-BF-Q-NAL-ECO-4":15.0}},{"reference":"PO-2101-2","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-27T13:00:00Z","fullyReceivedDate":"2026-01-25T06:29:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":38151.7577,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"AMLA-DESK-ECO":20.0,"ARH-SB160-WHT-ECO":20.0,"ARH-TV180-WHT-ECO":20.0,"ARH-TV220-WHT-ECO":25.0,"ARLO-6COD-WHT-ECO":80.0,"ARLO-TV-WHT-ECO":25.0,"CAM-DSK150-WG-ECO":10.0,"DRIS-SB160-WNT-ECO":20.0,"AMLA-DESK-ECO-1":20.0,"AMLA-DESK-ECO-2":20.0,"ARH-SB160-WHT-ECO-1":20.0,"ARH-SB160-WHT-ECO-2":20.0,"ARH-TV180-WHT-ECO-1":20.0,"ARH-TV180-WHT-ECO-2":20.0,"ARH-TV220-WHT-ECO-1":25.0,"ARH-TV220-WHT-ECO-2":25.0,"ARLO-6COD-WHT-ECO-1":80.0,"ARLO-6COD-WHT-ECO-2":80.0,"ARLO-6COD-WHT-ECO-3":80.0,"ARLO-TV-WHT-ECO-1":25.0,"ARLO-TV-WHT-ECO-2":25.0,"CAM-DSK150-WG-ECO-1":10.0,"CAM-DSK150-WG-ECO-2":10.0,"DRIS-SB160-WNT-ECO-1":20.0,"DRIS-SB160-WNT-ECO-2":20.0}},{"reference":"PO-AU001-1","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-18T13:00:00Z","fullyReceivedDate":"2026-01-25T06:59:00Z","customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":129980.9553,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DGY":40.0,"LLAU-CB-KS-DGY":60.0,"LLAU-CB-S-BABL":8.0,"LLAU-CB-KS-BABL":16.0,"LLAU-CB-D-BABL":34.0,"LLAU-CB-S-CTCN":50.0,"LLAU-CB-KS-CTCN":35.0,"LLAU-CB-D-CTCN":60.0,"LLAU-CB-S-MSM":75.0,"LLAU-CB-KS-MSM":139.0,"LLAU-CB-D-MSM":108.0,"LLAU-CB-CS-DSBL":500.0,"LLAU-CB-CS-DGY":500.0,"LLAU-CB-CS-PST":500.0,"LLAU-CB-CS-BABL":500.0,"LLAU-CB-CS-CTCN":500.0,"LLAU-CB-CS-MSM":500.0}},{"reference":"PO-AU001-2","status":"APPROVED","stage":"Received","arrival":"2026-01-06T05:28:00Z","estimatedArrivalDate":"2026-01-18T13:00:00Z","fullyReceivedDate":"2026-02-06T03:56:00Z","customFields":{"orders_1000":"9-2-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":126966.1058,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DSBL":30.0,"LLAU-CB-KS-DSBL":30.0,"LLAU-CB-D-DSBL":50.0,"LLAU-CB-D-DGY":65.0,"LLAU-CB-S-PST":40.0,"LLAU-CB-KS-PST":72.0,"LLAU-CB-D-PST":36.0,"LLAU-CB-S-BABL":32.0,"LLAU-CB-KS-BABL":35.0,"LLAU-CB-D-BABL":66.0,"LLAU-CB-KS-CTCN":45.0,"LLAU-CB-D-CTCN":40.0,"LLAU-CB-S-MSM":25.0,"LLAU-CB-D-MSM":62.0}},{"reference":"PO-LF0011-1","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-18T13:00:00Z","fullyReceivedDate":"2026-01-20T01:48:00Z","customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":52039.0242,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CUSB-D-DNM":11.0,"CUSB-D-DNM-1":11.0,"CUSB-D-DNM-2":11.0,"CUSB-D-TBRN":9.0,"CUSB-D-TBRN-1":9.0,"CUSB-D-TBRN-2":9.0,"CUSB-D-TWHT":11.0,"CUSB-D-TWHT-1":11.0,"CUSB-D-TWHT-2":11.0,"CUSB-K-DNM":6.0,"CUSB-K-DNM-1":6.0,"CUSB-K-DNM-2":6.0,"CUSB-K-TBRN":6.0,"CUSB-K-TBRN-1":6.0,"CUSB-K-TBRN-2":6.0,"CUSB-K-TWHT":11.0,"CUSB-K-TWHT-1":11.0,"CUSB-K-TWHT-2":11.0,"CUSB-Q-DNM":17.0,"CUSB-Q-DNM-1":17.0,"CUSB-Q-DNM-2":17.0,"CUSB-Q-TBRN":11.0,"CUSB-Q-TBRN-1":11.0,"CUSB-Q-TBRN-2":11.0,"CUSB-Q-TWHT":17.0,"CUSB-Q-TWHT-1":17.0,"CUSB-Q-TWHT-2":17.0,"CUSB-TW-DNM":5.0,"CUSB-TW-DNM-1":5.0,"CUSB-TW-DNM-2":5.0,"CUSB-TW-TBRN":3.0,"CUSB-TW-TBRN-1":3.0,"CUSB-TW-TBRN-2":3.0,"CUSB-TW-TWHT":6.0,"CUSB-TW-TWHT-1":6.0,"CUSB-TW-TWHT-2":6.0,"CUSB-ARST-SET-TBRN":35.0,"CUSB-ARST-SET-TWHT":50.0,"CUSB-ARST-SET-DNM":45.0,"CUSB-ARST-SET-LTGN":66.0,"CUSB-D-LTGN":13.0,"CUSB-D-LTGN-1":13.0,"CUSB-D-LTGN-2":13.0,"CUSB-K-LTGN":12.0,"CUSB-K-LTGN-1":12.0,"CUSB-K-LTGN-2":12.0,"CUSB-Q-LTGN":28.0,"CUSB-Q-LTGN-1":28.0,"CUSB-Q-LTGN-2":28.0,"CUSB-TW-LTGN":13.0,"CUSB-TW-LTGN-1":13.0,"CUSB-TW-LTGN-2":13.0}},{"reference":"PO-LF0011-2","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-02-05T13:00:00Z","fullyReceivedDate":"2026-02-03T22:50:00Z","customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":51182.652,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CUSB-D-DNM":11.0,"CUSB-D-DNM-1":11.0,"CUSB-D-DNM-2":11.0,"CUSB-D-TBRN":8.0,"CUSB-D-TBRN-1":8.0,"CUSB-D-TBRN-2":8.0,"CUSB-D-TWHT":10.0,"CUSB-D-TWHT-1":10.0,"CUSB-D-TWHT-2":10.0,"CUSB-K-DNM":6.0,"CUSB-K-DNM-1":6.0,"CUSB-K-DNM-2":6.0,"CUSB-K-TBRN":6.0,"CUSB-K-TBRN-1":6.0,"CUSB-K-TBRN-2":6.0,"CUSB-K-TWHT":11.0,"CUSB-K-TWHT-1":11.0,"CUSB-K-TWHT-2":11.0,"CUSB-Q-DNM":18.0,"CUSB-Q-DNM-1":18.0,"CUSB-Q-DNM-2":18.0,"CUSB-Q-TBRN":11.0,"CUSB-Q-TBRN-1":11.0,"CUSB-Q-TBRN-2":11.0,"CUSB-Q-TWHT":18.0,"CUSB-Q-TWHT-1":18.0,"CUSB-Q-TWHT-2":18.0,"CUSB-TW-DNM":11.0,"CUSB-TW-DNM-1":11.0,"CUSB-TW-DNM-2":11.0,"CUSB-TW-TBRN":9.0,"CUSB-TW-TBRN-1":9.0,"CUSB-TW-TBRN-2":9.0,"CUSB-TW-TWHT":11.0,"CUSB-TW-TWHT-1":11.0,"CUSB-TW-TWHT-2":11.0,"CUSB-ARST-SET-TBRN":34.0,"CUSB-ARST-SET-TWHT":50.0,"CUSB-ARST-SET-DNM":46.0,"CUSB-ARST-SET-LTGN":64.0,"CUSB-D-LTGN":13.0,"CUSB-D-LTGN-1":13.0,"CUSB-D-LTGN-2":13.0,"CUSB-K-LTGN":12.0,"CUSB-K-LTGN-1":12.0,"CUSB-K-LTGN-2":12.0,"CUSB-Q-LTGN":26.0,"CUSB-Q-LTGN-1":26.0,"CUSB-Q-LTGN-2":26.0,"CUSB-TW-LTGN":11.0,"CUSB-TW-LTGN-1":11.0,"CUSB-TW-LTGN-2":11.0}},{"reference":"PO-2139-2","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-22T13:00:00Z","fullyReceivedDate":"2026-01-19T03:29:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":40550.5882,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EMMA-DT180-OAK-ECO":25.0,"EVE-BF-K-ECO":30.0,"EVE-BF-Q-ECO":30.0,"HANK-BT-ASH-ECO":35.0,"HANK-BT-WNT-ECO":80.0,"TATE-EDT-BLK-ECO":30.0,"EMMA-DT180-OAK-ECO-1":25.0,"EMMA-DT180-OAK-ECO-2":25.0,"EMMA-DT180-OAK-ECO-3":25.0,"EVE-BF-K-ECO-1":30.0,"EVE-BF-K-ECO-2":30.0,"EVE-BF-K-ECO-3":30.0,"EVE-BF-K-ECO-4":30.0,"EVE-BF-Q-ECO-1":30.0,"EVE-BF-Q-ECO-2":30.0,"EVE-BF-Q-ECO-3":30.0,"EVE-BF-Q-ECO-4":30.0,"TATE-EDT-BLK-ECO-1":30.0,"TATE-EDT-BLK-ECO-2":30.0,"TATE-EDT-BLK-ECO-3":30.0}},{"reference":"PO-2139-1","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-15T13:00:00Z","fullyReceivedDate":"2026-01-14T22:10:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":41549.3287,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"EMMA-DT180-OAK-ECO":25.0,"EVE-BF-K-ECO":18.0,"EVE-BF-Q-ECO":31.0,"HANK-BT-ASH-ECO":65.0,"HANK-BT-WNT-ECO":70.0,"TATE-EDT-BLK-ECO":20.0,"EMMA-DT180-OAK-ECO-1":25.0,"EMMA-DT180-OAK-ECO-2":25.0,"EMMA-DT180-OAK-ECO-3":25.0,"EVE-BF-K-ECO-1":18.0,"EVE-BF-K-ECO-2":18.0,"EVE-BF-K-ECO-3":18.0,"EVE-BF-K-ECO-4":18.0,"EVE-BF-Q-ECO-1":31.0,"EVE-BF-Q-ECO-2":31.0,"EVE-BF-Q-ECO-3":31.0,"EVE-BF-Q-ECO-4":31.0,"TATE-EDT-BLK-ECO-1":20.0,"TATE-EDT-BLK-ECO-2":20.0,"TATE-EDT-BLK-ECO-3":20.0,"LARY-6COD-ECO":25.0,"LARY-6COD-ECO-1":25.0,"LARY-6COD-ECO-2":25.0,"LARY-6COD-ECO-3":25.0}},{"reference":"PO-LF0014-1","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-06T00:50:00Z","customFields":{"orders_1000":""},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":41566.4773,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSF-AMLS-FC":50.0,"LFSF-CRNR-FC":190.0,"LFSF-OTM-FC":65.0}},{"reference":"PO-LF0014-2","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-06T00:56:00Z","customFields":{"orders_1000":""},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":53186.3515,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"IRNE-BT-OAK-ECO":30.0,"IRNE-TV180-OAK-ECO":20.0,"LORA-AC-ORG-ECO":30.0,"NOAH-DC-WNT-ECO":30.0,"LFSF-AMLS-FC":50.0,"LFSF-CRNR-FC":53.0,"LFSF-OTM-FC":35.0,"LFSF-AMLS-CV-OG":70.0,"LFSF-CRNR-CV-OG":120.0,"LFSF-OTM-CV-OG":36.0,"LFSF-AMLS-CV-LB":50.0,"LFSF-CRNR-CV-LB":100.0,"LFSF-OTM-CV-LB":30.0,"IRNE-TV180-OAK-ECO-1":20.0,"IRNE-TV180-OAK-ECO-2":20.0}},{"reference":"PO-2126-4","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-31T13:00:00Z","fullyReceivedDate":"2026-01-30T05:56:00Z","customFields":{"orders_1000":""},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":20942.9988,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"BLC-6COD-OAK-ECO":20.0,"BLC-TV200-OAK-ECO":20.0,"TATE-DT180-WNT-ECO":20.0,"TATE-RODT-BLACK-ECO":10.0,"TATE-TV200-BLACK-ECO":10.0,"NOAH-DC-WNT-ECO":18.0,"BLC-6COD-OAK-ECO-1":20.0,"BLC-6COD-OAK-ECO-2":20.0,"BLC-6COD-OAK-ECO-3":20.0,"BLC-TV200-OAK-ECO-1":20.0,"BLC-TV200-OAK-ECO-2":20.0,"TATE-DT180-WNT-ECO-1":20.0,"TATE-DT180-WNT-ECO-2":20.0,"TATE-DT180-WNT-ECO-3":20.0,"TATE-RODT-BLACK-ECO-1":10.0,"TATE-RODT-BLACK-ECO-2":10.0,"TATE-RODT-BLACK-ECO-3":10.0,"TATE-TV200-BLACK-ECO-1":10.0,"TATE-TV200-BLACK-ECO-2":10.0}},{"reference":"PO-LF0018","status":"APPROVED","stage":"","arrival":null,"estimatedArrivalDate":"2026-05-07T14:29:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"8-May-26"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":34626.7334,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LFSB-D-CHC":15.0,"LFSB-SOTM-CHC":5.0,"LFSB-Q-LTGN":40.0,"LFSB-D-LTGN":40.0,"LFSB-CHS-LTGN":10.0,"LFSB-SOTM-LTGN":10.0,"LFSB-Q-WHT":40.0,"LFSB-D-WHT":20.0,"LFSB-SOTM-WHT":20.0,"LFSB-AMST-WHT":50.0}},{"reference":"PO-05","status":"APPROVED","stage":"","arrival":"2026-02-21T04:20:00Z","estimatedArrivalDate":"2026-03-23T04:20:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"23-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":56127.6377,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"V3-ARM-DKBL":60.0,"V3-ARM-LGN":69.0,"V3-ARM-TBRN":33.0,"V3-ARM-TWHT":33.0,"V3-DB-DKBL":12.0,"V3-DB-LGN":15.0,"V3-DB-TBRN":7.0,"V3-DB-TWHT":7.0,"V3-KB-DKBL":12.0,"V3-KB-LGN":15.0,"V3-KB-TBRN":7.0,"V3-KB-TWHT":7.0,"V3-QB-DKBL":24.0,"V3-QB-LGN":24.0,"V3-QB-TBRN":12.0,"V3-QB-TWHT":12.0,"V3-TB-DKBL":12.0,"V3-TB-LGN":15.0,"V3-TB-TBRN":7.0,"V3-TB-TWHT":7.0}},{"reference":"PO-08","status":"APPROVED","stage":"","arrival":"2026-01-25T04:19:00Z","estimatedArrivalDate":"2026-03-08T04:19:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"8-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":112158.3795,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"V3-ARM-DKBL":122.0,"V3-ARM-LGN":128.0,"V3-ARM-TBRN":72.0,"V3-ARM-TWHT":72.0,"V3-DB-DKBL":25.0,"V3-DB-LGN":26.0,"V3-DB-TBRN":15.0,"V3-DB-TWHT":15.0,"V3-KB-DKBL":16.0,"V3-KB-LGN":16.0,"V3-KB-TBRN":8.0,"V3-KB-TWHT":8.0,"V3-QB-DKBL":56.0,"V3-QB-LGN":60.0,"V3-QB-TBRN":34.0,"V3-QB-TWHT":34.0,"V3-TB-DKBL":25.0,"V3-TB-LGN":26.0,"V3-TB-TBRN":15.0,"V3-TB-TWHT":15.0}},{"reference":"PO-AU003","status":"APPROVED","stage":"","arrival":"2026-03-17T05:44:00Z","estimatedArrivalDate":"2026-04-11T06:44:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":329713.6981,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLAU-CB-S-DSBL":30.0,"LLAU-CB-KS-DSBL":45.0,"LLAU-CB-D-DSBL":100.0,"LLAU-CB-S-DGY":45.0,"LLAU-CB-KS-DGY":25.0,"LLAU-CB-D-DGY":75.0,"LLAU-CB-S-PST":100.0,"LLAU-CB-KS-PST":50.0,"LLAU-CB-D-PST":155.0,"LLAU-CB-S-BABL":65.0,"LLAU-CB-KS-BABL":65.0,"LLAU-CB-D-BABL":140.0,"LLAU-CB-S-CTCN":90.0,"LLAU-CB-KS-CTCN":70.0,"LLAU-CB-D-CTCN":100.0,"LLAU-CB-S-MSM":140.0,"LLAU-CB-KS-MSM":100.0,"LLAU-CB-D-MSM":240.0}},{"reference":"PO-10","status":"APPROVED","stage":"","arrival":"2026-02-21T04:21:00Z","estimatedArrivalDate":"2026-04-12T05:21:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"12-4-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":282637.9729,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLNA-CB-TW-DGY":40.0,"LLNA-CB-TWX-DGY":10.0,"LLNA-CB-F-DGY":110.0,"LLNA-CB-TW-PST":10.0,"LLNA-CB-TWX-PST":10.0,"LLNA-CB-F-PST":80.0,"LLNA-CB-TW-BABL":80.0,"LLNA-CB-TWX-BABL":30.0,"LLNA-CB-F-BABL":110.0,"LLNA-CB-TW-CTCN":120.0,"LLNA-CB-TWX-CTCN":40.0,"LLNA-CB-F-CTCN":170.0,"LLNA-CB-TW-MSM":160.0,"LLNA-CB-TWX-MSM":30.0,"LLNA-CB-F-MSM":300.0}},{"reference":"PO-CA004","status":"APPROVED","stage":"","arrival":"2026-03-07T04:11:00Z","estimatedArrivalDate":"2026-05-05T05:10:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"5-5-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":100067.1847,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLNA-CB-TW-DGY":35.0,"LLNA-CB-F-DGY":42.0,"LLNA-CB-TW-PST":42.0,"LLNA-CB-TWX-PST":12.0,"LLNA-CB-F-PST":28.0,"LLNA-CB-TW-BABL":12.0,"LLNA-CB-F-BABL":62.0,"LLNA-CB-TW-CTCN":22.0,"LLNA-CB-TWX-CTCN":14.0,"LLNA-CB-F-CTCN":28.0,"LLNA-CB-TW-MSM":84.0,"LLNA-CB-F-MSM":84.0}},{"reference":"PO-09","status":"APPROVED","stage":"","arrival":"2026-02-12T04:22:00Z","estimatedArrivalDate":"2026-03-02T13:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"3-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":74025.7639,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLNA-CB-TW-DGY":25.0,"LLNA-CB-TWX-DGY":5.0,"LLNA-CB-F-DGY":30.0,"LLNA-CB-TW-PST":10.0,"LLNA-CB-TWX-PST":5.0,"LLNA-CB-F-PST":30.0,"LLNA-CB-TW-BABL":35.0,"LLNA-CB-TWX-BABL":5.0,"LLNA-CB-F-BABL":30.0,"LLNA-CB-TW-CTCN":10.0,"LLNA-CB-TWX-CTCN":10.0,"LLNA-CB-F-CTCN":25.0,"LLNA-CB-TW-MSM":30.0,"LLNA-CB-TWX-MSM":10.0,"LLNA-CB-F-MSM":65.0,"LLNA-CB-TW-DGY-CV":3.0,"LLNA-CB-TWX-DGY-CV":1.0,"LLNA-CB-F-DGY-CV":3.0,"LLNA-CB-TW-PST-CV":1.0,"LLNA-CB-TWX-PST-CV":1.0,"LLNA-CB-F-PST-CV":1.0,"LLNA-CB-TW-BABL-CV":1.0,"LLNA-CB-TWX-BABL-CV":1.0,"LLNA-CB-F-BABL-CV":5.0,"LLNA-CB-TW-CTCN-CV":1.0,"LLNA-CB-TWX-CTCN-CV":2.0,"LLNA-CB-F-CTCN-CV":3.0,"LLNA-CB-TW-MSM-CV":4.0,"LLNA-CB-TWX-MSM-CV":1.0,"LLNA-CB-F-MSM-CV":14.0}},{"reference":"PO-CA003","status":"APPROVED","stage":"","arrival":"2026-01-31T04:09:00Z","estimatedArrivalDate":"2026-03-06T13:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"7-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":31715.7911,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLNA-CB-TW-DGY":10.0,"LLNA-CB-TWX-DGY":4.0,"LLNA-CB-F-DGY":10.0,"LLNA-CB-TW-PST":12.0,"LLNA-CB-TWX-PST":4.0,"LLNA-CB-F-PST":12.0,"LLNA-CB-TW-BABL":10.0,"LLNA-CB-TWX-BABL":4.0,"LLNA-CB-F-BABL":10.0,"LLNA-CB-TW-CTCN":12.0,"LLNA-CB-TWX-CTCN":4.0,"LLNA-CB-F-CTCN":10.0,"LLNA-CB-TW-MSM":12.0,"LLNA-CB-TWX-MSM":4.0,"LLNA-CB-F-MSM":15.0,"LLNA-CB-TW-DGY-CV":2.0,"LLNA-CB-TWX-DGY-CV":1.0,"LLNA-CB-F-DGY-CV":2.0,"LLNA-CB-TW-PST-CV":3.0,"LLNA-CB-TWX-PST-CV":1.0,"LLNA-CB-F-PST-CV":3.0,"LLNA-CB-TW-BABL-CV":2.0,"LLNA-CB-TWX-BABL-CV":1.0,"LLNA-CB-F-BABL-CV":3.0,"LLNA-CB-TW-CTCN-CV":3.0,"LLNA-CB-TWX-CTCN-CV":1.0,"LLNA-CB-F-CTCN-CV":2.0,"LLNA-CB-TW-MSM-CV":4.0,"LLNA-CB-TWX-MSM-CV":1.0,"LLNA-CB-F-MSM-CV":7.0}},{"reference":"PO-SG001","status":"APPROVED","stage":"Received","arrival":"2026-01-13T06:51:00Z","estimatedArrivalDate":"2026-01-20T13:00:00Z","fullyReceivedDate":"2026-01-23T06:51:00Z","customFields":{"orders_1000":"21-1-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":29223.1514,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LLSG-CB-S-DGY":12.0,"LLSG-CB-SS-DGY":4.0,"LLSG-CB-Q-DGY":10.0,"LLSG-CB-S-PST":4.0,"LLSG-CB-SS-PST":4.0,"LLSG-CB-Q-PST":4.0,"LLSG-CB-S-BABL":10.0,"LLSG-CB-SS-BABL":10.0,"LLSG-CB-Q-BABL":10.0,"LLSG-CB-S-CTCN":10.0,"LLSG-CB-SS-CTCN":15.0,"LLSG-CB-Q-CTCN":10.0,"LLSG-CB-S-MSM":15.0,"LLSG-CB-SS-MSM":12.0,"LLSG-CB-Q-MSM":5.0,"LLSG-CB-S-DGY-CV":3.0,"LLSG-CB-SS-DGY-CV":1.0,"LLSG-CB-Q-DGY-CV":2.0,"LLSG-CB-S-PST-CV":1.0,"LLSG-CB-SS-PST-CV":1.0,"LLSG-CB-Q-PST-CV":1.0,"LLSG-CB-S-BABL-CV":2.0,"LLSG-CB-SS-BABL-CV":2.0,"LLSG-CB-Q-BABL-CV":2.0,"LLSG-CB-S-CTCN-CV":2.0,"LLSG-CB-SS-CTCN-CV":6.0,"LLSG-CB-Q-CTCN-CV":2.0,"LLSG-CB-S-MSM-CV":4.0,"LLSG-CB-SS-MSM-CV":3.0,"LLSG-CB-Q-MSM-CV":1.0}},{"reference":"PO-2125-4","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-11T13:00:00Z","fullyReceivedDate":"2026-01-02T01:20:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":37016.9897,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"ARLO-BT-WHT-ECO":30.0,"CLB-D170-WNT-ECO":16.0,"EVE-BF-Q-ECO":3.0,"HDSN-DSK-OAK-ECO":40.0,"HDSN-DT180-OAK-ECO":30.0,"KTZ-ST-WHT-ECO":3.0,"PBLE-D140-WHT-ECO":27.0,"PSM-ST-SLVY-ECO":19.0,"HDSN-EDT-OAK-ECO":30.0,"CLB-D170-WNT-ECO-1":16.0,"CLB-D170-WNT-ECO-2":16.0,"EVE-BF-Q-ECO-1":3.0,"EVE-BF-Q-ECO-2":3.0,"EVE-BF-Q-ECO-3":3.0,"EVE-BF-Q-ECO-4":3.0,"HDSN-DSK-OAK-ECO-1":40.0,"HDSN-DSK-OAK-ECO-2":40.0,"HDSN-DT180-OAK-ECO-1":30.0,"HDSN-DT180-OAK-ECO-2":30.0,"PBLE-D140-WHT-ECO-1":27.0,"PBLE-D140-WHT-ECO-2":27.0,"HAZ-CT-NAL-ECO":9.0,"KTZ-ST-WHT-ECO-1":3.0,"KTZ-ST-WHT-ECO-2":3.0,"HDSN-EDT-OAK-ECO-1":30.0,"HDSN-EDT-OAK-ECO-2":30.0,"ADN-TV180-ASH-ECO":5.0,"ADN-TV180-ASH-ECO-1":5.0,"ADN-TV180-ASH-ECO-2":5.0}},{"reference":"PO-2135","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-06T13:00:00Z","fullyReceivedDate":"2026-01-02T02:11:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":39329.8496,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"HAZ-CT-WNT-ECO":30.0,"PBLE-D140-WHT-ECO":3.0,"PBLE-D140-WHT-ECO-1":3.0,"PBLE-D140-WHT-ECO-2":3.0,"BRL-BWD-BT-ECO":30.0,"BNC-6COD-WNT-ECO":30.0,"BNC-6COD-WNT-ECO-1":30.0,"BNC-6COD-WNT-ECO-2":30.0,"BNC-6COD-WNT-ECO-3":30.0,"GEM-RTDSK-WNT-ECO":25.0,"GEM-RTDSK-WNT-ECO-1":25.0,"GEM-RTDSK-WNT-ECO-2":25.0,"GEM-RTDSK-WNT-ECO-3":25.0,"LARY-6COD-ECO":25.0,"LARY-6COD-ECO-1":25.0,"LARY-6COD-ECO-2":25.0,"LARY-6COD-ECO-3":25.0,"MAX-SC-ECO":50.0,"MAX-SC-ECO-1":50.0,"MAX-SC-ECO-2":50.0,"MAX-SC-ECO-3":50.0,"MAX-SC-ECO-4":50.0,"WIBR-DSK-ECO":30.0,"WIBR-DSK-ECO-1":30.0,"WIBR-DSK-ECO-2":30.0}},{"reference":"PO-2133","status":"APPROVED","stage":"Received","arrival":null,"estimatedArrivalDate":"2026-01-05T13:00:00Z","fullyReceivedDate":"2026-01-06T20:34:00Z","customFields":{"orders_1000":""},"company":"Aibang Home Furnishings Co.,Ltd.","total":39680.0429,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"ALX-BF-K-NAL-ECO":25.0,"ALX-BF-K-NAL-ECO-1":25.0,"ALX-BF-K-NAL-ECO-2":25.0,"ALX-BF-K-NAL-ECO-3":25.0,"ALX-BF-Q-NAL-ECO":25.0,"ALX-BF-Q-NAL-ECO-1":25.0,"ALX-BF-Q-NAL-ECO-2":25.0,"ALX-BF-Q-NAL-ECO-3":25.0,"IRSA-BF-K-WNT-ECO":25.0,"IRSA-BF-K-WNT-ECO-1":25.0,"IRSA-BF-K-WNT-ECO-2":25.0,"IRSA-BF-K-WNT-ECO-3":25.0,"IRSA-BF-Q-WNT-ECO":25.0,"IRSA-BF-Q-WNT-ECO-1":25.0,"IRSA-BF-Q-WNT-ECO-2":25.0,"IRSA-BF-Q-WNT-ECO-3":25.0,"JAM-BF-K-OAK-ECO":22.0,"JAM-BF-K-OAK-ECO-1":22.0,"JAM-BF-K-OAK-ECO-2":22.0,"JAM-BF-K-OAK-ECO-3":22.0,"JAM-BF-Q-OAK-ECO":25.0,"JAM-BF-Q-OAK-ECO-1":25.0,"JAM-BF-Q-OAK-ECO-2":25.0,"JAM-BF-Q-OAK-ECO-3":25.0,"KTH-SB180-WNT-ECO":25.0,"KTH-SB180-WNT-ECO-1":25.0,"KTH-SB180-WNT-ECO-2":25.0,"KTH-SB180-WNT-ECO-3":25.0,"KTH-SB180-WNT-ECO-4":25.0}},{"reference":"PO-LF0006-2","status":"APPROVED","stage":"Received","arrival":"2025-12-06T06:31:00Z","estimatedArrivalDate":"2026-01-14T13:00:00Z","fullyReceivedDate":"2026-01-09T02:40:00Z","customFields":{"orders_1000":""},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":22466.5623,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"RDNT-D-BASE":10.0,"RDNT-D-S":5.0,"RDNT-D-MF":12.0,"RDNT-D-F":5.0,"RDNT-Q-BASE":43.0,"RDNT-Q-S":40.0,"RDNT-Q-MF":27.0,"RDNT-Q-F":19.0,"RDNT-K-BASE":16.0,"RDNT-K-S":1.0,"RDNT-K-MF":19.0,"RDNT-K-F":14.0}},{"reference":"PO-2151","status":"APPROVED","stage":"","arrival":"2026-02-25T13:00:00Z","estimatedArrivalDate":"2026-03-13T13:00:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"12-Mar-26"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":20796.0337,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-153QMF":1.0,"DD-21107CF":55.0,"DD-21137CF":153.0,"DD-21915CF":45.0}},{"reference":"PO-2150","status":"APPROVED","stage":"Received","arrival":"2026-02-04T13:00:00Z","estimatedArrivalDate":"2026-02-21T13:00:00Z","fullyReceivedDate":"2026-02-23T03:43:00Z","customFields":{"orders_1000":"19-2-2026"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":52735.3775,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":160.0,"DD-21137CF":392.0,"DD-21915CF":90.0}},{"reference":"PO-LF0016","status":"APPROVED","stage":"Received","arrival":"2026-01-13T13:00:00Z","estimatedArrivalDate":"2026-02-06T13:00:00Z","fullyReceivedDate":"2026-02-16T23:51:00Z","customFields":{"orders_1000":"17-2-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":52429.5763,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"RDNT-D-BASE":10.0,"RDNT-D-S":5.0,"RDNT-D-MF":8.0,"RDNT-D-F":5.0,"RDNT-Q-BASE":50.0,"RDNT-Q-MF":90.0,"RDNT-K-BASE":100.0,"RDNT-K-S":100.0,"RDNT-K-MF":90.0}},{"reference":"PO-LF0017","status":"APPROVED","stage":"Received","arrival":"2026-01-28T13:00:00Z","estimatedArrivalDate":"2026-02-20T13:00:00Z","fullyReceivedDate":"2026-02-28T01:28:00Z","customFields":{"orders_1000":"6-3-2026"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":58234.29,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"RDNT-D-BASE":25.0,"RDNT-D-S":15.0,"RDNT-D-MF":35.0,"RDNT-Q-BASE":130.0,"RDNT-Q-S":75.0,"RDNT-Q-MF":5.0,"RDNT-Q-F":50.0,"RDNT-K-BASE":50.0,"RDNT-K-S":5.0,"RDNT-K-MF":15.0}},{"reference":"PO-2126-3","status":"APPROVED","stage":"Received","arrival":"2025-11-19T06:21:00Z","estimatedArrivalDate":"2026-01-08T13:00:00Z","fullyReceivedDate":"2026-01-02T01:58:00Z","customFields":{"orders_1000":""},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":31851.4278,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"BLC-BT-OAK-ECO":50.0,"BLC-BT-WNT-ECO":30.0,"LORA-AC-OLVE-ECO":5.0,"TATE-RODT-BLACK-ECO":25.0,"TATE-SB160-WNT-ECO":25.0,"TATE-TV200-BLACK-ECO":25.0,"TATE-TV200-NATURAL-ECO":25.0,"TATE-RODT-BLACK-ECO-1":25.0,"TATE-RODT-BLACK-ECO-2":25.0,"TATE-RODT-BLACK-ECO-3":25.0,"TATE-SB160-WNT-ECO-1":25.0,"TATE-SB160-WNT-ECO-2":25.0,"TATE-TV200-BLACK-ECO-1":25.0,"TATE-TV200-BLACK-ECO-2":25.0,"TATE-TV200-NATURAL-ECO-1":25.0,"TATE-TV200-NATURAL-ECO-2":25.0}},{"reference":"PO-2126-2","status":"APPROVED","stage":"Received","arrival":"2025-11-19T06:20:00Z","estimatedArrivalDate":"2026-01-06T13:00:00Z","fullyReceivedDate":"2026-01-07T05:40:00Z","customFields":{"orders_1000":""},"company":"NOVA FURNITURE INDUSTRIES CO.,LIMITED","total":62787.4831,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"BLC-6COD-WNT-ECO":25.0,"BLC-BBK-OAK-ECO":20.0,"BLC-V2-BBK-OAK-ECO":50.0,"ELNA-TV180-OAK-ECO":20.0,"IRNE-SB180-OAK-ECO":10.0,"IRNE-TV200-OAK-ECO":30.0,"TATE-DT180-WNT-ECO":30.0,"TATE-RODT-BLACK-ECO":15.0,"TATE-SB160-WNT-ECO":25.0,"TATE-TV200-BLACK-ECO":5.0,"TATE-TV200-NATURAL-ECO":25.0,"BLC-6COD-WNT-ECO-1":25.0,"BLC-6COD-WNT-ECO-2":25.0,"BLC-6COD-WNT-ECO-3":25.0,"BLC-BBK-OAK-ECO-1":20.0,"BLC-BBK-OAK-ECO-2":20.0,"BLC-BBK-OAK-ECO-3":20.0,"BLC-V2-BBK-OAK-ECO-1":50.0,"BLC-V2-BBK-OAK-ECO-2":50.0,"BLC-V2-BBK-OAK-ECO-3":50.0,"ELNA-TV180-OAK-ECO-1":20.0,"ELNA-TV180-OAK-ECO-2":20.0,"IRNE-SB180-OAK-ECO-1":10.0,"IRNE-SB180-OAK-ECO-2":10.0,"IRNE-SB180-OAK-ECO-3":10.0,"TATE-DT180-WNT-ECO-1":30.0,"TATE-DT180-WNT-ECO-2":30.0,"TATE-DT180-WNT-ECO-3":30.0,"TATE-RODT-BLACK-ECO-1":15.0,"TATE-RODT-BLACK-ECO-2":15.0,"TATE-RODT-BLACK-ECO-3":15.0,"TATE-SB160-WNT-ECO-1":25.0,"TATE-SB160-WNT-ECO-2":25.0,"TATE-TV200-BLACK-ECO-1":5.0,"TATE-TV200-BLACK-ECO-2":5.0,"TATE-TV200-NATURAL-ECO-1":25.0,"TATE-TV200-NATURAL-ECO-2":25.0,"IRNE-TV200-OAK-ECO-1":30.0,"IRNE-TV200-OAK-ECO-2":30.0}},{"reference":"PO-2147","status":"APPROVED","stage":"Received","arrival":"2026-01-16T13:00:00Z","estimatedArrivalDate":"2026-02-01T13:00:00Z","fullyReceivedDate":"2026-02-12T03:39:00Z","customFields":{"orders_1000":"9-2-2026"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":20691.2562,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":75.0,"DD-21137CF":150.0,"DD-21915CF":26.0}},{"reference":"PO-2146","status":"APPROVED","stage":"Received","arrival":"2025-12-25T13:00:00Z","estimatedArrivalDate":"2026-01-29T13:00:00Z","fullyReceivedDate":"2026-02-03T22:26:00Z","customFields":{"orders_1000":""},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":20861.5558,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-21107CF":75.0,"DD-21137CF":150.0,"DD-21915CF":26.0}},{"reference":"PO-2145","status":"APPROVED","stage":"Received","arrival":"2026-01-02T13:00:00Z","estimatedArrivalDate":"2026-02-02T13:00:00Z","fullyReceivedDate":"2026-02-11T01:41:00Z","customFields":{"orders_1000":"14-Feb-2026"},"company":"Caoxian Dianshang Furniture Co., Ltd","total":38927.8541,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"CL-WB102-S-ECO":50.0,"CL-WB117-KS-ECO":40.0,"CL-WB147-D-ECO":10.0,"CL-WB163-Q-ECO":70.0,"CL-WB163-Q-WNT-ECO":30.0,"CLV2-WB147-D-ECO":20.0,"CLV2-WB147-D-WNT-ECO":20.0,"CLV2-WB163-Q-ECO":40.0,"CLV2-WB163-Q-WNT-ECO":90.0,"CLV2-WB193-K-WNT-ECO":40.0,"CRSN-SB-NATR-ECO":20.0,"CLV2-WB147-D-ECO-1":20.0,"CLV2-WB147-D-ECO-2":20.0,"CLV2-WB147-D-WNT-ECO-1":20.0,"CLV2-WB147-D-WNT-ECO-2":20.0,"CLV2-WB163-Q-ECO-1":40.0,"CLV2-WB163-Q-ECO-2":40.0,"CLV2-WB163-Q-WNT-ECO-1":90.0,"CLV2-WB163-Q-WNT-ECO-2":90.0,"CLV2-WB193-K-WNT-ECO-1":40.0,"CLV2-WB193-K-WNT-ECO-2":40.0,"CRSN-SB-NATR-ECO-1":20.0,"CRSN-SB-NATR-ECO-2":20.0}},{"reference":"PO-2142","status":"APPROVED","stage":"Received","arrival":"2026-01-06T13:00:00Z","estimatedArrivalDate":"2026-01-22T13:00:00Z","fullyReceivedDate":"2026-01-27T20:41:00Z","customFields":{"orders_1000":"2-2-2026"},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":48227.087,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-107KSMF":20.0,"DD-137DMF":33.0,"DD-153Q-PLUSH":20.0,"DD-153QMF":65.0,"DD-183K-PLUSH":20.0,"DD-183KMF":21.0,"DD-21137CF":55.0,"DD-34183K-SFM":20.0,"DD-36137SG":15.0,"DD-36153SG":30.0,"DD-36183SG":20.0}},{"reference":"PO-2141","status":"APPROVED","stage":"Received","arrival":"2025-12-19T13:00:00Z","estimatedArrivalDate":"2026-01-23T13:00:00Z","fullyReceivedDate":"2026-01-29T03:13:00Z","customFields":{"orders_1000":""},"company":"GUANGDONG EONJOY TECHNOLOGY LIMITED.","total":46377.0426,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"DD-137DMF":47.0,"DD-153QMF":84.0,"DD-183KMF":19.0,"DD-21137CF":75.0,"DD-36137SG":15.0,"DD-36153SG":50.0,"DD-36183SG":30.0}},{"reference":"PO-2140","status":"APPROVED","stage":"Received","arrival":"2026-01-07T13:00:00Z","estimatedArrivalDate":"2026-01-26T13:00:00Z","fullyReceivedDate":"2026-01-30T04:29:00Z","customFields":{"orders_1000":"2-2-2026"},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":15237.7972,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"LYLA-BF-K-ECO":1.0,"LYLA-BF-K-ECO-1":1.0,"LYLA-BF-K-ECO-2":1.0,"LYLA-BF-GL-K-ECO":25.0,"LYLA-BF-GL-K-ECO-1":25.0,"LYLA-BF-GL-K-ECO-2":25.0,"LYLA-BF-GL-K-ECO-3":25.0,"LYLA-BF-GL-Q-ECO":15.0,"LYLA-BF-GL-Q-ECO-1":15.0,"LYLA-BF-GL-Q-ECO-2":15.0,"LYLA-BF-GL-Q-ECO-3":15.0,"LYLA-BF-GL-Q-ECO-4":15.0}},{"reference":"PO-2136","status":"APPROVED","stage":"Received","arrival":"2025-11-14T13:00:00Z","estimatedArrivalDate":"2025-12-18T13:00:00Z","fullyReceivedDate":"2026-01-14T22:16:00Z","customFields":{"orders_1000":""},"company":"HUI ZHOU MING XIN FURNITURE CO., LTD","total":7789.676,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"HLO-DC-WHT-ECO":21.0,"NIC-BS-BLK-ECO":50.0,"ALCE-BS-ECO":46.0}},{"reference":"PO-CA002","status":"APPROVED","stage":"New","arrival":"2026-01-31T04:08:00Z","estimatedArrivalDate":"2026-03-07T04:08:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"2026-3-7"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":56223.3048,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"V3-ARM-DKBL":44.0,"V3-ARM-LGN":67.0,"V3-ARM-TBRN":32.0,"V3-ARM-TWHT":54.0,"V3-DB-DKBL":11.0,"V3-DB-LGN":14.0,"V3-DB-TBRN":8.0,"V3-DB-TWHT":12.0,"V3-KB-DKBL":6.0,"V3-KB-LGN":12.0,"V3-KB-TBRN":6.0,"V3-KB-TWHT":12.0,"V3-QB-DKBL":16.0,"V3-QB-LGN":27.0,"V3-QB-TBRN":10.0,"V3-QB-TWHT":18.0,"V3-TB-DKBL":11.0,"V3-TB-LGN":14.0,"V3-TB-TBRN":8.0,"V3-TB-TWHT":12.0}},{"reference":"PO-CA001","status":"APPROVED","stage":"New","arrival":"2025-12-29T13:00:00Z","estimatedArrivalDate":"2026-02-01T06:46:00Z","fullyReceivedDate":null,"customFields":{"orders_1000":"13-12-2025"},"company":"Shaoxing Xilinmen Import & Export Co., Ltd.","total":37498.9787,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"Vancouver","items":{"V2-CH-CREAM":1.0,"V2-CH-DKBL":1.0,"V2-CH-LGN":3.0,"V2-DB-CREAM":11.0,"V2-DB-DKBL":4.0,"V2-DB-LGN":14.0,"V2-OB-CREAM":1.0,"V2-OB-DKBL":1.0,"V2-OB-LGN":1.0,"V2-OS-CREAM":3.0,"V2-OS-DKBL":3.0,"V2-OS-LGN":5.0,"V2-QB-CREAM":10.0,"V2-QB-DKBL":15.0,"V2-QB-LGN":40.0,"V2-RMST-CREAM":33.0,"V2-RMST-DKBL":25.0,"V2-RMST-LGN":85.0,"V2-TB-CREAM":14.0,"V2-TB-DKBL":10.0,"V2-TB-LGN":46.0}},{"reference":"PO-2107","status":"APPROVED","stage":"Received","arrival":"2025-09-04T14:00:00Z","estimatedArrivalDate":"2025-10-09T13:00:00Z","fullyReceivedDate":"2026-01-20T02:40:00Z","customFields":{"orders_1000":""},"company":"Shenzhen Ouluo Furniture Co., Ltd.","total":19725.7017,"currencyCode":"USD","deliveryCountry":"","trackingCode":"","port":"","items":{"ARCH-BH-D-ECO":15.0,"ARCH-BH-Q-ECO":25.0,"TOB-BCH-ECO":25.0,"PAV-BF-K-ECO":6.0,"PAV-BF-K-ECO-1":6.0,"PAV-BF-K-ECO-2":6.0,"PAV-BF-K-ECO-3":6.0,"PAV-BF-Q-ECO":6.0,"PAV-BF-Q-ECO-1":6.0,"PAV-BF-Q-ECO-2":6.0,"PAV-BF-Q-ECO-3":6.0,"LYLA-BF-GL-K-ECO":3.0,"LYLA-BF-GL-K-ECO-1":3.0,"LYLA-BF-GL-K-ECO-2":3.0,"LYLA-BF-GL-K-ECO-3":3.0,"LYLA-BF-GL-Q-ECO":4.0,"LYLA-BF-GL-Q-ECO-1":4.0,"LYLA-BF-GL-Q-ECO-2":4.0,"LYLA-BF-GL-Q-ECO-3":4.0,"LYLA-BF-GL-Q-ECO-4":4.0,"JOSE-BF-GL-K-ECO":7.0,"JOSE-BF-GL-K-ECO-1":7.0,"JOSE-BF-GL-K-ECO-2":7.0,"JOSE-BF-GL-K-ECO-3":7.0,"JOSE-BF-GL-K-ECO-4":7.0,"JOSE-BF-GL-Q-ECO":9.0,"JOSE-BF-GL-Q-ECO-1":9.0,"JOSE-BF-GL-Q-ECO-2":9.0,"JOSE-BF-GL-Q-ECO-3":9.0,"JOSE-BF-GL-Q-ECO-4":9.0}},{"reference":"PO-48386","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC AUD","total":2871.55,"currencyCode":"AUD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48385","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC USD","total":2294.3038,"currencyCode":"USD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48381","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC AUD","total":5301.67,"currencyCode":"AUD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":2.0}},{"reference":"PO-48379","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC USD","total":4523.508,"currencyCode":"USD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":2.0}},{"reference":"PO-48378","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC AUD","total":2801.89,"currencyCode":"AUD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48377","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC USD","total":2262.0484,"currencyCode":"USD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48375","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC AUD","total":2801.89,"currencyCode":"AUD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48374","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC USD","total":2207.3198,"currencyCode":"USD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48372","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC AUD","total":2971.65,"currencyCode":"AUD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48371","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC USD","total":2261.0793,"currencyCode":"USD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48370","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC AUD","total":2871.55,"currencyCode":"AUD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}},{"reference":"PO-48331","status":"APPROVED","stage":"New","arrival":null,"estimatedArrivalDate":null,"fullyReceivedDate":null,"customFields":{"orders_1000":""},"company":"CIMC","total":2261.0793,"currencyCode":"USD","deliveryCountry":"Australia","trackingCode":"","port":"","items":{"Freight":1.0}}]};
console.log('CIN7 fallback: ' + Object.keys(cin7Fallback.products).length + ' products embedded');

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
    
    // Use live CIN7 data if available, otherwise fall back to bundled data
    if (Object.keys(cin7Products).length > 0) {
      dataCache.cin7Products = cin7Products;
      console.log('Using LIVE CIN7 data: ' + Object.keys(cin7Products).length + ' SKUs');
    } else if (cin7Fallback) {
      dataCache.cin7Products = cin7Fallback.products || {};
      console.log('CIN7 API returned empty — using FALLBACK data (' + Object.keys(dataCache.cin7Products).length + ' SKUs, from ' + cin7Fallback.generated + ')');
    } else {
      dataCache.cin7Products = cin7Products; // empty, but nothing we can do
    }

    if (cin7POs.length > 0) {
      dataCache.cin7POs = cin7POs;
    } else if (cin7Fallback && cin7Fallback.pos) {
      dataCache.cin7POs = cin7Fallback.pos;
      console.log('CIN7 POs empty — using fallback (' + cin7Fallback.pos.length + ' POs)');
    } else {
      dataCache.cin7POs = cin7POs;
    }
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
  
  // CIN7 stock — first collect raw, then normalize
  const cin7Raw = {};
  for (const [sku, data] of Object.entries(dataCache.cin7Products)) {
    if (sku.startsWith(prefix) && filter(sku)) {
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
  }
  
  // Shopify inventory
  const shopify = {};
  const storeInv = dataCache.shopifyInventory[storeKey] || {};
  for (const [sku, qty] of Object.entries(storeInv)) {
    if (sku.startsWith(prefix) && filter(sku)) {
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
    if (sku.startsWith(prefix) && filter(sku)) {
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
      if (sku.startsWith(prefix) && filter(sku)) {
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
  
  return {
    ck: def,
    cin7,
    shopify,
    velocity,
    pos,
    names,
    sizes: def.sizes,
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
    if (etd && eta) {
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
