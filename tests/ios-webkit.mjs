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

const SAFE_PLAY = `
  const proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (proto && !proto.__aePlay) {
    proto.__aePlay = true;
    try {
      const srcDesc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (srcDesc && srcDesc.set) {
        Object.defineProperty(proto, 'src', {
          configurable: true,
          get() { return srcDesc.get.call(this); },
        set(value) {
          if (typeof value === 'string' && (value.startsWith('data:audio') || value.startsWith('blob:'))) {
            this.__src = value;
            return;
          }
          srcDesc.set.call(this, value);
        },
        });
      }
    } catch { /* src stays writable */ }
    proto.play = function play() {
      window.__htmlPlays = (window.__htmlPlays || 0) + 1;
      const el = this;
      setTimeout(() => { if (typeof el.onended === 'function') el.onended(); }, 10);
      return Promise.resolve();
    };
  }
`;

const HANGING_RECOGNITION = `
  ${SAFE_PLAY}
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
    ${SAFE_PLAY}
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
  await stuck.locator('#voice-details').click();
  const trace = await stuck.locator('#voice-trace').innerText();
  console.log('voice trace:\\n', trace);
  if (!/TimeoutError|TypeError|speech-did-not-start|audio-/i.test(trace)) fail(`Szczegóły missed the failing path:\\n${trace}`);
  await stuck.evaluate(() => {
    const scroller = document.querySelector('.scroll');
    if (scroller) scroller.scrollTop = 0;
  });
  await stuck.screenshot({ path: join(OUT, 'screenshot_ios_voice_trace.png') });
  if (pageErrors.length) fail(`voice page errors:\\n${pageErrors.join('\\n')}`);
  await voice.close();

  const wav = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x25, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00,
    0x64, 0x61, 0x74, 0x61, 0x01, 0x00, 0x00, 0x00, 0x80,
  ]);
  const heard = await browser.newContext({ ...iPhone, locale: 'pl-PL' });
  await heard.addInitScript(`
    ${SAFE_PLAY}
    localStorage.setItem('ae.settings.v1', JSON.stringify({
      provider: 'xai',
      xaiKey: 'xai-test-key',
      level: 'B2',
      autoSpeak: true,
      confirmBeforeSend: false,
      sendMode: 'manual',
      voiceMode: 'provider',
      inputMode: 'type',
    }));
    const wav = new Uint8Array(${JSON.stringify([...wav])});
    const origFetch = window.fetch.bind(window);
    window.fetch = (url) => {
      const target = String(url);
      if (target.includes('/tts') || target.includes('/audio/speech')) {
        return Promise.resolve(new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } }));
      }
      if (target.includes('/chat/completions')) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '{"reply":"Morning. Set the Megger to five hundred volts.","corrections":[],"phrases":[]}' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return origFetch(url);
    };
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = function speak() {};
      window.speechSynthesis.cancel = function cancel() {};
      window.speechSynthesis.getVoices = () => [{ name: 'Daniel', lang: 'en-GB' }];
    }
  `);
  const sam = await heard.newPage();
  const samErrors = [];
  sam.on('pageerror', (err) => samErrors.push(String(err)));
  await sam.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(sam);
  await sam.waitForSelector('#talk');
  await sam.locator('#draft').fill('Explain.');
  await sam.locator('#send').click();
  await sam.waitForSelector('.msg-assistant');
  await sam.waitForFunction(() => (
    (window.__htmlPlays || 0) >= 2
    || /Nie udało się odtworzyć/.test(document.querySelector('.error')?.textContent || '')
  ), null, { timeout: 12000 });
  const played = await sam.evaluate(() => ({
    plays: window.__htmlPlays || 0,
    status: document.querySelector('#status')?.textContent || '',
    error: document.querySelector('.error')?.textContent || '',
    talk: Boolean(document.querySelector('#talk')),
  }));
  console.log('sam playback', played);
  if (!played.talk) fail('talk button missing after Sam spoke');
  if (/Nie udało się odtworzyć/.test(played.error) || /Nie udało się odtworzyć/.test(played.status)) {
    fail(`provider audio was not heard:\\n${played.status}\\n${played.error}`);
  }
  if (played.plays < 1) fail('unlocked audio element never played');
  await sam.locator('#nav-settings').click();
  await sam.locator('#voice-details').click();
  const samTrace = await sam.locator('#voice-trace').innerText();
  console.log('sam trace:\\n', samTrace);
  if (!/wynik: html/.test(samTrace)) fail(`expected html playback in Szczegóły:\\n${samTrace}`);
  if (!/prime: gest/.test(samTrace)) fail(`speechSynthesis was not primed inside the tap:\\n${samTrace}`);
  await sam.screenshot({ path: join(OUT, 'screenshot_ios_sam_played.png') });
  if (samErrors.length) fail(`sam page errors:\\n${samErrors.join('\\n')}`);
  await heard.close();
} finally {
  await browser.close();
  server.close();
}

if (process.exitCode) process.exit(process.exitCode);
console.log('webkit iphone ok');
