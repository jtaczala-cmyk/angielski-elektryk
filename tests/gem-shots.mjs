import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { webkit } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8773;
const OUT = '/opt/cursor/artifacts';
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const iPhone = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext({ ...iPhone, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#onboard-skip');
  await page.screenshot({ path: join(OUT, 'screenshot_onboarding.png') });
  await page.locator('#onboard-skip').click();
  await page.waitForSelector('#talk');
  await page.screenshot({ path: join(OUT, 'screenshot_home.png') });
  await page.locator('#transcript').evaluate((node) => { node.scrollTop = 420; });
  await page.screenshot({ path: join(OUT, 'screenshot_scenarios.png') });
  await page.locator('#transcript').evaluate((node) => { node.scrollTop = 0; });
  await page.locator('.scenario-card').first().click();
  await page.waitForSelector('.msg-assistant');
  await page.screenshot({ path: join(OUT, 'screenshot_scenario.png') });
  await page.locator('#draft').fill('I am electrician and I work in Norway since two years.');
  await page.locator('#send').click();
  await page.waitForSelector('.fixes');
  await page.waitForSelector('.chip-strong');
  await page.screenshot({ path: join(OUT, 'screenshot_conversation.png') });
  await page.locator('.chip-strong').click();
  await page.waitForSelector('.report');
  await page.screenshot({ path: join(OUT, 'screenshot_report.png') });
  await page.locator('#nav-cards').click();
  await page.waitForSelector('text=Pokaż tłumaczenie');
  await page.screenshot({ path: join(OUT, 'screenshot_cards.png') });
  await page.locator('#nav-settings').click();
  await page.waitForSelector('#diagnose');
  await page.screenshot({ path: join(OUT, 'screenshot_settings.png') });
  const review = await browser.newContext({ ...iPhone, locale: 'pl-PL' });
  await review.addInitScript(`
    class FakeRecognition {
      start() {
        this.onstart?.();
        setTimeout(() => {
          this.onresult?.({
            resultIndex: 0,
            results: [{ 0: { transcript: 'I am electrician on site' }, isFinal: true, length: 1 }],
          });
        }, 40);
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    window.webkitSpeechRecognition = FakeRecognition;
    window.SpeechRecognition = FakeRecognition;
  `);
  const heard = await review.newPage();
  await heard.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await heard.locator('#onboard-skip').click();
  await heard.locator('#talk').click();
  await heard.waitForSelector('#review-text');
  const value = await heard.locator('#review-text').inputValue();
  if (!/electrician/i.test(value)) throw new Error(`review text was ${value}`);
  await heard.screenshot({ path: join(OUT, 'screenshot_review.png') });
  await heard.locator('#review-send').click();
  await heard.waitForSelector('.fixes');
  console.log('review send ok', value);
  console.log('shots ok');
} finally {
  await browser.close();
  server.close();
}
