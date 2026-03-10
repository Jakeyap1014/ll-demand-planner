const express = require('express');
const https = require('https');
const crypto = require('crypto');
const cron = require('node-cron');
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
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || '';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'lifelystore.myshopify.com';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

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
  cin7: {},
  shopify: {},
  velocity: {},
  pos: [],
  error: null
};

// ===== CIN7 API =====
function apiRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchCin7Stock() {
  if (!CIN7_USER || !CIN7_KEY) return null;
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const results = {};
  let page = 1;
  while (page <= 5) {
    const data = await apiRequest({
      hostname: 'api.cin7.com', path: `/api/v1/Products?page=${page}&rows=250`,
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    for (const product of data) {
      if (product.styleCode && product.styleCode.startsWith('LLAU')) {
        const variants = product.productOptions || [];
        for (const v of variants) {
          if (v.code && v.code.startsWith('LLAU')) {
            results[v.code] = {
              soh: v.stockOnHand || 0,
              available: v.stockAvailable || 0,
              allocated: v.stockAllocated || 0
            };
          }
        }
        if (product.code && product.code.startsWith('LLAU')) {
          results[product.code] = {
            soh: product.stockOnHand || 0,
            available: product.stockAvailable || 0
          };
        }
      }
    }
    page++;
    await new Promise(r => setTimeout(r, 400));
  }
  return results;
}

async function fetchShopifyInventory() {
  if (!SHOPIFY_TOKEN) return null;
  const productId = '7653232410666';
  const data = await apiRequest({
    hostname: SHOPIFY_STORE,
    path: `/admin/api/2026-01/products/${productId}/variants.json?limit=250`,
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' }
  });
  const results = {};
  if (data && data.variants) {
    for (const v of data.variants) {
      if (v.sku) results[v.sku] = v.inventory_quantity || 0;
    }
  }
  return results;
}

async function fetchShopifyVelocity() {
  if (!SHOPIFY_TOKEN) return null;
  const now = new Date();
  const start = new Date(now.getTime() - 90 * 86400000);
  const results = {};
  let url = `/admin/api/2026-01/orders.json?status=any&financial_status=paid&created_at_min=${start.toISOString()}&limit=250`;
  let pages = 0;
  
  while (url && pages < 100) {
    const data = await apiRequest({
      hostname: SHOPIFY_STORE, path: url,
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    if (data && data.orders) {
      for (const order of data.orders) {
        for (const item of (order.line_items || [])) {
          if (item.sku && item.sku.startsWith('LLAU')) {
            results[item.sku] = (results[item.sku] || 0) + item.quantity;
          }
        }
      }
    }
    url = null; // Simplified - would need Link header parsing for pagination
    pages++;
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Convert to weekly
  const weeks = 12;
  const weekly = {};
  for (const [sku, total] of Object.entries(results)) {
    weekly[sku] = Math.round(total / weeks * 10) / 10;
  }
  return weekly;
}

async function refreshData() {
  console.log(`[${new Date().toISOString()}] Refreshing data...`);
  try {
    const [cin7, shopify, velocity] = await Promise.all([
      fetchCin7Stock().catch(e => { console.error('CIN7 error:', e.message); return null; }),
      fetchShopifyInventory().catch(e => { console.error('Shopify error:', e.message); return null; }),
      fetchShopifyVelocity().catch(e => { console.error('Velocity error:', e.message); return null; })
    ]);
    
    if (cin7) dataCache.cin7 = cin7;
    if (shopify) dataCache.shopify = shopify;
    if (velocity) dataCache.velocity = velocity;
    dataCache.lastRefresh = new Date().toISOString();
    dataCache.error = null;
    console.log(`[${new Date().toISOString()}] Refresh complete. ${Object.keys(dataCache.cin7).length} CIN7 SKUs, ${Object.keys(dataCache.shopify).length} Shopify SKUs`);
  } catch(e) {
    console.error('Refresh error:', e);
    dataCache.error = e.message;
  }
}

// ===== CRON: Refresh every hour =====
cron.schedule('0 * * * *', refreshData);

// ===== DISCORD CHAT =====
async function sendToDiscord(username, message) {
  if (!DISCORD_WEBHOOK) return { ok: false, error: 'No webhook configured' };
  const payload = JSON.stringify({
    content: `**[Demand Planner]** ${username}: ${message}`,
    username: `${username} (via Demand Planner)`
  });
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode < 300 }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}


// ===== AI CHAT AGENT =====
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

function buildDataContext() {
  const cin7 = dataCache.cin7;
  const shopify = dataCache.shopify;
  const velocity = dataCache.velocity;
  const pos = dataCache.pos;
  
  const names = {"LLAU-CB-S-MSM":"Bed S Marshmallow","LLAU-CB-S-CTCN":"Bed S Cotton Candy","LLAU-CB-S-DGY":"Bed S Dove Grey","LLAU-CB-S-DSBL":"Bed S Dusty Blue","LLAU-CB-S-PST":"Bed S Pistachio","LLAU-CB-S-BABL":"Bed S Baby Blue","LLAU-CB-KS-CTCN":"Bed KS Cotton Candy","LLAU-CB-KS-DGY":"Bed KS Dove Grey","LLAU-CB-KS-PST":"Bed KS Pistachio","LLAU-CB-KS-MSM":"Bed KS Marshmallow","LLAU-CB-KS-BABL":"Bed KS Baby Blue","LLAU-CB-KS-DSBL":"Bed KS Dusty Blue","LLAU-CB-D-DSBL":"Bed D Dusty Blue","LLAU-CB-D-CTCN":"Bed D Cotton Candy","LLAU-CB-D-PST":"Bed D Pistachio","LLAU-CB-D-DGY":"Bed D Dove Grey","LLAU-CB-D-MSM":"Bed D Marshmallow","LLAU-CB-D-BABL":"Bed D Baby Blue"};
  
  // Compact format: only bed SKUs with pre-computed metrics
  let lines = ['LITTLE LIFELY AU STOCK (live):', ''];
  lines.push('Product | SOH | Shopify | Net | Vel/wk | Wks Left');
  
  for (const [sku, name] of Object.entries(names)) {
    const soh = cin7[sku] ? (typeof cin7[sku] === 'object' ? cin7[sku].soh : cin7[sku]) : 0;
    const shop = shopify[sku] || 0;
    const comboSku = sku.replace('LLAU-CB-','LLAU-CBCF-');
    const comboShop = shopify[comboSku] || 0;
    const net = soh + Math.min(shop, 0) + Math.min(comboShop, 0);
    const vel = (velocity[sku] || 0) + (velocity[comboSku] || 0);
    const wks = vel > 0 ? Math.round(net / vel) : 99;
    let inc = 0;
    for (const po of (pos || [])) { inc += (po.items?.[sku] || 0); }
    lines.push(\`\${name} | \${soh} | \${shop}/\${comboShop} | \${net} | \${vel.toFixed(1)} | \${wks}wk (inc:\${inc})\`);
  }
  
  lines.push('');
  lines.push('POs: ' + (pos||[]).map(po => \`\${po.name} (\${po.status}) arr \${po.arrival}, \${Object.values(po.items||{}).reduce((a,b)=>a+b,0)} units\`).join(' | '));
  lines.push('');
  lines.push('Notes: Bed+Combo consume same physical stock. Lead time 8wk. Safety 4wk. Sizes: S=Single, KS=King Single, D=Double.');
  
  return lines.join('\n');
}

async function askAgent(question, chatHistory) {
  const dataContext = buildDataContext();
  
  const systemPrompt = `You are Caesar 🐒, the AI demand planning agent for Little Lifely (a children's bed brand by Lifely, an Australian DTC company).

You have access to LIVE inventory data from CIN7 (warehouse) and Shopify (storefront). Answer questions about:
- Stock levels, stockout risk, weeks of stock remaining
- Sales velocity and trending products
- Purchase order status and incoming stock
- Reorder recommendations (when to order, how much)
- Demand forecasting and scenarios

Be concise, specific, and data-driven. Use actual numbers from the data. Format key numbers in bold.
When calculating weeks of stock: Net SOH = CIN7 SOH + min(Shopify qty, 0). Weeks = Net SOH / combined weekly velocity.
When a SKU has negative Shopify qty, that means pre-orders that eat into the CIN7 stock.

This is a chat widget — keep answers concise but complete (max 250 words).
Formatting rules:
- Use bullet points with • character
- DO NOT use markdown formatting like ** or ### or tables
- Write numbers plainly, no bold markers
- Keep total response under 200 words
- When listing SKUs, show top 5 most critical
- Always include the actual data (SOH, velocity, weeks left)
- End with a clear action or recommendation
- Use line breaks between items
If you don't have enough data to answer, say so honestly.

${dataContext}`;

  const messages = [
    { role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\nUser question: ' + question }] }
  ];
  
  // Add chat history context
  if (chatHistory && chatHistory.length > 0) {
    const historyText = chatHistory.slice(-6).map(m => `${m.role}: ${m.text}`).join('\n');
    messages[0].parts[0].text += '\n\nRecent chat history:\n' + historyText;
  }

  const payload = JSON.stringify({
    contents: messages,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1500
    }
  });

  return new Promise((resolve, reject) => {
    const url = `/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_KEY}`;
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const parts = json.candidates?.[0]?.content?.parts || [];
          const text = parts.map(p => p.text || '').join('') || 'Sorry, I couldn\'t process that. Try rephrasing?';
          const finish = json.candidates?.[0]?.finishReason;
          console.log('[Gemini] Response length:', text.length, 'chars, finishReason:', finish);
          if (finish !== 'STOP') console.log('[Gemini] WARNING: Response may be truncated. finishReason:', finish);
          resolve(text);
        } catch(e) {
          console.error('Gemini parse error:', data.substring(0, 200));
          reject(new Error('Failed to parse AI response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('AI request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ===== ROUTES =====
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    const sid = createSession();
    res.json({ ok: true, session: sid });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

app.get('/api/data', requireAuth, (req, res) => {
  res.json(dataCache);
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  await refreshData();
  res.json({ ok: true, lastRefresh: dataCache.lastRefresh });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { username, message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  try {
    if (GEMINI_KEY) {
      const reply = await askAgent(message, history);
      // Also relay to Discord if webhook is set
      if (DISCORD_WEBHOOK) {
        sendToDiscord(username || 'Team', message).catch(() => {});
      }
      res.json({ ok: true, reply });
    } else {
      // Fallback to Discord-only
      const result = await sendToDiscord(username || 'Team', message);
      res.json({ ok: true, reply: 'Message sent to Caesar in #little-lifely. I\'ll respond there shortly! 🐒' });
    }
  } catch(e) {
    console.error('Chat error:', e);
    res.json({ ok: true, reply: 'Sorry, I hit an error processing that. Try again or ask in #little-lifely directly. 🐒' });
  }
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    lastRefresh: dataCache.lastRefresh,
    cin7Skus: Object.keys(dataCache.cin7).length,
    shopifySkus: Object.keys(dataCache.shopify).length,
    velocitySkus: Object.keys(dataCache.velocity).length,
    error: dataCache.error
  });
});

// Static files (after auth check for main app)
app.use('/login', express.static(path.join(__dirname, 'public')));
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// ===== START =====
app.listen(PORT, () => {
  console.log(`Demand Planner running on port ${PORT}`);
  // Initial data load with fallback data
  loadFallbackData();
  refreshData();
});

function loadFallbackData() {
  // Embedded fallback from our last pull (10 Mar 2026)
  dataCache.cin7 = {"LLAU-CB-S-MSM":{soh:264},"LLAU-CB-S-CTCN":{soh:188},"LLAU-CB-S-DGY":{soh:121},"LLAU-CB-S-DSBL":{soh:24},"LLAU-CB-S-PST":{soh:20},"LLAU-CB-S-BABL":{soh:11},"LLAU-CB-KS-CTCN":{soh:154},"LLAU-CB-KS-DGY":{soh:69},"LLAU-CB-KS-PST":{soh:87},"LLAU-CB-KS-MSM":{soh:113},"LLAU-CB-KS-BABL":{soh:47},"LLAU-CB-KS-DSBL":{soh:0},"LLAU-CB-D-DSBL":{soh:110},"LLAU-CB-D-CTCN":{soh:254},"LLAU-CB-D-PST":{soh:186},"LLAU-CB-D-DGY":{soh:65},"LLAU-CB-D-MSM":{soh:100},"LLAU-CB-D-BABL":{soh:68}};
  dataCache.shopify = {"LLAU-CB-S-CTCN":54,"LLAU-CB-S-MSM":14,"LLAU-CB-S-DGY":6,"LLAU-CB-S-PST":-126,"LLAU-CB-S-BABL":-126,"LLAU-CB-S-DSBL":3,"LLAU-CBCF-S-CTCN":-22,"LLAU-CBCF-S-MSM":-54,"LLAU-CBCF-S-DGY":-25,"LLAU-CBCF-S-PST":-14,"LLAU-CBCF-S-BABL":-23,"LLAU-CBCF-S-DSBL":-1,"LLAU-CB-KS-CTCN":86,"LLAU-CB-KS-MSM":-13,"LLAU-CB-KS-DGY":38,"LLAU-CB-KS-PST":35,"LLAU-CB-KS-BABL":-43,"LLAU-CB-KS-DSBL":-63,"LLAU-CBCF-KS-CTCN":-8,"LLAU-CBCF-KS-MSM":-13,"LLAU-CBCF-KS-DGY":-9,"LLAU-CBCF-KS-PST":-10,"LLAU-CBCF-KS-BABL":-10,"LLAU-CBCF-KS-DSBL":-1,"LLAU-CB-D-CTCN":-1,"LLAU-CB-D-MSM":-44,"LLAU-CB-D-DGY":-37,"LLAU-CB-D-PST":-39,"LLAU-CB-D-BABL":-133,"LLAU-CB-D-DSBL":98,"LLAU-CBCF-D-CTCN":-50,"LLAU-CBCF-D-MSM":-101,"LLAU-CBCF-D-DGY":-42,"LLAU-CBCF-D-PST":-44,"LLAU-CBCF-D-BABL":-72,"LLAU-CBCF-D-DSBL":-2};
  dataCache.velocity = {"LLAU-CB-S-MSM":8.3,"LLAU-CB-S-CTCN":3.2,"LLAU-CB-S-DGY":2.8,"LLAU-CB-S-DSBL":1.2,"LLAU-CB-S-PST":5.0,"LLAU-CB-S-BABL":4.1,"LLAU-CB-KS-CTCN":2.6,"LLAU-CB-KS-DGY":1.5,"LLAU-CB-KS-PST":3.7,"LLAU-CB-KS-MSM":4.9,"LLAU-CB-KS-BABL":2.5,"LLAU-CB-KS-DSBL":1.2,"LLAU-CB-D-DSBL":2.5,"LLAU-CB-D-CTCN":4.9,"LLAU-CB-D-PST":8.0,"LLAU-CB-D-DGY":3.6,"LLAU-CB-D-MSM":13.9,"LLAU-CB-D-BABL":6.8,"LLAU-CBCF-S-MSM":8.5,"LLAU-CBCF-S-CTCN":5.5,"LLAU-CBCF-S-DGY":4.4,"LLAU-CBCF-S-DSBL":1.5,"LLAU-CBCF-S-PST":3.6,"LLAU-CBCF-S-BABL":4.9,"LLAU-CBCF-KS-CTCN":5.8,"LLAU-CBCF-KS-DGY":4.7,"LLAU-CBCF-KS-PST":5.8,"LLAU-CBCF-KS-MSM":9.8,"LLAU-CBCF-KS-BABL":6.8,"LLAU-CBCF-KS-DSBL":3.7,"LLAU-CBCF-D-DSBL":6.0,"LLAU-CBCF-D-CTCN":9.2,"LLAU-CBCF-D-PST":11.4,"LLAU-CBCF-D-DGY":6.8,"LLAU-CBCF-D-MSM":20.4,"LLAU-CBCF-D-BABL":12.8};
  dataCache.pos = [
    {name:"PO-AU002-11/12",status:"Shipping",arrival:"2026-04-07",items:{"LLAU-CB-S-DSBL":53,"LLAU-CB-KS-DSBL":135,"LLAU-CB-D-DSBL":105,"LLAU-CB-D-DGY":3,"LLAU-CB-S-PST":3,"LLAU-CB-D-MSM":280,"LLAU-CB-KS-CTCN":2}},
    {name:"AU003",status:"Production",arrival:"2026-05-11",items:{"LLAU-CB-S-DSBL":30,"LLAU-CB-KS-DSBL":45,"LLAU-CB-D-DSBL":100,"LLAU-CB-S-DGY":45,"LLAU-CB-KS-DGY":25,"LLAU-CB-D-DGY":75,"LLAU-CB-S-PST":100,"LLAU-CB-KS-PST":50,"LLAU-CB-D-PST":155,"LLAU-CB-S-BABL":65,"LLAU-CB-KS-BABL":65,"LLAU-CB-D-BABL":140,"LLAU-CB-S-CTCN":90,"LLAU-CB-KS-CTCN":70,"LLAU-CB-D-CTCN":100,"LLAU-CB-S-MSM":140,"LLAU-CB-KS-MSM":100,"LLAU-CB-D-MSM":240}}
  ];
  dataCache.lastRefresh = 'Fallback data (10 Mar 2026)';
}
