import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const USER = 'admin';
const PASS = 'f685514e57c7f43a2b03f6b0';
const OUT = new URL('.', import.meta.url).pathname;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

// Login
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="password"]', PASS);
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
await page.waitForTimeout(2500);
console.log('after login url:', page.url());

async function shot(path, name, full = false) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500); // let client fetches (predictions/options) resolve
  await page.screenshot({ path: `${OUT}${name}`, fullPage: full });
  console.log('saved', name, 'at', page.url());
}

// Simplified Command Center
await shot('/', '03-command-center-simple.png', false);

// Voice cockpit — viewport (hero) and full scroll
await page.goto(`${BASE}/voice`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}03-cockpit-hero.png`, fullPage: false });
console.log('saved 03-cockpit-hero.png at', page.url());
await page.screenshot({ path: `${OUT}03-cockpit-full.png`, fullPage: true });
console.log('saved 03-cockpit-full.png');

// Scroll to the trading deck to capture it in-viewport
await page.evaluate(() => {
  const el = document.querySelector('#deck-predictions');
  if (el) el.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, document.body.scrollHeight);
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}03-cockpit-deck.png`, fullPage: false });
console.log('saved 03-cockpit-deck.png');

await browser.close();
console.log('DONE');
