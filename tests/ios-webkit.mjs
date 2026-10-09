import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webkit } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8771;
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

const HANGING_RECOGNITION = `
  class FakeRecognition {
    start() {}
    stop() { this.onend?.(); }
    abort() { this.onend?.(); }
  }
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
`;

async function dismissOnboarding(page) {
  const skip = page.locator('#onboard-skip');
  try {
    await skip.waitFor({ state: 'visible', timeout: 2500 });
    await skip.click();
  } catch {
    /* settings were already saved */
  }
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext({ ...iPhone, locale: 'pl-PL' });
  await context.addInitScript(HANGING_RECOGNITION);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(page);
  await page.waitForSelector('#talk');
  const features = await page.evaluate(() => ({
    ios: /iPhone/.test(navigator.userAgent),
    recognition: Boolean(window.webkitSpeechRecognition),
    recorder: typeof MediaRecorder !== 'undefined',
  }));
  console.log('webkit features', features);

  await page.locator('#talk').click();
  await page.waitForSelector('.error', { timeout: 6000 });
  const talkError = await page.locator('.error').innerText();
  console.log('talk error:', talkError);
  if (!/dyktowanie|wpisz|klucz/i.test(talkError)) fail(`talk error was not Polish guidance: ${talkError}`);
  await page.screenshot({ path: join(OUT, 'screenshot_ios_talk_error.png') });

  await page.locator('#draft').fill('I am electrician and I work in Norway since two years.');
  await page.locator('#send').click();
  await page.waitForSelector('.msg-assistant', { timeout: 6000 });
  const reply = await page.locator('.msg-assistant').innerText();
  if (!/electrician/i.test(reply)) fail(`typing did not produce a reply: ${reply}`);
  console.log('typed reply ok');

  await page.locator('#nav-settings').click();
  await page.waitForSelector('#diagnose');
  await page.locator('#diagnose').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('#diagnostics');
    return node && !node.hidden && /Klucz: brak/.test(node.textContent);
  }, null, { timeout: 20000 });
  const report = await page.locator('#diagnostics').innerText();
  console.log('diagnostics:\n', report);
  if (!/Dyktowanie/.test(report)) fail('diagnostics missed dictation');
  if (!/Mikrofon/.test(report)) fail('diagnostics missed microphone');
  await page.evaluate(() => {
    const scroller = document.querySelector('.scroll');
    if (scroller) scroller.scrollTop = 0;
  });
  await page.screenshot({ path: '/tmp/ae-diagnostics.png' });

  const unexpected = errors.filter((line) => !/401|NotAllowed|not allowed/i.test(line));
  if (unexpected.length) fail(`page errors:\n${unexpected.join('\n')}`);
  await context.close();

  let standalone;
  try {
  standalone = await browser.newContext({ ...iPhone, locale: 'pl-PL' });
  await standalone.addInitScript(`
    ${HANGING_RECOGNITION}
    class FakeRecorder {
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/mp4'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
      addEventListener(type, fn) { this['on' + type] = fn; }
    }
    FakeRecorder.isTypeSupported = (type) => type === 'audio/mp4';
    window.MediaRecorder = FakeRecorder;
    try {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    } catch (err) {
      window.__standaloneError = String(err);
    }
  `);
  const home = await standalone.newPage();
  await home.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(home);
  await home.waitForSelector('#talk');
  const standaloneState = await home.evaluate(() => ({
    standalone: navigator.standalone === true,
    recorder: typeof MediaRecorder !== 'undefined',
    error: window.__standaloneError || '',
  }));
  console.log('standalone state', standaloneState);
  await home.locator('#talk').click();
  await home.waitForSelector('.error', { timeout: 6000 });
  const homeError = await home.locator('.error').innerText();
  console.log('standalone error:', homeError);
  if (!/klucz/i.test(homeError)) fail(`standalone did not explain the key: ${homeError}`);
  await home.screenshot({ path: '/tmp/ae-standalone.png' });
  await standalone.close();
  } catch (err) {
    console.error('standalone failed', err);
    process.exitCode = 1;
  }

  const voice = await browser.newContext({ ...iPhone, locale: 'pl-PL' });
  await voice.addInitScript(`
    localStorage.setItem('ae.settings.v1', JSON.stringify({
      provider: 'xai',
      xaiKey: 'xai-test-key',
      level: 'C1',
      autoSpeak: true,
      polishHints: true,
      confirmBeforeSend: false,
      sendMode: 'manual',
      voiceMode: 'provider',
      inputMode: 'type',
    }));
    const origFetch = window.fetch.bind(window);
    window.fetch = (url, init) => {
      const target = String(url);
      if (target.includes('/tts') || target.includes('/audio/speech')) return new Promise(() => {});
      if (target.includes('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'invalid key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (target.includes('/chat/completions')) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '{"reply":"Morning. Can you hear me on site?","corrections":[],"phrases":[]}' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return origFetch(url, init);
    };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      AC.prototype.resume = function resume() { return new Promise(() => {}); };
      AC.prototype.decodeAudioData = function decode() { return new Promise(() => {}); };
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = function speak() {};
      window.speechSynthesis.cancel = function cancel() {};
      window.speechSynthesis.getVoices = () => [{ name: 'Daniel', lang: 'en-GB' }];
    }
  `);
  const stuck = await voice.newPage();
  const pageErrors = [];
  stuck.on('pageerror', (err) => pageErrors.push(String(err)));
  await stuck.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await stuck.waitForSelector('#talk');
  await stuck.locator('#draft').fill('Hello hello');
  await stuck.locator('#send').click();
  await stuck.waitForSelector('.msg-assistant');
  await stuck.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Mówię'), null, { timeout: 6000 });
  const during = await stuck.evaluate(() => {
    const talk = document.querySelector('#talk');
    const box = talk?.getBoundingClientRect();
    return {
      talk: Boolean(talk),
      visible: Boolean(box && box.width > 20 && box.bottom > 0),
      przerwij: document.querySelector('#stop-speech')?.hidden === false,
    };
  });
  console.log('while speaking', during);
  if (!during.talk || !during.visible) fail(`talk button missing while speaking: ${JSON.stringify(during)}`);
  if (!during.przerwij) fail('Przerwij was not shown while speaking');
  await stuck.screenshot({ path: join(OUT, 'screenshot_ios_przerwij.png') });
  await stuck.locator('#stop-speech').click();
  await stuck.waitForFunction(() => !document.querySelector('#status')?.textContent?.includes('Mówię'), null, { timeout: 4000 });
  const after = await stuck.locator('#talk').isVisible();
  if (!after) fail('talk button missing after Przerwij');
  await stuck.locator('#draft').fill('Hello again');
  await stuck.locator('#send').click();
  await stuck.waitForFunction(() => /Nie udało się odtworzyć głosu/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 15000 });
  const recovered = await stuck.evaluate(() => {
    const talk = document.querySelector('#talk');
    const box = talk?.getBoundingClientRect();
    return Boolean(talk && box && box.width > 20 && box.bottom > 0 && !talk.disabled);
  });
  if (!recovered) fail('talk button did not return after the voice gave up');
  await stuck.locator('#nav-settings').click();
  await stuck.locator('#diagnose').click();
  await stuck.waitForFunction(() => /Głos Sama/.test(document.querySelector('#diagnostics')?.textContent || ''), null, { timeout: 25000 });
  const voiceReport = await stuck.locator('#diagnostics').innerText();
  console.log('voice diagnose:\\n', voiceReport);
  if (!/Głos Sama \(xAI\): nie zagrał/.test(voiceReport)) fail(`provider voice test did not report failure:\\n${voiceReport}`);
  await stuck.evaluate(() => {
    const scroller = document.querySelector('.scroll');
    if (scroller) scroller.scrollTop = 0;
  });
  await stuck.screenshot({ path: join(OUT, 'screenshot_ios_voice_report.png') });
  if (pageErrors.length) fail(`voice page errors:\\n${pageErrors.join('\\n')}`);
  await voice.close();
} finally {
  await browser.close();
  server.close();
}

if (process.exitCode) process.exit(process.exitCode);
console.log('webkit iphone ok');
