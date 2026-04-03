/**
 * CIN7 Landed Cost Scraper
 * Logs into CIN7 web UI via Playwright and scrapes Freight + Customs
 * from each PO's Landed Costs section.
 * 
 * Usage: node scripts/cin7-landed-cost-scrape.js [--po PO-2153] [--all] [--limit 5]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(process.env.HOME, '.openclaw/credentials/cin7-web.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'landed-costs.json');

async function loadCredentials() {
  const raw = fs.readFileSync(CREDS_PATH, 'utf8');
  return JSON.parse(raw);
}

async function login(page, creds) {
  console.log('Navigating to CIN7 login...');
  await page.goto('https://go.cin7.com/Cloud/Login', { waitUntil: 'networkidle', timeout: 30000 });
  
  // CIN7 Omni login: placeholder-based inputs
  await page.fill('input[placeholder="Username"]', creds.email);
  await page.fill('input[placeholder="Password"]', creds.password);
  
  // Click the Log In button (dark navy with arrow) — try multiple selectors
  const loginBtn = page.locator('button').filter({ hasText: /log\s*in/i }).first();
  if (await loginBtn.count() === 0) {
    // Fallback: any button-like element
    await page.locator('[type="submit"], button >> nth=0').click();
  } else {
    await loginBtn.click();
  }
  
  // Wait for navigation away from login page
  await page.waitForTimeout(5000);
  
  const url = page.url();
  console.log('After login URL:', url);
  
  if (url.includes('Login') || url.includes('login')) {
    throw new Error('Login failed — still on login page');
  }
  console.log('✅ Logged in successfully');
}

async function scrapePOLandedCosts(page, poReference) {
  // Navigate to PO search/list
  const searchUrl = `https://go.cin7.com/Cloud/PurchaseOrders?search=${encodeURIComponent(poReference)}`;
  console.log(`Navigating to: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  // Click on the PO row to open it
  const poLink = page.locator(`text=${poReference}`).first();
  if (await poLink.count() === 0) {
    console.log(`  ⚠️ PO ${poReference} not found in search results`);
    return null;
  }
  await poLink.click();
  await page.waitForTimeout(3000);
  
  // Look for Landed Costs section
  const result = await page.evaluate(() => {
    const costs = { freight: [], customs: [], other: [] };
    
    // Try to find landed cost table/section
    const tables = document.querySelectorAll('table');
    const allText = document.body.innerText;
    
    // Look for "Landed Cost" or "Freight" or "Customs" sections
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const text = row.innerText.toLowerCase();
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const label = cells[0]?.innerText?.trim() || '';
        const value = cells[cells.length - 1]?.innerText?.trim() || '';
        if (text.includes('freight') || text.includes('shipping') || text.includes('ocean')) {
          costs.freight.push({ label, value });
        } else if (text.includes('customs') || text.includes('duty') || text.includes('tariff')) {
          costs.customs.push({ label, value });
        } else if (text.includes('landed') || text.includes('insurance') || text.includes('handling')) {
          costs.other.push({ label, value });
        }
      }
    }
    
    // Also grab any summary values
    const summaryEls = document.querySelectorAll('[class*="landed"], [class*="freight"], [class*="cost"], [data-bind*="landed"], [data-bind*="freight"]');
    const summaryTexts = Array.from(summaryEls).map(el => el.innerText.trim()).filter(Boolean);
    
    return { costs, summaryTexts, pageTitle: document.title, bodySnippet: allText.substring(0, 5000) };
  });
  
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const poFlag = args.indexOf('--po');
  const targetPO = poFlag >= 0 ? args[poFlag + 1] : null;
  const limit = args.indexOf('--limit') >= 0 ? parseInt(args[args.indexOf('--limit') + 1]) : 3;
  
  const creds = await loadCredentials();
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    await login(page, creds);
    
    // Test with a specific PO or a few sample POs
    const testPOs = targetPO ? [targetPO] : ['PO-2153', 'PO-2156', 'PO-LF0018'];
    
    for (const po of testPOs.slice(0, limit)) {
      console.log(`\n--- Scraping ${po} ---`);
      const result = await scrapePOLandedCosts(page, po);
      if (result) {
        console.log('Freight:', JSON.stringify(result.costs.freight));
        console.log('Customs:', JSON.stringify(result.costs.customs));
        console.log('Other:', JSON.stringify(result.costs.other));
        console.log('Summary:', result.summaryTexts);
        // Log a snippet of page content for debugging
        if (result.costs.freight.length === 0 && result.costs.customs.length === 0) {
          console.log('Page snippet (for debugging):', result.bodySnippet.substring(0, 2000));
        }
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
    // Take screenshot for debugging
    await page.screenshot({ path: '/tmp/cin7-debug.png' });
    console.log('Screenshot saved to /tmp/cin7-debug.png');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
