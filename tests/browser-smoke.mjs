import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8765;
const OUT = '/tmp/ae-shots';
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
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
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const chrome = spawn('google-chrome', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--remote-debugging-port=9333',
  '--user-data-dir=/tmp/ae-chrome-profile',
  'about:blank',
], { stdio: 'ignore' });

const errors = [];
const requests = [];
let evaluate = async () => '';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

try {
  let version;
  for (let i = 0; i < 40; i += 1) {
    try {
      version = await fetch('http://127.0.0.1:9333/json/version').then((res) => res.json());
      break;
    } catch {
      await delay(150);
    }
  }
  if (!version) throw new Error('Chrome did not open a debugging port');
  const pageList = await fetch('http://127.0.0.1:9333/json/list').then((res) => res.json());
  const page = pageList.find((item) => item.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let seq = 0;
  const pending = new Map();
  const requestUrls = new Map();
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
      return;
    }
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      errors.push(data.params.args.map((arg) => arg.value || arg.description || arg.type).join(' '));
    }
    if (data.method === 'Runtime.exceptionThrown') {
      const details = data.params.exceptionDetails;
      errors.push(`${details.text} ${details.exception?.description || ''}`.trim());
    }
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
      errors.push(data.params.entry.text);
    }
    if (data.method === 'Network.requestWillBeSent') {
      requestUrls.set(data.params.requestId, data.params.request.url);
      requests.push(data.params.request.url);
    }
    if (data.method === 'Network.loadingFailed') {
      const url = requestUrls.get(data.params.requestId) || data.params.requestId;
      errors.push(`network ${data.params.errorText} ${url}`);
    }
  });

  function cdp(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result?.value;
  }

  async function waitFor(expression, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return;
      await delay(80);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  async function shot(name) {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  }

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 393,
    height: 852,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (!localStorage.getItem('ae.settings.v1')) localStorage.setItem('ae.settings.v1', JSON.stringify({ autoSpeak: false, polishHints: true, confirmBeforeSend: false, level: 'B1' }));`,
  });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(`document.querySelector('#talk') && document.querySelector('#title')`);
  await delay(300);
  const title = await evaluate(`document.querySelector('#title').textContent`);
  if (title !== 'Rozmowa') fail(`unexpected title ${title}`);
  const talkLabel = await evaluate(`document.querySelector('#talk-label').textContent`);
  if (talkLabel !== 'Mów') fail(`talk label ${talkLabel}`);
  await shot('home.png');
  const homeTalk = await evaluate(`(() => { const r = document.querySelector('#talk').getBoundingClientRect(); return r.top > innerHeight * 0.55; })()`);
  if (!homeTalk) fail('home talk button is not in the thumb zone');

  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.suggest button')][0];
    button.click();
    return button.textContent;
  })()`);
  await waitFor(`document.body.innerText.includes("I'm an electrician")`);
  await waitFor(`document.body.innerText.toLowerCase().includes('lepiej po brytyjsku')`);
  const marks = await evaluate(`document.querySelectorAll('mark.heard').length`);
  if (marks < 2) fail(`expected highlighted mistakes, got ${marks}`);
  const saved = await evaluate(`JSON.parse(localStorage.getItem('ae.cards.v1')).some((card) => card.en === 'for two years')`);
  if (!saved) fail('expected the new phrase in the word list');
  await delay(200);
  const layout = await evaluate(`(() => {
    const list = document.querySelector('#transcript');
    const dock = document.querySelector('.dock');
    const lr = list.getBoundingClientRect();
    const dr = dock.getBoundingClientRect();
    const user = document.querySelector('.msg-user');
    const fixes = document.querySelector('.fixes');
    const ur = user.getBoundingClientRect();
    const fr = fixes.getBoundingClientRect();
    return {
      userInside: ur.top >= lr.top - 1 && ur.bottom <= lr.bottom + 1,
      fixesInside: fr.top >= lr.top - 1 && fr.bottom <= lr.bottom + 1,
      clearOfDock: ur.bottom <= dr.top + 1 && fr.bottom <= dr.top + 1,
    };
  })()`);
  if (!layout.userInside || !layout.fixesInside || !layout.clearOfDock) {
    fail(`conversation layout ${JSON.stringify(layout)}`);
  }
  await shot('conversation.png');
  console.log('starter', clicked);

  await evaluate(`document.querySelector('#nav-cards').click()`);
  await waitFor(`document.querySelector('#title').textContent === 'Słówka'`);
  await waitFor(`document.body.innerText.includes('Pokaż tłumaczenie')`);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Pokaż tłumaczenie').click()`);
  await waitFor(`document.body.innerText.includes('Dobrze')`);
  await shot('flashcards.png');
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Dobrze').click()`);
  await waitFor(`JSON.parse(localStorage.getItem('ae.cards.v1')).some((card) => card.repetitions > 0)`);
  await shot('flashcards-after-grade.png');

  await evaluate(`document.querySelector('#nav-settings').click()`);
  await waitFor(`document.querySelector('#title').textContent === 'Ustawienia'`);
  await evaluate(`document.querySelector('#api-key').value = 'sk-smoke-not-real'`);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Zapisz klucz').click()`);
  await waitFor(`document.body.innerText.includes('Zapisany klucz')`);
  await shot('settings.png');
  const masked = await evaluate(`document.body.innerText`);
  if (!masked.includes('••••')) fail('saved key was not masked');
  if (masked.includes('sk-smoke-not-real')) fail('full key is visible after save');

  await cdp('Page.reload');
  await waitFor(`document.querySelector('#title')`);
  await evaluate(`location.hash = '#/ustawienia'`);
  await waitFor(`document.body.innerText.includes('••••')`);
  const providerCalls = requests.filter((url) => /api\.openai\.com|api\.x\.ai/.test(url));
  if (providerCalls.length) fail(`demo talked to a provider: ${providerCalls.join(', ')}`);
  if (errors.length) fail(`console or network errors before the key check:\n${errors.join('\n')}`);

  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Sprawdź klucz').click()`);
  await waitFor(`[...document.querySelectorAll('p')].some((p) => p.textContent.includes('Klucz odrzucony'))`, 15000);
  const unexpected = errors.filter((line) => !/401/.test(line));
  if (unexpected.length) fail(`console errors:\n${unexpected.join('\n')}`);
  console.log('key check showed a Polish rejection; Chrome logs the 401 itself');
  ws.close();
} catch (err) {
  if (typeof evaluate === 'function') {
    try {
      console.error('BODY:', await evaluate('document.body.innerText.slice(0, 1500)'));
    } catch (dumpErr) {
      console.error('could not dump body', dumpErr.message);
    }
  }
  console.error('ERRORS:', errors);
  fail(err.stack || err.message);
} finally {
  chrome.kill('SIGKILL');
  server.close();
}

if (process.exitCode) process.exit(process.exitCode);
console.log('smoke ok', OUT);
