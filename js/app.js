import { SEED } from './seed.js';
import { dueCards, ensureSeed, removeCard, reviewCard, searchCards, upsertPhrase } from './srs.js';
import { activeKey, clearAll, loadCards, loadMessages, loadSettings, saveCards, saveMessages, saveSettings } from './storage.js';
import { TOPICS, buildSystemPrompt, messagesForApi, splitHighlights, topicKickoff } from './tutor.js';
import { PROVIDERS, ProviderError, activeModel, chatComplete, synthesizeSpeech, transcribeAudio, verifyKey } from './providers.js';
import {
  describeInputPath,
  extensionForMime,
  getRecognitionCtor,
  mediaRecorderSupported,
  pathLabel,
  pickRecorderMime,
  speakBrowser,
  startBrowserRecognition,
  stopBrowserSpeech,
  unlockAudio,
  waitForAudioUnlock,
} from './speech.js';
import { demoReply } from './demo.js';

const store = window.localStorage;
const audioEl = document.getElementById('voice');
const main = document.getElementById('main');
const title = document.getElementById('title');
const levelSelect = document.getElementById('level');
const dueBadge = document.getElementById('due-badge');
const toast = document.getElementById('toast');

let settings = loadSettings(store);
let seeded = ensureSeed(loadCards(store), SEED);
let cards = seeded.cards;
if (seeded.added) saveCards(store, cards);
let messages = loadMessages(store);

const ui = {
  route: routeFromHash(),
  listening: false,
  busy: false,
  status: '',
  error: '',
  live: '',
  recognitionBroken: false,
  flipped: false,
  cardTab: 'due',
  query: '',
  queue: [],
  queueReady: false,
  confirmDelete: '',
  formNote: '',
  installEvent: null,
};

let recognizer = null;
let recorder = null;
let recorderChunks = [];
let recorderStream = null;
let cancelListen = false;
let toastTimer = 0;
let currentObjectUrl = '';

const TITLES = { talk: 'Rozmowa', cards: 'Słówka', settings: 'Ustawienia' };
const STARTERS = [
  'I am electrician and I work in Norway since two years.',
  'Yesterday I change the consumer unit.',
  'Can we talk about a toolbox talk?',
];

function routeFromHash() {
  const hash = location.hash.replace('#', '');
  if (hash === '/slowka') return 'cards';
  if (hash === '/ustawienia') return 'settings';
  return 'talk';
}

function hashFor(route) {
  if (route === 'cards') return '#/slowka';
  if (route === 'settings') return '#/ustawienia';
  return '#/';
}

function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function boot() {
  levelSelect.value = settings.level;
  levelSelect.addEventListener('change', () => {
    settings.level = levelSelect.value;
    saveSettings(store, settings);
  });
  document.querySelectorAll('.nav button').forEach((button) => {
    button.addEventListener('click', () => {
      const route = button.dataset.route;
      if (route !== 'cards') ui.queueReady = false;
      if (location.hash !== hashFor(route)) location.hash = hashFor(route);
      else {
        ui.route = route;
        render();
      }
    });
  });
  window.addEventListener('hashchange', () => {
    const next = routeFromHash();
    if (next !== 'cards') ui.queueReady = false;
    ui.route = next;
    render();
  });
  document.getElementById('app').addEventListener('pointerdown', () => unlockAudio(audioEl), { passive: true });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    ui.installEvent = event;
    if (ui.route === 'settings') render();
  });
  const viewport = window.visualViewport;
  if (viewport) {
    const fit = () => {
      const app = document.getElementById('app');
      app.style.height = `${viewport.height}px`;
    };
    viewport.addEventListener('resize', fit);
    viewport.addEventListener('scroll', fit);
    fit();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  render();
}

function render() {
  title.textContent = TITLES[ui.route];
  levelSelect.value = settings.level;
  document.querySelectorAll('.nav button').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.route === ui.route ? 'page' : 'false');
  });
  const due = dueCards(cards).length;
  dueBadge.hidden = due === 0;
  dueBadge.textContent = due > 99 ? '99+' : String(due);
  main.replaceChildren();
  if (ui.route === 'talk') main.append(renderTalk());
  else if (ui.route === 'cards') main.append(renderCards());
  else main.append(renderSettings());
}

function inputPath() {
  return describeInputPath({
    inputMode: settings.inputMode,
    hasRecognition: Boolean(getRecognitionCtor()) && !ui.recognitionBroken,
    hasRecorder: mediaRecorderSupported(),
  });
}

function renderTalk() {
  const screen = el('section', 'screen');
  screen.dataset.screen = 'talk';
  if (!activeKey(settings)) {
    const banner = el('p', 'banner');
    banner.append(el('strong', null, 'Tryb próbny. '));
    banner.append('Bez klucza API odpowiadam z pamięci telefonu, nie z modelu. Klucz dodasz w ustawieniach.');
    screen.append(banner);
  }
  const topics = el('div', 'topics');
  for (const topic of TOPICS) {
    const button = el('button', null, topic.pl);
    button.type = 'button';
    button.addEventListener('click', () => startTopic(topic));
    topics.append(button);
  }
  const fresh = el('button', null, 'Nowa');
  fresh.type = 'button';
  fresh.addEventListener('click', newChat);
  topics.append(fresh);
  screen.append(topics);

  const transcript = el('div', 'transcript');
  transcript.id = 'transcript';
  transcript.setAttribute('aria-live', 'off');
  const visible = messages.filter((message) => !message.hidden);
  if (!visible.length) transcript.append(emptyState());
  messages.forEach((message, index) => {
    if (!message.hidden) transcript.append(messageView(message, index));
  });
  screen.append(transcript);

  if (ui.error) screen.append(el('p', 'error', ui.error));

  const dock = el('div', 'dock');
  const live = el('p', 'live', ui.live);
  live.id = 'live';
  dock.append(live);
  const composer = el('div', 'composer');
  const draft = document.createElement('textarea');
  draft.id = 'draft';
  draft.rows = 2;
  draft.placeholder = 'Wpisz po angielsku…';
  draft.enterKeyHint = 'send';
  draft.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendDraft();
    }
  });
  const send = el('button', 'send', '→');
  send.type = 'button';
  send.id = 'send';
  send.setAttribute('aria-label', 'Wyślij');
  send.addEventListener('click', sendDraft);
  composer.append(draft, send);
  dock.append(composer);

  const row = el('div', 'talk-row');
  const cancel = el('button', 'side-btn', 'Anuluj');
  cancel.type = 'button';
  cancel.id = 'cancel-listen';
  cancel.hidden = !ui.listening;
  cancel.addEventListener('click', () => stopListening(true));
  const talk = document.createElement('button');
  talk.type = 'button';
  talk.id = 'talk';
  talk.className = ui.listening ? 'talk is-live' : 'talk';
  talk.disabled = ui.busy && !ui.listening;
  talk.setAttribute('aria-pressed', ui.listening ? 'true' : 'false');
  talk.setAttribute('aria-label', ui.listening ? 'Zatrzymaj i wyślij' : 'Mów po angielsku');
  talk.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-7 9a1 1 0 0 0-2 0 9 9 0 0 0 8 8.9V22H9v2h6v-2h-2v-1.1A9 9 0 0 0 21 12a1 1 0 0 0-2 0 7 7 0 0 1-14 0z"/></svg>';
  const label = el('span', null, ui.listening ? 'Stop' : 'Mów');
  label.id = 'talk-label';
  talk.append(label);
  talk.addEventListener('click', onTalk);
  row.append(cancel, talk);
  dock.append(row);
  const status = el('p', 'path', ui.status || pathLabel(inputPath()));
  status.id = 'status';
  status.setAttribute('aria-live', 'polite');
  dock.append(status);
  screen.append(dock);
  queueMicrotask(() => {
    transcript.scrollTop = transcript.scrollHeight;
  });
  return screen;
}

function emptyState() {
  const box = el('div', 'empty');
  box.id = 'empty';
  box.append(el('h2', null, 'Mów, jak na budowie.'));
  box.append(el('p', null, 'Stuknij pomarańczowy przycisk i powiedz coś po angielsku. Odpowiem na głos, dopytam i poprawię tylko to, co brzmi nienaturalnie.'));
  const suggest = el('div', 'suggest');
  suggest.append(el('span', null, 'Albo stuknij zdanie'));
  for (const line of STARTERS) {
    const button = el('button', null, line);
    button.type = 'button';
    button.lang = 'en-GB';
    button.addEventListener('click', () => {
      unlockAudio(audioEl);
      submitText(line);
    });
    suggest.append(button);
  }
  box.append(suggest);
  return box;
}

function messageView(message, index) {
  const article = el('article', `msg msg-${message.role}`);
  article.dataset.id = message.id;
  if (message.role === 'note') {
    const note = el('p', 'note', message.text);
    article.append(note);
    return article;
  }
  const bubble = el('div', 'bubble');
  bubble.lang = 'en-GB';
  const fixes = message.role === 'user' ? correctionsAfter(index) : [];
  appendHighlighted(bubble, message.text, fixes.map((item) => item.heard));
  article.append(bubble);
  if (fixes.length) article.append(fixesView(fixes));
  if (message.role === 'assistant') {
    const tools = el('div', 'msg-tools');
    const replay = el('button', 'text-btn', 'Odsłuchaj');
    replay.type = 'button';
    replay.addEventListener('click', () => {
      unlockAudio(audioEl);
      speak(message.text);
    });
    tools.append(replay);
    article.append(tools);
    if (message.phrases?.length) {
      const row = el('div', 'phrases');
      for (const phrase of message.phrases) {
        row.append(el('span', 'chip', phrase.en));
      }
      article.append(row);
    }
  }
  return article;
}

function correctionsAfter(index) {
  const next = messages[index + 1];
  if (next?.role === 'assistant' && Array.isArray(next.corrections)) return next.corrections.filter((item) => item.better);
  return [];
}

function appendHighlighted(parent, text, phrases) {
  for (const part of splitHighlights(text, phrases)) {
    if (!part.text) continue;
    if (part.hit) parent.append(el('mark', 'heard', part.text));
    else parent.append(document.createTextNode(part.text));
  }
}

function fixesView(fixes) {
  const box = el('div', 'fixes');
  box.append(el('p', 'fix-label', 'Lepiej po brytyjsku'));
  for (const fix of fixes) {
    const better = el('p', 'fix-better', fix.better);
    better.lang = 'en-GB';
    box.append(better);
    if (fix.why_pl && settings.polishHints) {
      const why = el('p', 'fix-why', fix.why_pl);
      why.lang = 'pl';
      box.append(why);
    }
  }
  return box;
}

function renderCards() {
  if (!ui.queueReady) {
    ui.queue = dueCards(cards).map((card) => card.id);
    ui.queueReady = true;
    ui.flipped = false;
  }
  const screen = el('section', 'screen');
  screen.dataset.screen = 'cards';
  const scroll = el('div', 'scroll');
  const stats = el('div', 'card-stats');
  const tabs = el('div', 'tabs');
  const dueBtn = el('button', null, 'Do powtórki');
  dueBtn.type = 'button';
  dueBtn.setAttribute('aria-pressed', ui.cardTab === 'due' ? 'true' : 'false');
  dueBtn.addEventListener('click', () => {
    ui.cardTab = 'due';
    render();
  });
  const allBtn = el('button', null, 'Wszystkie');
  allBtn.type = 'button';
  allBtn.setAttribute('aria-pressed', ui.cardTab === 'all' ? 'true' : 'false');
  allBtn.addEventListener('click', () => {
    ui.cardTab = 'all';
    render();
  });
  tabs.append(dueBtn, allBtn);
  stats.append(el('p', null, `${dueCards(cards).length} na dziś · ${cards.length} w zeszycie`), tabs);
  scroll.append(stats);
  if (ui.cardTab === 'due') scroll.append(dueView());
  else scroll.append(listView());
  screen.append(scroll);
  return screen;
}

function dueView() {
  const wrap = el('div');
  const id = ui.queue[0];
  const card = cards.find((item) => item.id === id);
  if (!card) {
    const done = el('div', 'done');
    done.append(el('h2', null, 'Na dziś czysto.'));
    done.append(el('p', null, 'Nowe słówka z rozmowy same tu wpadną. Możesz przejrzeć cały zeszyt.'));
    const browse = el('button', 'send', 'Pokaż wszystkie');
    browse.type = 'button';
    browse.addEventListener('click', () => {
      ui.cardTab = 'all';
      render();
    });
    done.append(browse);
    wrap.append(done);
    return wrap;
  }
  wrap.append(el('p', 'path', `Zostało ${ui.queue.length}`));
  const flash = el('article', 'flash');
  flash.append(el('p', 'meta', card.source === 'seed' ? 'Zestaw startowy' : 'Z rozmowy'));
  const word = el('h2', 'word', card.en);
  word.lang = 'en-GB';
  flash.append(word);
  if (ui.flipped) {
    const gloss = el('p', 'gloss', card.pl);
    gloss.lang = 'pl';
    flash.append(gloss);
    if (card.example) {
      const example = el('p', 'example', card.example);
      example.lang = 'en-GB';
      flash.append(example);
    }
  }
  const actions = el('div', 'msg-tools');
  const flip = el('button', 'text-btn', ui.flipped ? 'Ukryj tłumaczenie' : 'Pokaż tłumaczenie');
  flip.type = 'button';
  flip.addEventListener('click', () => {
    ui.flipped = !ui.flipped;
    render();
  });
  const say = el('button', 'text-btn', 'Wymowa');
  say.type = 'button';
  say.addEventListener('click', () => {
    unlockAudio(audioEl);
    const line = card.example ? `${card.en}. ${card.example}` : card.en;
    speak(line, { slow: true });
  });
  actions.append(flip, say);
  flash.append(actions);
  wrap.append(flash);
  if (ui.flipped) {
    const grades = el('div', 'grades');
    const options = [
      ['again', 'Jeszcze raz', 1],
      ['hard', 'Trudne', 3],
      ['good', 'Dobrze', 4],
      ['easy', 'Łatwo', 5],
    ];
    for (const [name, label, grade] of options) {
      const button = el('button', `grade ${name}`, label);
      button.type = 'button';
      button.addEventListener('click', () => gradeCard(card.id, grade));
      grades.append(button);
    }
    wrap.append(grades);
  }
  return wrap;
}

function listView() {
  const wrap = el('div');
  const search = document.createElement('input');
  search.className = 'search';
  search.type = 'search';
  search.placeholder = 'Szukaj po angielsku albo po polsku';
  search.value = ui.query;
  search.addEventListener('input', () => {
    ui.query = search.value;
    const list = document.getElementById('word-list');
    if (list) list.replaceWith(wordList(ui.query));
  });
  wrap.append(search, wordList(ui.query));
  return wrap;
}

function wordList(query) {
  const list = el('ul', 'word-list');
  list.id = 'word-list';
  const found = searchCards(cards, query);
  if (!found.length) {
    list.append(el('li', null, 'Nic nie pasuje.'));
    return list;
  }
  for (const card of found) {
    const item = el('li');
    item.append(el('strong', null, card.en));
    const say = el('button', 'text-btn', 'Wymowa');
    say.type = 'button';
    say.addEventListener('click', () => {
      unlockAudio(audioEl);
      speak(card.example ? `${card.en}. ${card.example}` : card.en, { slow: true });
    });
    item.append(say);
    item.append(el('em', null, card.pl));
    const del = el('button', 'text-btn', ui.confirmDelete === card.id ? 'Potwierdź' : 'Usuń');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (ui.confirmDelete !== card.id) {
        ui.confirmDelete = card.id;
        render();
        return;
      }
      cards = removeCard(cards, card.id);
      ui.queue = ui.queue.filter((id) => id !== card.id);
      ui.confirmDelete = '';
      saveCards(store, cards);
      render();
    });
    item.append(del);
    list.append(item);
  }
  return list;
}

function gradeCard(id, grade) {
  cards = cards.map((card) => (card.id === id ? reviewCard(card, grade) : card));
  saveCards(store, cards);
  ui.queue = ui.queue.filter((item) => item !== id);
  if (grade < 3) ui.queue.push(id);
  ui.flipped = false;
  render();
}

function renderSettings() {
  const screen = el('section', 'screen');
  screen.dataset.screen = 'settings';
  const scroll = el('div', 'scroll');

  const connection = el('section', 'panel');
  connection.append(el('h2', null, 'Połączenie'));
  connection.append(el('p', null, 'Klucz zostaje w tej przeglądarce (localStorage). Ta strona nie ma serwera. Klucz idzie tylko do wybranego dostawcy, gdy rozmawiasz, słuchasz wymowy albo sprawdzasz klucz.'));
  connection.append(el('p', null, 'Gdzie wziąć klucz i ile to kosztuje: konto jest Twoje, płacisz dostawcy za tekst i za mowę. Krótka wymiana to zwykle drobiazg (grosze albo ułamek korony), dłuższa sesja już się sumuje. Ustaw limit wydatków w panelu.'));
  const providerField = el('label', 'field', 'Dostawca');
  const provider = document.createElement('select');
  provider.id = 'provider';
  for (const spec of Object.values(PROVIDERS)) {
    const option = el('option', null, spec.label);
    option.value = spec.id;
    provider.append(option);
  }
  provider.value = settings.provider;
  provider.addEventListener('change', () => {
    settings.provider = provider.value;
    saveSettings(store, settings);
    ui.formNote = '';
    render();
  });
  providerField.append(provider);
  connection.append(providerField);

  const spec = PROVIDERS[settings.provider];
  const saved = activeKey(settings);
  connection.append(el('p', 'help', saved ? `Zapisany klucz: ••••${saved.slice(-4)}. Puste pole go nie kasuje.` : 'Nie ma jeszcze klucza dla tego dostawcy.'));
  const keyField = el('label', 'field', 'Klucz API');
  const key = document.createElement('input');
  key.id = 'api-key';
  key.type = 'password';
  key.autocomplete = 'off';
  key.spellcheck = false;
  key.placeholder = saved ? 'Wklej nowy, jeśli chcesz podmienić' : 'Wklej klucz';
  keyField.append(key);
  connection.append(keyField);
  const keyRow = el('div', 'row');
  const saveKey = el('button', 'send', 'Zapisz klucz');
  saveKey.type = 'button';
  saveKey.addEventListener('click', () => {
    const value = key.value.trim();
    if (!value) {
      ui.formNote = 'Wklej klucz. Puste pole nie rusza tego, który już jest zapisany.';
      render();
      return;
    }
    if (settings.provider === 'xai') settings.xaiKey = value;
    else settings.openaiKey = value;
    saveSettings(store, settings);
    ui.formNote = 'Zapisane na tym urządzeniu.';
    render();
  });
  const check = el('button', 'side-btn', 'Sprawdź klucz');
  check.type = 'button';
  check.addEventListener('click', () => checkKey(key.value.trim()));
  const wipe = el('button', 'side-btn', 'Usuń klucz');
  wipe.type = 'button';
  wipe.addEventListener('click', () => {
    if (settings.provider === 'xai') settings.xaiKey = '';
    else settings.openaiKey = '';
    saveSettings(store, settings);
    ui.formNote = 'Klucz usunięty z tego telefonu.';
    render();
  });
  keyRow.append(saveKey, check, wipe);
  connection.append(keyRow);
  if (ui.formNote) connection.append(el('p', 'help', ui.formNote));

  const modelField = el('label', 'field', 'Model');
  const model = document.createElement('input');
  model.id = 'model';
  model.type = 'text';
  model.value = settings.model;
  model.placeholder = spec.defaultModel;
  model.setAttribute('list', 'models');
  model.addEventListener('change', () => {
    settings.model = model.value.trim();
    saveSettings(store, settings);
  });
  const list = document.createElement('datalist');
  list.id = 'models';
  for (const name of spec.models) {
    const option = document.createElement('option');
    option.value = name;
    list.append(option);
  }
  modelField.append(model, list);
  connection.append(modelField);
  connection.append(el('p', 'help', `Puste pole znaczy ${spec.defaultModel}. To aktualny, oszczędny model do zwykłej rozmowy. Nazwę możesz zmienić, gdy dostawca wypuści nowszy.`));
  const links = el('div', 'links');
  const keyLink = el('a', null, settings.provider === 'xai' ? 'Klucze xAI (console.x.ai)' : 'Klucze OpenAI (platform.openai.com)');
  keyLink.href = spec.keyUrl;
  keyLink.target = '_blank';
  keyLink.rel = 'noreferrer';
  const priceLink = el('a', null, settings.provider === 'xai' ? 'Cennik xAI' : 'Cennik OpenAI');
  priceLink.href = settings.provider === 'xai' ? 'https://docs.x.ai/developers/pricing' : 'https://developers.openai.com/api/docs/pricing';
  priceLink.target = '_blank';
  priceLink.rel = 'noreferrer';
  links.append(keyLink, priceLink);
  connection.append(links);
  scroll.append(connection);

  const talk = el('section', 'panel');
  talk.append(el('h2', null, 'Rozmowa'));
  talk.append(toggle('Podpowiedzi po polsku przy poprawkach', settings.polishHints, (value) => {
    settings.polishHints = value;
    saveSettings(store, settings);
  }));
  talk.append(toggle('Czytaj odpowiedzi na głos', settings.autoSpeak, (value) => {
    settings.autoSpeak = value;
    saveSettings(store, settings);
  }));
  talk.append(toggle('Najpierw pokaż rozpoznany tekst', settings.confirmBeforeSend, (value) => {
    settings.confirmBeforeSend = value;
    saveSettings(store, settings);
  }));
  const inputField = el('label', 'field', 'Jak Cię słuchać');
  const input = document.createElement('select');
  for (const [value, label] of [
    ['auto', 'Sam wybierz (dyktowanie, potem nagranie)'],
    ['browser', 'Dyktowanie przeglądarki, en-GB'],
    ['record', 'Nagranie i transkrypcja u dostawcy'],
    ['type', 'Tylko pisanie'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    input.append(option);
  }
  input.value = settings.inputMode;
  input.addEventListener('change', () => {
    settings.inputMode = input.value;
    ui.recognitionBroken = false;
    saveSettings(store, settings);
  });
  inputField.append(input);
  talk.append(inputField);
  talk.append(el('p', 'help', 'Na iPhonie dyktowanie działa w Safari (webkitSpeechRecognition, język en-GB), jeśli włączysz Dyktowanie i dodasz English (UK): Ustawienia → Ogólne → Klawiatura → Dyktowanie. Po odtworzeniu głosu tworzę nowy mikrofon, bo starsza sesja na iOS potrafi zamilknąć. Gdy dyktowanie nie ruszy, nagrywam i wysyłam plik do transkrypcji. Pisanie jest zawsze pod ręką.'));
  scroll.append(talk);

  const voice = el('section', 'panel');
  voice.append(el('h2', null, 'Głos'));
  const modeField = el('label', 'field', 'Skąd głos');
  const mode = document.createElement('select');
  for (const [value, label] of [
    ['provider', 'Głos dostawcy (brytyjski, lepszy)'],
    ['browser', 'Głos telefonu (en-GB, bez opłaty)'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    mode.append(option);
  }
  mode.value = settings.voiceMode;
  mode.addEventListener('change', () => {
    settings.voiceMode = mode.value;
    saveSettings(store, settings);
    render();
  });
  modeField.append(mode);
  voice.append(modeField);
  const voiceField = el('label', 'field', 'Barwa');
  const voiceSelect = document.createElement('select');
  const current = settings.provider === 'xai' ? settings.xaiVoice : settings.openaiVoice;
  for (const name of spec.voices) {
    const option = el('option', null, name);
    option.value = name;
    voiceSelect.append(option);
  }
  voiceSelect.value = spec.voices.includes(current) ? current : spec.voices[0];
  voiceSelect.addEventListener('change', () => {
    if (settings.provider === 'xai') settings.xaiVoice = voiceSelect.value;
    else settings.openaiVoice = voiceSelect.value;
    saveSettings(store, settings);
  });
  voiceField.append(voiceSelect);
  voice.append(voiceField);
  voice.append(el('p', 'help', settings.provider === 'xai'
    ? 'eve i leo w xAI są opisane jako akcent brytyjski. Reszta głosów mówi po angielsku, ale niekoniecznie z Wysp.'
    : 'OpenAI czyta modelem gpt-4o-mini-tts z poleceniem brytyjskiego akcentu. Gdy to się nie uda, zostaje głos en-GB z iPhone’a (Daniel, Kate albo inny).'));
  scroll.append(voice);

  const phone = el('section', 'panel');
  phone.append(el('h2', null, 'Na iPhonie'));
  phone.append(el('p', null, 'Dodaj stronę do ekranu początkowego: Udostępnij, potem „Do ekranu początkowego”. Otwiera się wtedy jak aplikacja. Pierwsze stuknięcie włącza dźwięk — iOS nie pozwala stronie mówić samej z siebie.'));
  if (ui.installEvent) {
    const install = el('button', 'send', 'Zainstaluj');
    install.type = 'button';
    install.addEventListener('click', async () => {
      ui.installEvent.prompt();
      await ui.installEvent.userChoice;
      ui.installEvent = null;
      render();
    });
    phone.append(install);
  }
  scroll.append(phone);

  const data = el('section', 'panel');
  data.append(el('h2', null, 'Dane na tym telefonie'));
  data.append(el('p', null, 'Rozmowa, słówka i klucz siedzą tylko tutaj. Wyczyszczenie kasuje je z przeglądarki.'));
  const clear = el('button', 'side-btn', 'Wyczyść wszystko');
  clear.type = 'button';
  clear.addEventListener('click', () => {
    if (!window.confirm('Usunąć klucz, rozmowę i postępy słówek z tego telefonu?')) return;
    clearAll(store);
    settings = loadSettings(store);
    cards = ensureSeed([], SEED).cards;
    saveCards(store, cards);
    messages = [];
    ui.queueReady = false;
    ui.formNote = '';
    render();
  });
  data.append(clear);
  scroll.append(data);

  screen.append(scroll);
  return screen;
}

function toggle(label, checked, onChange) {
  const row = el('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(input, document.createTextNode(label));
  return row;
}

async function checkKey(typed) {
  const key = (typed || activeKey(settings)).trim();
  if (!key) {
    ui.formNote = 'Najpierw wklej i zapisz klucz.';
    render();
    return;
  }
  if (typed) {
    if (settings.provider === 'xai') settings.xaiKey = key;
    else settings.openaiKey = key;
    saveSettings(store, settings);
  }
  ui.formNote = 'Sprawdzam…';
  render();
  try {
    const result = await verifyKey({ provider: settings.provider, apiKey: key });
    ui.formNote = result.ok
      ? 'Klucz działa. Można rozmawiać.'
      : result.status === 401
        ? 'Klucz odrzucony. Sprawdź, czy wkleiłeś go w całości i czy konto jest aktywne.'
        : `Nie wyszło (${result.status}). ${result.message}`;
  } catch (err) {
    ui.formNote = polishError(err);
  }
  render();
}

function newChat() {
  if (messages.length && !window.confirm('Zacząć nową rozmowę? Słówka zostają.')) return;
  messages = [];
  saveMessages(store, messages);
  ui.error = '';
  ui.live = '';
  stopListening(true);
  stopSpeaking();
  render();
}

async function startTopic(topic) {
  if (ui.busy) return;
  unlockAudio(audioEl);
  stopSpeaking();
  showMessage({ id: uid(), role: 'note', text: `Temat: ${topic.pl}`, at: Date.now() });
  await submitText(topicKickoff(topic), { hidden: true, topicId: topic.id });
}

function sendDraft() {
  const draft = document.getElementById('draft');
  const text = draft ? draft.value : '';
  unlockAudio(audioEl);
  submitText(text);
}

async function onTalk() {
  unlockAudio(audioEl);
  stopSpeaking();
  if (ui.busy) return;
  if (ui.listening) {
    stopListening(false);
    return;
  }
  const path = inputPath();
  if (path === 'type') {
    document.getElementById('draft')?.focus();
    setStatus('Na tym ustawieniu zostaje pisanie.');
    return;
  }
  if (path === 'browser') startRecognition();
  else startRecording();
}

function startRecognition() {
  cancelListen = false;
  ui.listening = true;
  paintListen();
  setStatus('Słucham… mów po angielsku.');
  setLive('');
  try {
    recognizer = startBrowserRecognition({
      onPartial: (text) => setLive(text),
      onError: (code) => {
        if (code === 'aborted' || code === 'no-speech') return;
        if (code === 'not-allowed') {
          cancelListen = true;
          setStatus('Brak mikrofonu. Zezwól Safari albo wpisz zdanie.');
          return;
        }
        ui.recognitionBroken = true;
        cancelListen = true;
        setStatus('Dyktowanie stanęło. Następnym razem nagram dźwięk.');
      },
      onEnd: (text) => {
        recognizer = null;
        const heard = (text || ui.live || '').trim();
        ui.listening = false;
        paintListen();
        setLive('');
        if (cancelListen) {
          cancelListen = false;
          setStatus(pathLabel(inputPath()));
          return;
        }
        onHeard(heard);
      },
    });
  } catch {
    ui.listening = false;
    ui.recognitionBroken = true;
    paintListen();
    if (inputPath() === 'record') startRecording();
    else setStatus('Dyktowanie niedostępne. Wpisz zdanie.');
  }
}

async function startRecording() {
  cancelListen = false;
  ui.listening = true;
  paintListen();
  setStatus('Nagrywam… stuknij Stop, gdy skończysz.');
  try {
    recorderStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const mime = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type));
    recorder = mime ? new MediaRecorder(recorderStream, { mimeType: mime }) : new MediaRecorder(recorderStream);
    recorderChunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) recorderChunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const type = recorder.mimeType || mime || 'audio/mp4';
      const blob = new Blob(recorderChunks, { type });
      cleanupStream();
      ui.listening = false;
      paintListen();
      if (cancelListen) {
        cancelListen = false;
        setStatus(pathLabel(inputPath()));
        return;
      }
      transcribeBlob(blob, type);
    });
    recorder.start();
  } catch (err) {
    ui.listening = false;
    paintListen();
    cleanupStream();
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setStatus(denied ? 'Brak mikrofonu. Zezwól Safari albo wpisz zdanie.' : 'Nie udało się nagrać. Wpisz zdanie.');
  }
}

function stopListening(cancelled) {
  cancelListen = cancelled;
  if (recognizer) {
    try {
      recognizer.stop();
    } catch {
      recognizer = null;
      ui.listening = false;
      paintListen();
    }
  }
  if (recorder && recorder.state === 'recording') {
    try {
      recorder.stop();
    } catch {
      cleanupStream();
      ui.listening = false;
      paintListen();
    }
  }
}

function cleanupStream() {
  recorderStream?.getTracks().forEach((track) => track.stop());
  recorderStream = null;
  recorder = null;
}

function abandonRecognizer() {
  if (!recognizer) return;
  cancelListen = true;
  try {
    recognizer.onend = null;
    recognizer.abort();
  } catch {
    /* already stopped */
  }
  recognizer = null;
  ui.listening = false;
}

async function transcribeBlob(blob, type) {
  if (!activeKey(settings)) {
    setStatus('Nagranie umiem wysłać tylko z kluczem API. Wpisz zdanie albo dodaj klucz.');
    return;
  }
  ui.busy = true;
  paintListen();
  setStatus('Rozpoznaję nagranie…');
  try {
    const text = await transcribeAudio({
      provider: settings.provider,
      apiKey: activeKey(settings),
      audio: blob,
      mime: type,
      filename: `speech.${extensionForMime(type)}`,
    });
    setStatus('');
    await onHeard(text);
  } catch (err) {
    ui.error = polishError(err);
    setStatus('');
    const node = document.querySelector('.screen');
    if (node && !node.querySelector('.error')) node.insertBefore(el('p', 'error', ui.error), node.querySelector('.dock'));
  } finally {
    ui.busy = false;
    paintListen();
  }
}

async function onHeard(text) {
  const clean = text.trim();
  if (!clean) {
    setStatus('Nic nie usłyszałem. Spróbuj jeszcze raz albo wpisz.');
    return;
  }
  if (settings.confirmBeforeSend) {
    const draft = document.getElementById('draft');
    if (draft) draft.value = clean;
    setStatus('Sprawdź tekst i stuknij Wyślij.');
    return;
  }
  await submitText(clean);
}

async function submitText(text, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean || ui.busy) return;
  const draft = document.getElementById('draft');
  if (draft && !opts.hidden) draft.value = '';
  stopSpeaking();
  abandonRecognizer();
  showMessage({
    id: uid(),
    role: 'user',
    text: clean,
    hidden: Boolean(opts.hidden),
    at: Date.now(),
  });
  ui.busy = true;
  ui.error = '';
  paintListen();
  setStatus(activeKey(settings) ? 'Myślę…' : 'Tryb próbny…');
  try {
    const turn = await produceTurn(clean, opts);
    if (!turn.reply) throw new ProviderError('Pusta odpowiedź.');
    showMessage({
      id: uid(),
      role: 'assistant',
      text: turn.reply,
      corrections: turn.corrections,
      phrases: turn.phrases,
      at: Date.now(),
    });
    refreshPreviousUser();
    const saved = rememberPhrases(turn.phrases);
    if (saved.length) showToast(`Zapisano: ${saved.join(', ')}`);
    setStatus('');
    if (settings.autoSpeak) {
      setStatus('Mówię…');
      try {
        await speak(turn.reply);
      } catch {
        setStatus('Nie udało się odtworzyć głosu. Tekst zostaje na ekranie.');
      }
      if (!ui.listening && !ui.status.startsWith('Nie udało')) setStatus(pathLabel(inputPath()));
    } else {
      setStatus(pathLabel(inputPath()));
    }
  } catch (err) {
    ui.error = polishError(err);
    setStatus('');
    const screen = document.querySelector('.screen');
    if (screen && !screen.querySelector('.error')) {
      screen.insertBefore(el('p', 'error', ui.error), screen.querySelector('.dock'));
    }
  } finally {
    ui.busy = false;
    paintListen();
  }
}

async function produceTurn(userText, opts) {
  if (!activeKey(settings)) return demoReply(opts.hidden ? '' : userText, opts.topicId || null);
  const system = buildSystemPrompt({ level: settings.level, polishHints: settings.polishHints });
  return chatComplete({
    provider: settings.provider,
    apiKey: activeKey(settings),
    model: settings.model || activeModel(settings.provider, ''),
    messages: messagesForApi(messages, system),
  });
}

function rememberPhrases(phrases) {
  const saved = [];
  for (const phrase of phrases || []) {
    const result = upsertPhrase(cards, { ...phrase, source: 'conversation' });
    cards = result.cards;
    if (result.added) saved.push(phrase.en);
  }
  if (saved.length) saveCards(store, cards);
  const due = dueCards(cards).length;
  dueBadge.hidden = due === 0;
  dueBadge.textContent = due > 99 ? '99+' : String(due);
  return saved;
}

function showMessage(message) {
  messages.push(message);
  if (messages.length > 80) messages = messages.slice(-80);
  saveMessages(store, messages);
  const list = document.getElementById('transcript');
  if (!list || message.hidden) return;
  document.getElementById('empty')?.remove();
  list.append(messageView(message, messages.length - 1));
  list.scrollTop = list.scrollHeight;
}

function refreshPreviousUser() {
  const list = document.getElementById('transcript');
  if (!list) return;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.hidden) {
      const node = list.querySelector(`[data-id="${message.id}"]`);
      node?.replaceWith(messageView(message, index));
      return;
    }
    if (message.role === 'assistant') return;
  }
}

function paintListen() {
  const talk = document.getElementById('talk');
  const label = document.getElementById('talk-label');
  const cancel = document.getElementById('cancel-listen');
  const send = document.getElementById('send');
  if (talk) {
    talk.classList.toggle('is-live', ui.listening);
    talk.disabled = ui.busy && !ui.listening;
    talk.setAttribute('aria-pressed', ui.listening ? 'true' : 'false');
  }
  if (label) label.textContent = ui.listening ? 'Stop' : 'Mów';
  if (cancel) cancel.hidden = !ui.listening;
  if (send) send.disabled = ui.busy;
}

function setStatus(text) {
  ui.status = text;
  const node = document.getElementById('status');
  if (node) node.textContent = text;
}

function setLive(text) {
  ui.live = text;
  const node = document.getElementById('live');
  if (node) node.textContent = text;
}

function polishError(err) {
  if (err instanceof ProviderError) {
    if (err.corsBlocked) {
      return 'Przeglądarka zablokowała połączenie. Przy złym kluczu OpenAI czasem tak kończy, zamiast oddać treść błędu. Użyj „Sprawdź klucz” albo sprawdź internet.';
    }
    if (err.status === 401) return 'Klucz odrzucony. Sprawdź, czy jest wklejony w całości.';
    if (err.status === 429) return 'Limit albo brak środków u dostawcy. Zajrzyj do panelu rozliczeń.';
    if (err.status === 404) return 'Nie ma takiego modelu. Wpisz inną nazwę w ustawieniach.';
    if (err.message && err.message !== 'Połączenie przerwane.') return err.message;
  }
  return 'Nie udało się dokończyć. Spróbuj jeszcze raz.';
}

function currentVoice() {
  return settings.provider === 'xai' ? settings.xaiVoice : settings.openaiVoice;
}

async function speak(text, { slow = false } = {}) {
  abandonRecognizer();
  const line = String(text || '').trim();
  if (!line) return;
  const useProvider = settings.voiceMode === 'provider' && activeKey(settings);
  if (useProvider) {
    try {
      const blob = await synthesizeSpeech({
        provider: settings.provider,
        apiKey: activeKey(settings),
        text: line,
        voice: currentVoice(),
      });
      await playBlob(blob);
      return;
    } catch {
      setStatus('Głos dostawcy niedostępny. Czytam głosem telefonu.');
    }
  }
  await speakBrowser(line, { lang: 'en-GB', rate: slow ? 0.9 : 0.96 });
}

async function playBlob(blob) {
  await waitForAudioUnlock();
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  audioEl.src = currentObjectUrl;
  await audioEl.play();
  await new Promise((resolve, reject) => {
    audioEl.onended = resolve;
    audioEl.onerror = () => reject(new Error('audio'));
  });
}

function stopSpeaking() {
  stopBrowserSpeech();
  try {
    audioEl.pause();
  } catch {
    /* ignore */
  }
}

function showToast(text) {
  toast.hidden = false;
  toast.textContent = text;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

boot();
