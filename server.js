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
// CIN7 fallback data (Render can't reach CIN7 API directly)
const CIN7_FALLBACK = {"COCOON-KING-IVR-1":{"soh":11.0,"available":11.0},"COCOON-KING-IVR-2":{"soh":11.0,"available":11.0},"COCOON-QUEEN-IVR-1":{"soh":7.0,"available":5.0},"COCOON-QUEEN-IVR-2":{"soh":7.0,"available":5.0},"COCOON-DOUBLE-IVR-1":{"soh":3.0,"available":3.0},"COCOON-DOUBLE-IVR-2":{"soh":3.0,"available":3.0},"COCOON-KING-CRML-1":{"soh":31.0,"available":26.0},"COCOON-KING-CRML-2":{"soh":31.0,"available":26.0},"COCOON-QUEEN-CRML-1":{"soh":7.0,"available":7.0},"COCOON-QUEEN-CRML-2":{"soh":7.0,"available":7.0},"COCOON-DOUBLE-CRML-1":{"soh":7.0,"available":7.0},"COCOON-DOUBLE-CRML-2":{"soh":6.0,"available":6.0},"COCOON-KING-MSGRN-1":{"soh":25.0,"available":24.0},"COCOON-KING-MSGRN-2":{"soh":25.0,"available":24.0},"COCOON-QUEEN-MSGRN-1":{"soh":12.0,"available":12.0},"COCOON-QUEEN-MSGRN-2":{"soh":12.0,"available":12.0},"COCOON-DOUBLE-MSGRN-1":{"soh":9.0,"available":9.0},"COCOON-DOUBLE-MSGRN-2":{"soh":9.0,"available":9.0},"CUSB-ARST-SET-LTGN":{"soh":62.0,"available":53.0},"CUSB-D-LTGN-1":{"soh":12.0,"available":8.0},"CUSB-D-LTGN-2":{"soh":12.0,"available":8.0},"CUSB-K-LTGN-1":{"soh":18.0,"available":17.0},"CUSB-K-LTGN-2":{"soh":18.0,"available":17.0},"CUSB-Q-LTGN-1":{"soh":17.0,"available":14.0},"CUSB-Q-LTGN-2":{"soh":16.0,"available":13.0},"CUSB-TW-LTGN-1":{"soh":13.0,"available":12.0},"CUSB-TW-LTGN-2":{"soh":13.0,"available":12.0},"LFSB-AMST-WHT-CV":{"soh":2.0,"available":2.0},"LLAU-CB-KS-DSBL-CV":{"soh":1.0,"available":0.0},"LLAU-CB-D-DSBL-CV":{"soh":1.0,"available":-3.0},"LLAU-CB-S-DGY-CV":{"soh":1.0,"available":-1.0},"LLAU-CB-D-DGY-CV":{"soh":5.0,"available":0.0},"LLAU-CB-S-PST-CV":{"soh":2.0,"available":-4.0},"LLAU-CB-KS-PST-CV":{"soh":1.0,"available":-1.0},"LLAU-CB-D-BABL-CV":{"soh":1.0,"available":-8.0},"LLAU-CB-KS-CTCN-CV":{"soh":2.0,"available":-2.0},"LLAU-CB-S-MSM-CV":{"soh":1.0,"available":-2.0},"LLAU-CB-D-MSM-CV":{"soh":2.0,"available":-8.0},"LLSG-CB-S-DGY-CV":{"soh":3.0,"available":3.0},"LLSG-CB-SS-DGY-CV":{"soh":1.0,"available":1.0},"LLSG-CB-Q-DGY-CV":{"soh":2.0,"available":2.0},"LLSG-CB-S-PST-CV":{"soh":1.0,"available":1.0},"LLSG-CB-SS-PST-CV":{"soh":1.0,"available":1.0},"LLSG-CB-Q-PST-CV":{"soh":1.0,"available":1.0},"LLSG-CB-S-BABL-CV":{"soh":2.0,"available":2.0},"LLSG-CB-SS-BABL-CV":{"soh":2.0,"available":2.0},"LLSG-CB-Q-BABL-CV":{"soh":2.0,"available":2.0},"LLSG-CB-S-CTCN-CV":{"soh":2.0,"available":2.0},"LLSG-CB-SS-CTCN-CV":{"soh":6.0,"available":6.0},"LLSG-CB-Q-CTCN-CV":{"soh":2.0,"available":2.0},"LLSG-CB-S-MSM-CV":{"soh":4.0,"available":4.0},"LLSG-CB-SS-MSM-CV":{"soh":3.0,"available":3.0},"LLSG-CB-Q-MSM-CV":{"soh":1.0,"available":1.0},"LLAU-CB-CS-DSBL":{"soh":264.0,"available":246.0},"LLAU-CB-CS-DGY":{"soh":263.0,"available":245.0},"LLAU-CB-CS-PST":{"soh":263.0,"available":245.0},"LLAU-CB-CS-BABL":{"soh":263.0,"available":245.0},"LLAU-CB-CS-CTCN":{"soh":263.0,"available":245.0},"LLAU-CB-CS-MSM":{"soh":263.0,"available":245.0},"LFSB-AMST-CV-CHC":{"soh":3.0,"available":3.0},"LFSB-AMST-CV-LTGN":{"soh":6.0,"available":6.0},"LFSB-AMST-CV-WHT":{"soh":3.0,"available":3.0},"RDNT-PROT-D":{"soh":29.0,"available":29.0},"RDNT-PROT-Q":{"soh":25.0,"available":25.0},"RDNT-PROT-K":{"soh":34.0,"available":34.0},"JSPH-DC-WNT-ECO":{"soh":41.0,"available":41.0},"LUK-BS-NAL-ECO":{"soh":34.0,"available":34.0},"WFHCR-CRM":{"soh":16.0,"available":16.0},"HANK-CT-WNT-ECO-1":{"soh":33.0,"available":31.0},"HANK-CT-WNT-ECO-2":{"soh":33.0,"available":31.0},"HANK-SB160-WNT-ECO-1":{"soh":21.0,"available":20.0},"HANK-SB160-WNT-ECO-2":{"soh":22.0,"available":21.0},"HANK-SB160-WNT-ECO-3":{"soh":19.0,"available":18.0},"ALX-BF-K-NAL-ECO-1":{"soh":40.0,"available":40.0},"ALX-BF-K-NAL-ECO-2":{"soh":40.0,"available":40.0},"ALX-BF-K-NAL-ECO-3":{"soh":41.0,"available":41.0},"ALX-BF-Q-NAL-ECO-1":{"soh":44.0,"available":43.0},"ALX-BF-Q-NAL-ECO-2":{"soh":44.0,"available":43.0},"ALX-BF-Q-NAL-ECO-3":{"soh":44.0,"available":43.0},"BNC-6COD-WNT-ECO-1":{"soh":28.0,"available":27.0},"BNC-6COD-WNT-ECO-2":{"soh":28.0,"available":27.0},"BNC-6COD-WNT-ECO-3":{"soh":28.0,"available":27.0},"GEM-RTDSK-WNT-ECO-1":{"soh":43.0,"available":43.0},"GEM-RTDSK-WNT-ECO-2":{"soh":43.0,"available":43.0},"GEM-RTDSK-WNT-ECO-3":{"soh":43.0,"available":43.0},"IRSA-BF-K-WNT-ECO-1":{"soh":46.0,"available":46.0},"IRSA-BF-K-WNT-ECO-2":{"soh":46.0,"available":46.0},"IRSA-BF-K-WNT-ECO-3":{"soh":46.0,"available":46.0},"IRSA-BF-Q-WNT-ECO-1":{"soh":47.0,"available":47.0},"IRSA-BF-Q-WNT-ECO-2":{"soh":47.0,"available":47.0},"IRSA-BF-Q-WNT-ECO-3":{"soh":47.0,"available":47.0},"JAM-BF-K-OAK-ECO-1":{"soh":37.0,"available":37.0},"JAM-BF-K-OAK-ECO-2":{"soh":37.0,"available":37.0},"JAM-BF-K-OAK-ECO-3":{"soh":37.0,"available":37.0},"JAM-BF-Q-OAK-ECO-1":{"soh":41.0,"available":41.0},"JAM-BF-Q-OAK-ECO-2":{"soh":41.0,"available":41.0},"JAM-BF-Q-OAK-ECO-3":{"soh":41.0,"available":41.0},"KTH-SB180-WNT-ECO-1":{"soh":33.0,"available":33.0},"KTH-SB180-WNT-ECO-2":{"soh":33.0,"available":33.0},"KTH-SB180-WNT-ECO-3":{"soh":33.0,"available":33.0},"KTH-SB180-WNT-ECO-4":{"soh":33.0,"available":33.0},"LARY-6COD-ECO-1":{"soh":1.0,"available":-1.0},"LARY-6COD-ECO-2":{"soh":1.0,"available":-1.0},"LARY-6COD-ECO-3":{"soh":1.0,"available":-1.0},"MAX-SC-ECO-1":{"soh":26.0,"available":26.0},"MAX-SC-ECO-2":{"soh":26.0,"available":26.0},"MAX-SC-ECO-3":{"soh":26.0,"available":26.0},"MAX-SC-ECO-4":{"soh":25.0,"available":25.0},"WIBR-DSK-ECO-1":{"soh":16.0,"available":16.0},"WIBR-DSK-ECO-2":{"soh":17.0,"available":17.0},"LLAU-CB-S-DSBL":{"soh":22.0,"available":10.0},"LLAU-CB-KS-DSBL":{"soh":8.0,"available":-6.0},"LLAU-CB-D-DSBL":{"soh":113.0,"available":96.0},"LLAU-CB-S-DGY":{"soh":106.0,"available":87.0},"LLAU-CB-KS-DGY":{"soh":48.0,"available":29.0},"LLAU-CB-D-DGY":{"soh":44.0,"available":21.0},"LLAU-CB-S-PST":{"soh":11.0,"available":-24.0},"LLAU-CB-KS-PST":{"soh":44.0,"available":1.0},"LLAU-CB-D-PST":{"soh":152.0,"available":116.0},"LLAU-CB-S-BABL":{"soh":3.0,"available":-48.0},"LLAU-CB-KS-BABL":{"soh":14.0,"available":-41.0},"LLAU-CB-D-BABL":{"soh":37.0,"available":-4.0},"LLAU-CB-S-CTCN":{"soh":158.0,"available":116.0},"LLAU-CB-KS-CTCN":{"soh":123.0,"available":93.0},"LLAU-CB-D-CTCN":{"soh":211.0,"available":152.0},"LLAU-CB-S-MSM":{"soh":223.0,"available":102.0},"LLAU-CB-KS-MSM":{"soh":50.0,"available":-39.0},"LLAU-CB-D-MSM":{"soh":124.0,"available":37.0},"LLSG-CB-S-DGY":{"soh":12.0,"available":11.0},"LLSG-CB-SS-DGY":{"soh":4.0,"available":4.0},"LLSG-CB-Q-DGY":{"soh":10.0,"available":9.0},"LLSG-CB-S-PST":{"soh":4.0,"available":4.0},"LLSG-CB-SS-PST":{"soh":6.0,"available":6.0},"LLSG-CB-Q-PST":{"soh":4.0,"available":4.0},"LLSG-CB-S-BABL":{"soh":10.0,"available":10.0},"LLSG-CB-SS-BABL":{"soh":10.0,"available":9.0},"LLSG-CB-Q-BABL":{"soh":10.0,"available":10.0},"LLSG-CB-S-CTCN":{"soh":11.0,"available":10.0},"LLSG-CB-SS-CTCN":{"soh":18.0,"available":15.0},"LLSG-CB-Q-CTCN":{"soh":10.0,"available":10.0},"LLSG-CB-S-MSM":{"soh":16.0,"available":12.0},"LLSG-CB-SS-MSM":{"soh":12.0,"available":12.0},"LLSG-CB-Q-MSM":{"soh":5.0,"available":4.0},"HLO-DC-WHT-ECO":{"soh":18.0,"available":18.0},"NIC-BS-BLK-ECO":{"soh":45.0,"available":45.0},"ALCE-BS-ECO":{"soh":3.0,"available":3.0},"LIAM-DC-WHT-ECO":{"soh":38.0,"available":38.0},"ERC-BS-CUSH-NAL-ECO":{"soh":38.0,"available":38.0},"JCB-DC-NAL-ECO":{"soh":41.0,"available":41.0},"CUSB-ARST-SET-TBRN":{"soh":30.0,"available":27.0},"CUSB-ARST-SET-TWHT":{"soh":79.0,"available":76.0},"CUSB-ARST-SET-DNM":{"soh":72.0,"available":66.0},"CUSB-D-DNM-1":{"soh":17.0,"available":15.0},"CUSB-D-DNM-2":{"soh":17.0,"available":15.0},"CUSB-D-TBRN-1":{"soh":5.0,"available":4.0},"CUSB-D-TBRN-2":{"soh":5.0,"available":4.0},"CUSB-D-TWHT-1":{"soh":13.0,"available":13.0},"CUSB-D-TWHT-2":{"soh":13.0,"available":13.0},"CUSB-K-DNM-1":{"soh":6.0,"available":5.0},"CUSB-K-DNM-2":{"soh":6.0,"available":5.0},"CUSB-K-TBRN-1":{"soh":7.0,"available":7.0},"CUSB-K-TBRN-2":{"soh":7.0,"available":7.0},"CUSB-K-TWHT-1":{"soh":17.0,"available":17.0},"CUSB-K-TWHT-2":{"soh":17.0,"available":17.0},"CUSB-Q-DNM-1":{"soh":29.0,"available":28.0},"CUSB-Q-DNM-2":{"soh":29.0,"available":28.0},"CUSB-Q-TBRN-1":{"soh":7.0,"available":6.0},"CUSB-Q-TBRN-2":{"soh":7.0,"available":6.0},"CUSB-Q-TWHT-1":{"soh":31.0,"available":29.0},"CUSB-Q-TWHT-2":{"soh":31.0,"available":29.0},"CUSB-TW-DNM-1":{"soh":14.0,"available":13.0},"CUSB-TW-DNM-2":{"soh":14.0,"available":13.0},"CUSB-TW-TBRN-1":{"soh":6.0,"available":5.0},"CUSB-TW-TBRN-2":{"soh":6.0,"available":5.0},"CUSB-TW-TWHT-1":{"soh":13.0,"available":12.0},"CUSB-TW-TWHT-2":{"soh":13.0,"available":12.0},"SILV-MR16-OW-ECO":{"soh":39.0,"available":39.0},"OLV-MR18-WNT-ECO":{"soh":32.0,"available":32.0},"MEG-MR16-WNT-ECO":{"soh":37.0,"available":37.0},"JILN-6COD-OAK-ECO-1":{"soh":26.0,"available":26.0},"JILN-6COD-OAK-ECO-2":{"soh":26.0,"available":26.0},"ODEN-DSK-ADJ-OAK-ECO-1":{"soh":27.0,"available":27.0},"ODEN-DSK-ADJ-OAK-ECO-2":{"soh":27.0,"available":27.0},"CAM-DSK-ADJ-WG-ECO-1":{"soh":34.0,"available":33.0},"CAM-DSK-ADJ-WG-ECO-2":{"soh":34.0,"available":33.0},"JOSE-BF-GL-K-ECO-2":{"soh":1.0,"available":1.0},"JOSE-BF-GL-K-ECO-3":{"soh":1.0,"available":1.0},"JOSE-BF-GL-K-ECO-4":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-1":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-2":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-3":{"soh":1.0,"available":1.0},"JOSE-BF-GL-Q-ECO-4":{"soh":1.0,"available":1.0},"PVO-SBCH-140-ECO":{"soh":19.0,"available":19.0},"RDNT-D-BASE":{"soh":52.0,"available":51.0},"RDNT-D-S":{"soh":33.0,"available":31.0},"RDNT-D-MF":{"soh":47.0,"available":47.0},"RDNT-D-F":{"soh":22.0,"available":22.0},"RDNT-Q-BASE":{"soh":170.0,"available":167.0},"RDNT-Q-S":{"soh":68.0,"available":66.0},"RDNT-Q-MF":{"soh":41.0,"available":37.0},"RDNT-Q-F":{"soh":45.0,"available":45.0},"RDNT-K-BASE":{"soh":100.0,"available":97.0},"RDNT-K-S":{"soh":37.0,"available":35.0},"RDNT-K-MF":{"soh":2.0,"available":1.0},"LYLA-BF-GL-K-ECO-1":{"soh":2.0,"available":-3.0},"LYLA-BF-GL-K-ECO-2":{"soh":2.0,"available":-3.0},"LYLA-BF-GL-K-ECO-3":{"soh":2.0,"available":-3.0},"LYLA-BF-GL-Q-ECO-2":{"soh":1.0,"available":-1.0},"LYLA-BF-GL-Q-ECO-3":{"soh":1.0,"available":-1.0},"LYLA-BF-GL-Q-ECO-4":{"soh":1.0,"available":-1.0},"LFSB-CHS-CHC-1":{"soh":5.0,"available":5.0},"LFSB-CHS-CHC-2":{"soh":5.0,"available":5.0},"LFSB-Q-CHC-1":{"soh":40.0,"available":40.0},"LFSB-Q-CHC-2":{"soh":40.0,"available":40.0},"LFSB-TW-CHC-1":{"soh":21.0,"available":21.0},"LFSB-TW-CHC-2":{"soh":21.0,"available":21.0},"LFSB-Q-LTGN-1":{"soh":74.0,"available":67.0},"LFSB-Q-LTGN-2":{"soh":75.0,"available":68.0},"LFSB-D-LTGN-1":{"soh":5.0,"available":1.0},"LFSB-D-LTGN-2":{"soh":4.0,"available":0.0},"LFSB-TW-LTGN-1":{"soh":155.0,"available":152.0},"LFSB-TW-LTGN-2":{"soh":162.0,"available":159.0},"LFSB-D-WHT-1":{"soh":18.0,"available":17.0},"LFSB-D-WHT-2":{"soh":18.0,"available":17.0},"LFSB-CHS-WHT-1":{"soh":7.0,"available":7.0},"LFSB-CHS-WHT-2":{"soh":7.0,"available":7.0},"LFSB-TW-WHT-1":{"soh":26.0,"available":25.0},"LFSB-TW-WHT-2":{"soh":27.0,"available":26.0},"BRN-6COD-ECO-1":{"soh":20.0,"available":20.0},"BRN-6COD-ECO-2":{"soh":20.0,"available":20.0},"BRN-6COD-ECO-3":{"soh":20.0,"available":20.0},"OKL-TV200-ECO-1":{"soh":1.0,"available":1.0},"OKL-TV200-ECO-2":{"soh":1.0,"available":1.0},"OKL-TV200-ECO-3":{"soh":1.0,"available":1.0},"CMSS-SB-S-CHC":{"soh":4.0,"available":4.0},"ADN-TV180-ASH-ECO-1":{"soh":1.0,"available":1.0},"BRL-BWD-BT-ECO":{"soh":6.0,"available":6.0},"HANK-CT-ASH-ECO-1":{"soh":1.0,"available":1.0},"HANK-SB160-ASH-ECO-1":{"soh":3.0,"available":3.0},"HANK-SB160-ASH-ECO-2":{"soh":3.0,"available":3.0},"HANK-CST-ASH-ECO-1":{"soh":1.0,"available":0.0},"HANK-CST-ASH-ECO-2":{"soh":1.0,"available":0.0},"HANK-TV180-ASH-ECO-1":{"soh":1.0,"available":1.0},"HANK-TV180-ASH-ECO-2":{"soh":1.0,"available":1.0},"SENA-CT-DKGN-ECO":{"soh":17.0,"available":17.0},"FELX-V2-BB-K-ECO-1":{"soh":2.0,"available":2.0},"FELX-V2-BB-K-ECO-3":{"soh":2.0,"available":2.0},"TOB-BCH-ECO":{"soh":9.0,"available":8.0},"PAV-BF-K-ECO-1":{"soh":7.0,"available":7.0},"PAV-BF-K-ECO-2":{"soh":7.0,"available":7.0},"PAV-BF-K-ECO-3":{"soh":7.0,"available":7.0},"PAV-BF-Q-ECO-1":{"soh":14.0,"available":14.0},"PAV-BF-Q-ECO-2":{"soh":13.0,"available":13.0},"PAV-BF-Q-ECO-3":{"soh":14.0,"available":14.0},"FMA-SB160-WNT-ECO-1":{"soh":2.0,"available":2.0},"FMA-SB160-WNT-ECO-2":{"soh":2.0,"available":2.0},"FMA-SB160-WNT-ECO-3":{"soh":1.0,"available":1.0},"LFSF-AMLS-CV-DKGN":{"soh":18.0,"available":12.0},"LFSF-CRNR-CV-DKGN":{"soh":67.0,"available":61.0},"LFSF-OTM-CV-DKGN":{"soh":23.0,"available":19.0},"LFSF-OTM-CV-CHC":{"soh":6.0,"available":-9.0},"LFSF-CRNR-CV-CRMPIP":{"soh":3.0,"available":-20.0},"LFSF-AMLS-CV-BLST":{"soh":17.0,"available":13.0},"LFSF-CRNR-CV-BLST":{"soh":13.0,"available":9.0},"LFSF-OTM-CV-BLST":{"soh":4.0,"available":0.0},"ODEN-SC-OAK-ECO-3":{"soh":11.0,"available":11.0},"DIRI-DS-CRM-ECO-2":{"soh":2.0,"available":1.0},"DIRI-DS-CRM-ECO-3":{"soh":2.0,"available":2.0},"AFI-BF-Q-WHT-ECO-1":{"soh":1.0,"available":0.0},"AFI-BF-Q-WHT-ECO-2":{"soh":2.0,"available":1.0},"TATE-EDT-WNT-ECO-1":{"soh":3.0,"available":-27.0},"TATE-EDT-WNT-ECO-2":{"soh":3.0,"available":-27.0},"TATE-EDT-WNT-ECO-3":{"soh":3.0,"available":-27.0},"WILY-ED160-WNT-ECO-1":{"soh":4.0,"available":3.0},"WILY-ED160-WNT-ECO-2":{"soh":4.0,"available":3.0},"WILY-ED160-WNT-ECO-3":{"soh":4.0,"available":3.0},"IRNE-TV180-OAK-ECO-1":{"soh":1.0,"available":0.0},"IRNE-TV180-OAK-ECO-2":{"soh":1.0,"available":0.0},"IRNE-TV200-OAK-ECO-1":{"soh":7.0,"available":5.0},"IRNE-TV200-OAK-ECO-2":{"soh":1.0,"available":-1.0},"THEO-TV200-ASH-ECO-2":{"soh":1.0,"available":1.0},"FMA-6COD-WNT-ECO-1":{"soh":63.0,"available":63.0},"FMA-6COD-WNT-ECO-2":{"soh":64.0,"available":64.0},"FMA-6COD-WNT-ECO-3":{"soh":64.0,"available":64.0},"KTZ-CT120-WHT-ECO-1":{"soh":1.0,"available":1.0},"KTZ-CT120-WHT-ECO-2":{"soh":1.0,"available":1.0},"KTZ-ST-WHT-ECO-1":{"soh":10.0,"available":10.0},"KTZ-ST-WHT-ECO-2":{"soh":11.0,"available":11.0},"JOSE-BF-Q-FG-ECO-1":{"soh":1.0,"available":1.0},"JOSE-BF-Q-FG-ECO-2":{"soh":1.0,"available":1.0},"JOSE-BF-K-FG-ECO-2":{"soh":2.0,"available":0.0},"EVE-BF-Q-NAL-ECO-1":{"soh":3.0,"available":3.0},"EVE-BF-Q-NAL-ECO-2":{"soh":2.0,"available":2.0},"EVE-BF-Q-NAL-ECO-3":{"soh":3.0,"available":3.0},"EVE-BF-Q-NAL-ECO-4":{"soh":3.0,"available":3.0},"EVE-BF-K-NAL-ECO-1":{"soh":1.0,"available":1.0},"EVE-BF-K-NAL-ECO-2":{"soh":1.0,"available":1.0},"EVE-BF-K-NAL-ECO-3":{"soh":1.0,"available":1.0},"EVE-BF-K-NAL-ECO-4":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-1":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-2":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-3":{"soh":1.0,"available":1.0},"EVE-BF-D-ECO-4":{"soh":1.0,"available":1.0},"LOLA-HBSF-NAL-ECO-1":{"soh":1.0,"available":1.0},"LOLA-HBSF-NAL-ECO-2":{"soh":1.0,"available":1.0},"LOLA-LBSF-NAL-ECO-1":{"soh":21.0,"available":21.0},"LOLA-LBSF-NAL-ECO-2":{"soh":21.0,"available":21.0},"HDSN-EDT-OAK-ECO-2":{"soh":7.0,"available":7.0},"THEO-SB180-ASH-ECO-1":{"soh":2.0,"available":1.0},"THEO-SB180-ASH-ECO-2":{"soh":1.0,"available":0.0},"THEO-SB180-ASH-ECO-3":{"soh":2.0,"available":1.0},"BLC-TV200-WNT-ECO-1":{"soh":2.0,"available":2.0},"BLC-TV200-WNT-ECO-2":{"soh":1.0,"available":1.0},"AVRY-FLAMP-CG-ECO-1":{"soh":13.0,"available":12.0},"AVRY-FLAMP-CG-ECO-2":{"soh":14.0,"available":13.0},"VRT-B140-FNG-ECO-2":{"soh":1.0,"available":1.0},"ODEN-SC-OAK-ECO-1":{"soh":9.0,"available":9.0},"ODEN-SC-OAK-ECO-2":{"soh":10.0,"available":10.0},"KTZ-DT110-WHT-ECO-1":{"soh":10.0,"available":10.0},"KTZ-DT110-WHT-ECO-2":{"soh":7.0,"available":7.0},"HAZ-CT-NAL-ECO":{"soh":2.0,"available":1.0},"ODEN-SC-OAK-ECO":{"soh":1.0,"available":1.0},"LFSF-AMLS-FC":{"soh":176.0,"available":106.0},"LFSF-CRNR-FC":{"soh":293.0,"available":204.0},"LFSF-OTM-FC":{"soh":74.0,"available":18.0},"LFSF-AMLS-CV-WHT":{"soh":2.0,"available":-2.0},"LFSF-AMCR-CV-WHT":{"soh":4.0,"available":4.0},"LFSF-CRNR-CV-WHT":{"soh":19.0,"available":16.0},"LFSF-OTM-CV-WHT":{"soh":7.0,"available":6.0},"LFSF-AMLS-CV-OG":{"soh":151.0,"available":148.0},"LFSF-CRNR-CV-OG":{"soh":205.0,"available":196.0},"LFSF-OTM-CV-OG":{"soh":42.0,"available":41.0},"LFSF-AMCR-CV-RST":{"soh":5.0,"available":5.0},"LFSF-CRNR-CV-LB":{"soh":28.0,"available":-27.0},"LFSF-OTM-CV-LB":{"soh":17.0,"available":-13.0},"LFSB-SOTM-CHC":{"soh":5.0,"available":5.0},"LFSB-S-CHC":{"soh":16.0,"available":16.0},"LFSB-AMST-CHC":{"soh":60.0,"available":57.0},"LFSB-Q-CV-CHC":{"soh":2.0,"available":2.0},"LFSB-TW-CV-CHC":{"soh":1.0,"available":1.0},"LFSB-SOTM-LTGN":{"soh":1.0,"available":-9.0},"LFSB-S-LTGN":{"soh":7.0,"available":7.0},"LFSB-AMST-LTGN":{"soh":204.0,"available":192.0},"LFSB-Q-CV-LTGN":{"soh":3.0,"available":3.0},"LFSB-D-CV-LTGN":{"soh":1.0,"available":1.0},"LFSB-TW-CV-LTGN":{"soh":3.0,"available":3.0},"LFSB-S-WHT":{"soh":8.0,"available":8.0},"LFSB-AMST-WHT":{"soh":44.0,"available":36.0},"LFSB-Q-CV-WHT":{"soh":1.0,"available":1.0},"LFSB-D-CV-WHT":{"soh":1.0,"available":1.0},"LFSB-TW-CV-WHT":{"soh":1.0,"available":1.0},"ACHE-FLAMP-ECO-1":{"soh":1.0,"available":0.0},"ALLY-TV225-WHT-ECO-2":{"soh":2.0,"available":1.0},"AMLA-DESK-ECO-1":{"soh":3.0,"available":3.0},"AMLA-DESK-ECO-2":{"soh":1.0,"available":1.0},"ARH-5DC80-WHT-ECO-1":{"soh":2.0,"available":2.0},"ARH-5DC80-WHT-ECO-2":{"soh":2.0,"available":2.0},"ARH-SB160-WHT-ECO-1":{"soh":1.0,"available":1.0},"ARH-SB160-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARH-TV220-WHT-ECO-1":{"soh":2.0,"available":2.0},"ARH-TV220-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARLO-6COD-WHT-ECO-1":{"soh":20.0,"available":20.0},"ARLO-6COD-WHT-ECO-2":{"soh":20.0,"available":20.0},"ARLO-6COD-WHT-ECO-3":{"soh":19.0,"available":19.0},"ARLO-CST-WHT-ECO-1":{"soh":3.0,"available":3.0},"ARLO-CST-WHT-ECO-2":{"soh":3.0,"available":3.0},"ARLO-SB-WHT-ECO-1":{"soh":1.0,"available":1.0},"ARLO-SB-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARLO-SB-WHT-ECO-3":{"soh":1.0,"available":1.0},"ARLO-TV-WHT-ECO-1":{"soh":1.0,"available":1.0},"ARLO-TV-WHT-ECO-2":{"soh":1.0,"available":1.0},"ARLO-TV160-WHT-ECO-1":{"soh":2.0,"available":1.0},"ARLO-TV160-WHT-ECO-2":{"soh":2.0,"available":1.0},"BLC-6COD-OAK-ECO-1":{"soh":11.0,"available":7.0},"BLC-6COD-OAK-ECO-2":{"soh":11.0,"available":7.0},"BLC-6COD-OAK-ECO-3":{"soh":12.0,"available":8.0},"BLC-6COD-WNT-ECO-1":{"soh":1.0,"available":0.0},"BLC-6COD-WNT-ECO-2":{"soh":2.0,"available":1.0},"BLC-6COD-WNT-ECO-3":{"soh":4.0,"available":3.0},"BLC-BBK-OAK-ECO-1":{"soh":2.0,"available":1.0},"BLC-BBK-OAK-ECO-2":{"soh":2.0,"available":1.0},"BLC-BBK-OAK-ECO-3":{"soh":1.0,"available":0.0},"BLC-BBQ-OAK-ECO-1":{"soh":1.0,"available":1.0},"BLC-BBQ-OAK-ECO-2":{"soh":1.0,"available":1.0},"BLC-BBQ-OAK-ECO-3":{"soh":1.0,"available":1.0},"BLC-TV200-OAK-ECO-1":{"soh":31.0,"available":31.0},"BLC-TV200-OAK-ECO-2":{"soh":30.0,"available":30.0},"BLC-V2-BBK-OAK-ECO-1":{"soh":1.0,"available":1.0},"BLC-V2-BBQ-OAK-ECO-2":{"soh":1.0,"available":-8.0},"CAM-DSK150-WG-ECO-2":{"soh":2.0,"available":0.0},"CLB-D170-WNT-ECO-2":{"soh":1.0,"available":1.0},"CLEO-SB-OAK-ECO-1":{"soh":1.0,"available":1.0},"CLEO-SB-OAK-ECO-2":{"soh":1.0,"available":1.0},"CLUD-CT-WHT-ECO-2":{"soh":1.0,"available":1.0},"CLV2-WB147-D-ECO-1":{"soh":1.0,"available":0.0},"CLV2-WB147-D-WNT-ECO-1":{"soh":1.0,"available":-1.0},"CLV2-WB163-Q-ECO-1":{"soh":2.0,"available":-8.0},"CLV2-WB163-Q-ECO-2":{"soh":2.0,"available":-8.0},"CLV2-WB193-K-ECO-1":{"soh":2.0,"available":2.0},"CLV2-WB193-K-ECO-2":{"soh":1.0,"available":1.0},"CLV2-WB193-K-WNT-ECO-1":{"soh":3.0,"available":2.0},"CLV2-WB193-K-WNT-ECO-2":{"soh":1.0,"available":0.0},"CRSN-SB-NATR-ECO-1":{"soh":1.0,"available":1.0},"CRSN-SB-NATR-ECO-2":{"soh":1.0,"available":1.0},"DRIS-SB160-WNT-ECO-1":{"soh":2.0,"available":2.0},"DRIS-SB160-WNT-ECO-2":{"soh":1.0,"available":1.0},"ELLA-BF-K-ECO-1":{"soh":2.0,"available":2.0},"ELLA-BF-K-ECO-2":{"soh":1.0,"available":1.0},"ELLA-BF-K-ECO-3":{"soh":2.0,"available":2.0},"ELLA-BF-K-ECO-4":{"soh":1.0,"available":1.0},"ELLA-BF-Q-ECO-1":{"soh":3.0,"available":3.0},"ELLA-BF-Q-ECO-2":{"soh":4.0,"available":4.0},"ELLA-BF-Q-ECO-3":{"soh":4.0,"available":4.0},"ELLA-BF-Q-ECO-4":{"soh":4.0,"available":4.0},"ELNA-TV180-OAK-ECO-1":{"soh":1.0,"available":1.0},"EVE-BF-K-ECO-1":{"soh":4.0,"available":4.0},"EVE-BF-K-ECO-2":{"soh":4.0,"available":4.0},"EVE-BF-K-ECO-3":{"soh":2.0,"available":2.0},"EVE-BF-K-ECO-4":{"soh":2.0,"available":2.0},"EVE-BF-Q-ECO-1":{"soh":9.0,"available":8.0},"EVE-BF-Q-ECO-2":{"soh":9.0,"available":8.0},"EVE-BF-Q-ECO-3":{"soh":9.0,"available":8.0},"EVE-BF-Q-ECO-4":{"soh":9.0,"available":8.0},"FELX-BB-K-ECO-1":{"soh":2.0,"available":2.0},"FELX-BB-K-ECO-2":{"soh":2.0,"available":2.0},"FELX-BB-Q-ECO-1":{"soh":2.0,"available":2.0},"FELX-BB-Q-ECO-2":{"soh":1.0,"available":1.0},"HDSN-DSK-OAK-ECO-1":{"soh":1.0,"available":-5.0},"HDSN-DSK-OAK-ECO-2":{"soh":1.0,"available":-5.0},"HDSN-DT180-OAK-ECO-2":{"soh":7.0,"available":6.0},"IRNE-SB180-OAK-ECO-1":{"soh":3.0,"available":0.0},"JADN-FLAMP-ECO-1":{"soh":1.0,"available":1.0},"KTZ-DT-WHT-ECO-2":{"soh":2.0,"available":1.0},"MVS-DS-OAK-ECO-2":{"soh":2.0,"available":2.0},"MVS-DS-OAK-ECO-3":{"soh":2.0,"available":2.0},"ODEN-3COD-OAK-ECO-1":{"soh":1.0,"available":1.0},"ODEN-D120-OAK-ECO-1":{"soh":1.0,"available":-3.0},"ODEN-D120-OAK-ECO-2":{"soh":2.0,"available":-2.0},"ODEN-TV180-OAK-ECO-1":{"soh":3.0,"available":-4.0},"ODEN-TV180-OAK-ECO-2":{"soh":3.0,"available":-4.0},"OWEN-FLAMP-ECO-1":{"soh":1.0,"available":1.0},"OWEN-FLAMP-ECO-2":{"soh":1.0,"available":1.0},"PBLE-D140-WHT-ECO-1":{"soh":1.0,"available":1.0},"PBLE-D140-WHT-ECO-2":{"soh":1.0,"available":1.0},"SRT-DS100-WHT-ECO-1":{"soh":2.0,"available":1.0},"SRT-DS100-WHT-ECO-2":{"soh":1.0,"available":0.0},"SRT-DT-WHT-ECO-1":{"soh":2.0,"available":2.0},"SRT-DT-WHT-ECO-2":{"soh":1.0,"available":1.0},"TATE-CD160-OAK-ECO-2":{"soh":1.0,"available":0.0},"TATE-CT120-OAK-ECO-1":{"soh":1.0,"available":1.0},"TATE-CT120-OAK-ECO-2":{"soh":2.0,"available":2.0},"TATE-ED120-OAK-WHT-ECO-1":{"soh":1.0,"available":1.0},"TATE-ED120-OAK-WHT-ECO-2":{"soh":1.0,"available":1.0},"TATE-EDT-NAL-ECO-1":{"soh":4.0,"available":-35.0},"TATE-EDT-NAL-ECO-2":{"soh":2.0,"available":-37.0},"TATE-RDT-NATURAL-ECO-1":{"soh":4.0,"available":3.0},"TATE-RDT-NATURAL-ECO-2":{"soh":2.0,"available":1.0},"TATE-RODT-BLACK-ECO-1":{"soh":3.0,"available":3.0},"TATE-RODT-BLACK-ECO-2":{"soh":1.0,"available":1.0},"TATE-RODT-BLACK-ECO-3":{"soh":3.0,"available":3.0},"TATE-RODT-NATURAL-ECO-1":{"soh":2.0,"available":2.0},"TATE-RODT-NATURAL-ECO-2":{"soh":2.0,"available":2.0},"TATE-RODT220-BLACK-ECO-1":{"soh":3.0,"available":2.0},"TATE-RODT220-BLACK-ECO-2":{"soh":1.0,"available":0.0},"TATE-RODT220-BLACK-ECO-3":{"soh":3.0,"available":2.0},"TATE-RODT220-NATURAL-ECO-1":{"soh":4.0,"available":4.0},"TATE-RODT220-NATURAL-ECO-3":{"soh":4.0,"available":4.0},"TATE-SB160-NATURAL-ECO-2":{"soh":1.0,"available":1.0},"TATE-SB160-WNT-ECO-2":{"soh":1.0,"available":1.0},"TATE-TV-NATURAL-ECO-1":{"soh":1.0,"available":1.0},"TATE-TV200-BLACK-ECO-1":{"soh":12.0,"available":11.0},"TATE-TV200-BLACK-ECO-2":{"soh":10.0,"available":9.0},"TATE-TV200-NATURAL-ECO-1":{"soh":2.0,"available":1.0},"TATE-TV200-NATURAL-ECO-2":{"soh":4.0,"available":3.0},"TNTY-CST-OAK-ECO-1":{"soh":2.0,"available":2.0},"TNTY-CST-OAK-ECO-2":{"soh":1.0,"available":1.0},"WILY-ED160-BLK-ECO-1":{"soh":9.0,"available":9.0},"WILY-ED160-BLK-ECO-3":{"soh":5.0,"available":5.0},"ODEN-BEDROOM-SET-2":{"soh":1.0,"available":1.0},"ODEN-BEDROOM-SET-1":{"soh":1.0,"available":1.0},"LIFELY-SOFA-4S-RIGHT-OG":{"soh":1.0,"available":1.0},"ODEN-TV180-OAK-1":{"soh":5.0,"available":5.0},"ODEN-TV180-OAK-2":{"soh":5.0,"available":5.0},"AFI-BF-K-ECO-1":{"soh":1.0,"available":1.0},"AFI-BF-K-ECO-2":{"soh":2.0,"available":2.0},"AFI-BF-K-WHT-ECO":{"soh":1.0,"available":1.0},"ALXS-CHR-WHT-ECO":{"soh":3.0,"available":1.0},"AMBR-DC-GRN-ECO":{"soh":2.0,"available":2.0},"AMBR-DC-WHT-ECO":{"soh":6.0,"available":0.0},"ARLO-BT-WHT-ECO":{"soh":1.0,"available":1.0},"BLC-BT-OAK-ECO":{"soh":4.0,"available":-1.0},"BLC-BT-WNT-ECO":{"soh":1.0,"available":1.0},"CARY-OTM-GY-ECO":{"soh":5.0,"available":5.0},"CARY-SOFA-CORNER-GY-ECO":{"soh":7.0,"available":7.0},"CARY-SOFA-RIGHT-GY-ECO":{"soh":3.0,"available":1.0},"CL-WB102-S-ECO":{"soh":10.0,"available":10.0},"CL-WB147-D-ECO":{"soh":1.0,"available":1.0},"CL-WB147-D-WNT-ECO":{"soh":1.0,"available":1.0},"CL-WB163-Q-ECO":{"soh":7.0,"available":6.0},"CL-WB193-K-WNT-ECO":{"soh":1.0,"available":1.0},"CPA-V3-BT603-WOK-ECO":{"soh":1.0,"available":-1.0},"FRK-AC-GRN-ECO":{"soh":1.0,"available":-1.0},"HANK-BT-WNT-ECO":{"soh":26.0,"available":18.0},"HAZ-CT-WNT-ECO":{"soh":8.0,"available":6.0},"IRNE-BT-OAK-ECO":{"soh":2.0,"available":-5.0},"KTZ-ST-WHT-ECO":{"soh":1.0,"available":1.0},"LOLA-BSF-NAL-ECO":{"soh":129.0,"available":129.0},"LORA-AC-ORG-ECO":{"soh":1.0,"available":1.0},"LYLA-BF-Q-ECO":{"soh":1.0,"available":1.0},"NOAH-DB140-WHT-ECO":{"soh":4.0,"available":1.0},"NOAH-DB160-WHT-ECO":{"soh":1.0,"available":0.0},"ODEN-BT-OAK-ECO":{"soh":1.0,"available":-1.0},"TATE-CT-NATURAL-ECO":{"soh":2.0,"available":2.0},"TATE-RODT-BLACK-ECO":{"soh":1.0,"available":1.0},"TATE-SB-BLACK-ECO":{"soh":1.0,"available":1.0},"TATE-SB-NATURAL-ECO":{"soh":1.0,"available":1.0},"TATE-SB160-NATURAL-ECO":{"soh":3.0,"available":3.0},"TIM-OC-BRN-ECO":{"soh":1.0,"available":1.0},"WILY-ED160-WNT-ECO":{"soh":4.0,"available":4.0},"EVE-BF-K-NAL-ECO":{"soh":3.0,"available":3.0},"NOAH-DC-WNT-ECO":{"soh":4.0,"available":1.0},"MORI-RUG-200-ECO":{"soh":1.0,"available":1.0},"MORI-RUG-160-ECO":{"soh":1.0,"available":1.0},"JOSE-BF-K-ECO-1":{"soh":1.0,"available":1.0},"MLW-RUG-160-MG":{"soh":1.0,"available":1.0},"MLW-RUG-200-MG":{"soh":4.0,"available":4.0},"IRNE-TV180-OAK":{"soh":1.0,"available":1.0},"DIRI-DS-CRM-1":{"soh":1.0,"available":1.0},"DIRI-DS-CRM-2":{"soh":2.0,"available":2.0},"DIRI-DS-CRM-3":{"soh":1.0,"available":1.0},"LIFELY-FS-LB":{"soh":498.0,"available":496.0},"LIFELY-FS-OG":{"soh":498.0,"available":496.0},"LIFELY-FS-RST":{"soh":498.0,"available":498.0},"LIFELY-FS-WHT":{"soh":498.0,"available":498.0},"LIFELY-OTM-LB-1":{"soh":2.0,"available":2.0},"LIFELY-OTM-LB-2":{"soh":1.0,"available":1.0},"LIFELY-OTM-RST-1":{"soh":2.0,"available":2.0},"LIFELY-OTM-WHT":{"soh":1.0,"available":1.0},"LIFELY-OTM-WHT-1":{"soh":5.0,"available":5.0},"LIFELY-SOFA-AMCR-LB-1":{"soh":2.0,"available":1.0},"LIFELY-SOFA-AMCR-LB-2":{"soh":3.0,"available":2.0},"LIFELY-SOFA-AMCR-OG-1":{"soh":3.0,"available":3.0},"LIFELY-SOFA-AMCR-RST-1":{"soh":3.0,"available":3.0},"LIFELY-SOFA-AMCR-RST-2":{"soh":4.0,"available":4.0},"LIFELY-SOFA-AMCR-WHT-1":{"soh":10.0,"available":9.0},"LIFELY-SOFA-AMCR-WHT-2":{"soh":7.0,"available":6.0},"LIFELY-SOFA-AMLS-LB-1":{"soh":1.0,"available":1.0},"LIFELY-SOFA-AMLS-RST-1":{"soh":1.0,"available":1.0},"LIFELY-SOFA-AMLS-WHT-1":{"soh":3.0,"available":3.0},"LIFELY-SOFA-CRNR-LB-1":{"soh":5.0,"available":5.0},"LIFELY-SOFA-CRNR-LB-2":{"soh":2.0,"available":2.0},"LIFELY-SOFA-CRNR-RST-1":{"soh":2.0,"available":2.0},"LIFELY-OTM-OG-2":{"soh":2.0,"available":1.0},"LIFELY-OTM-OG-1":{"soh":7.0,"available":6.0},"LIFELY-SOFA-AMLS-OG-2":{"soh":1.0,"available":1.0},"LIFELY-SOFA-AMLS-OG-1":{"soh":2.0,"available":2.0},"LIFELY-SOFA-CRNR-OG-2":{"soh":1.0,"available":1.0},"LIFELY-SOFA-CRNR-OG-1":{"soh":2.0,"available":2.0},"CARY-SOFA-RIGHT-GY":{"soh":2.0,"available":2.0},"CARY-SOFA-LEFT-GY":{"soh":2.0,"available":2.0},"CARY-SOFA-GY":{"soh":2.0,"available":2.0},"CARY-SOFA-CORNER-GY":{"soh":2.0,"available":2.0},"CARY-OTM-GY":{"soh":2.0,"available":2.0},"MLW-RUG-240":{"soh":3.0,"available":0.0},"MLW-RUG-160-SF":{"soh":2.0,"available":2.0},"MLW-RUG-200-SF":{"soh":1.0,"available":1.0},"BEN-RUG-240":{"soh":1.0,"available":1.0},"LYLA-BF-K-1":{"soh":2.0,"available":2.0},"LYLA-BF-K-2":{"soh":2.0,"available":2.0},"LYLA-BF-Q-2":{"soh":1.0,"available":1.0},"JOSE-V2-BF-K-1":{"soh":1.0,"available":1.0},"JOSE-V2-BF-K-2":{"soh":2.0,"available":2.0},"KAEL-SOFA-3S-BG-1":{"soh":7.0,"available":7.0},"KAEL-SOFA-3S-BG-2":{"soh":7.0,"available":7.0},"WILY-ED160-BLK-1":{"soh":7.0,"available":7.0},"WILY-ED160-BLK-2":{"soh":2.0,"available":2.0},"WILY-ED160-BLK-3":{"soh":2.0,"available":2.0},"MVS-DS-OAK-2":{"soh":2.0,"available":2.0},"MVS-DS-OAK-3":{"soh":2.0,"available":2.0},"TATE-EDT-NAL-1":{"soh":2.0,"available":2.0},"TATE-EDT-NAL-2":{"soh":5.0,"available":5.0},"TATE-EDT-NAL-3":{"soh":2.0,"available":2.0},"BLC-CT-BLK-1":{"soh":1.0,"available":1.0},"BLC-CT-BLK-2":{"soh":4.0,"available":4.0},"ELLA-BF-K-4":{"soh":7.0,"available":7.0},"ELLA-BF-Q-3":{"soh":1.0,"available":1.0},"ELLA-BF-Q-4":{"soh":1.0,"available":1.0},"CLB-D170-WNT-1":{"soh":3.0,"available":3.0},"CLB-D170-WNT-2":{"soh":4.0,"available":4.0},"CLUD-CT-RST-1":{"soh":1.0,"available":1.0},"ALLY-4CODBT-WHT":{"soh":1.0,"available":1.0},"BLC-V2SET-Q-OAK":{"soh":2.0,"available":2.0},"MS153-M-S":{"soh":1.0,"available":1.0},"FRK-AC-TD":{"soh":1.0,"available":1.0},"AMBR-DC-GRN":{"soh":2.0,"available":2.0},"HANK-BT-ASH":{"soh":3.0,"available":3.0},"ILIA-BT-WHT":{"soh":1.0,"available":1.0},"JAX-DS-ABR":{"soh":2.0,"available":2.0},"CAM-DSK150-WG":{"soh":2.0,"available":2.0},"IRNE-SB180-OAK-1":{"soh":1.0,"available":1.0},"ELNA-BF-Q-2":{"soh":7.0,"available":7.0},"ELNA-BF-Q-3":{"soh":1.0,"available":1.0},"ELNA-BF-K":{"soh":5.0,"available":5.0},"ELNA-BF-K-1":{"soh":1.0,"available":1.0},"ELNA-BF-K-2":{"soh":2.0,"available":2.0},"ELNA-BF-K-3":{"soh":3.0,"available":3.0},"ELNA-BF-K-4":{"soh":2.0,"available":2.0},"OSSI-DT120-OAK-1":{"soh":2.0,"available":2.0},"OSSI-DT120-OAK-2":{"soh":1.0,"available":1.0},"TATE-EDT-BLK-1":{"soh":12.0,"available":11.0},"TATE-EDT-BLK-2":{"soh":12.0,"available":11.0},"PARTS-GENERIC":{"soh":9.0,"available":9.0},"EMMA-DT180-OAK-3":{"soh":4.0,"available":4.0},"RAI-DT100-OAK-2":{"soh":1.0,"available":1.0},"RAI-DT100-OAK-1":{"soh":1.0,"available":1.0},"OWEN-FLAMP-2":{"soh":1.0,"available":1.0},"MAY-TV200-OAK-2":{"soh":1.0,"available":1.0}};

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
    
    // Use live data if available, fall back to embedded data
    if (Object.keys(cin7Products).length > 0) {
      dataCache.cin7Products = cin7Products;
    } else {
      dataCache.cin7Products = {...CIN7_FALLBACK};
      console.log('CIN7 empty — using embedded fallback (' + Object.keys(CIN7_FALLBACK).length + ' SKUs)');
    }

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
