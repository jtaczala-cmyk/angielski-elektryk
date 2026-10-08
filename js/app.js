import { scoreRing, scenarioArt, welcomeArt } from './art.js';
import { SEED } from './seed.js';
import { dueCards, ensureSeed, removeCard, reviewCard, searchCards, upsertPhrase } from './srs.js';
import { activeKey, clearAll, KEYS, loadCards, loadMessages, loadSessions, loadSettings, saveCards, saveMessages, saveSessions, saveSettings } from './storage.js';
import { SCENARIOS, TOPICS, buildSystemPrompt, messagesForApi, splitHighlights, topicKickoff } from './tutor.js';
import { PROVIDERS, ProviderError, activeModel, chatComplete, synthesizeSpeech, transcribeAudio, verifyKey } from './providers.js';
import {
  describeInputPath,
  extensionForMime,
  getRecognitionCtor,
  isIos,
  isStandalone,
  mediaRecorderSupported,
  pathLabel,
  pickRecorderMime,
  playWithWebAudio,
  recognitionProblem,
  sharedAudioContext,
  speakBrowser,
  startBrowserRecognition,
  stopBrowserSpeech,
  unlockAudio,
  waitForAudioUnlock,
} from './speech.js';
import { demoReply } from './demo.js';
import { buildSessionReport, comparePronunciation, garbleTurn, goalProgress, looksGarbled, weekCounts } from './quality.js';

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
let sessions = loadSessions(store);

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
  speaking: false,
  providerSpeech: true,
  pending: '',
  holdReview: false,
  heardPrompt: false,
  offline: typeof navigator !== 'undefined' && navigator.onLine === false,
  onboard: !store.getItem(KEYS.settings),
  onboardStep: 0,
  scenario: null,
  openReport: '',
  drill: null,
};

let recognizer = null;
let recorder = null;
let recorderChunks = [];
let recorderStream = null;
let cancelListen = false;
let toastTimer = 0;
let currentObjectUrl = '';
let speakGen = 0;
let silenceTimer = 0;
let silenceFrame = 0;
let autoSendTimer = 0;
let recordCap = 0;
let handsFreeArmed = false;

const PRACTICE_KEY = 'ae.practice.v1';
const AVATAR_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="32" fill="#0c2340"/><path d="M10 50c4-14 14-18 22-18s18 4 22 18" fill="#1d4e89"/><circle cx="32" cy="30" r="10" fill="#f0c7a8"/><path d="M14 26c2-14 12-20 18-20s16 6 18 20c-5 2-10 4-18 4s-13-2-18-4z" fill="#e4c36a"/><rect x="18" y="24" width="28" height="5" rx="2" fill="#c8102e"/></svg>';
const TITLES = { talk: 'Rozmowa', cards: 'Słówka', settings: 'Ustawienia', history: 'Raporty' };
const STARTERS = [
  'I am electrician and I work in Norway since two years.',
  'Yesterday I change the consumer unit.',
  'Can we talk about a toolbox talk?',
];

function routeFromHash() {
  const hash = location.hash.replace('#', '');
  if (hash === '/slowka') return 'cards';
  if (hash === '/ustawienia') return 'settings';
  if (hash === '/historia') return 'history';
  return 'talk';
}

function hashFor(route) {
  if (route === 'cards') return '#/slowka';
  if (route === 'settings') return '#/ustawienia';
  if (route === 'history') return '#/historia';
  return '#/';
}

function autoSendEnabled() {
  return settings.sendMode !== 'manual' && !settings.confirmBeforeSend;
}

function buzz(pattern = 12) {
  try {
    if (navigator.userActivation && navigator.userActivation.isActive === false) return;
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    /* iOS treats this as a no-op */
  }
}

function clearSilence() {
  window.clearTimeout(silenceTimer);
  silenceTimer = 0;
  if (silenceFrame) window.cancelAnimationFrame(silenceFrame);
  silenceFrame = 0;
  window.clearTimeout(recordCap);
  recordCap = 0;
}

function cancelAutoSend() {
  window.clearTimeout(autoSendTimer);
  autoSendTimer = 0;
}

function idleStatus() {
  const path = inputPath();
  if (path === 'type') return 'Wpisz zdanie po angielsku i stuknij strzałkę.';
  if (!autoSendEnabled()) return 'Stuknij Mów, a potem Stop.';
  return 'Stuknij Mów. Gdy zamilkniesz, pokażę tekst i wyślę.';
}

function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function localDay(time = Date.now()) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function practiceDays() {
  const days = new Set();
  try {
    const saved = JSON.parse(store.getItem(PRACTICE_KEY) || '[]');
    if (Array.isArray(saved)) saved.forEach((day) => days.add(String(day)));
  } catch {
    /* ignore a broken local note */
  }
  for (const card of cards) {
    if (card.lastReviewed) days.add(localDay(card.lastReviewed));
  }
  for (const message of messages) {
    if (message.role === 'user' && !message.hidden && message.at) days.add(localDay(message.at));
  }
  return days;
}

function markPractice(time = Date.now()) {
  const day = localDay(time);
  let saved = [];
  try {
    const parsed = JSON.parse(store.getItem(PRACTICE_KEY) || '[]');
    if (Array.isArray(parsed)) saved = parsed.map(String);
  } catch {
    saved = [];
  }
  if (!saved.includes(day)) {
    saved.push(day);
    store.setItem(PRACTICE_KEY, JSON.stringify(saved.slice(-400)));
  }
}

function streakCount() {
  const days = practiceDays();
  const cursor = new Date();
  if (!days.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (days.has(localDay(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function learnedCount() {
  return cards.filter((card) => Number(card.repetitions) > 0).length;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Dzień dobry, Jacek';
  if (hour < 18) return 'Cześć, Jacek';
  return 'Dobry wieczór, Jacek';
}

function statBlock(label, value) {
  const node = el('div', 'stat');
  node.append(el('b', null, value));
  node.append(el('span', null, label));
  return node;
}

function statsRow() {
  const row = el('div', 'stats');
  row.append(
    statBlock('Seria', String(streakCount())),
    statBlock('Opanowane', String(learnedCount())),
    statBlock('Na dziś', String(dueCards(cards).length)),
  );
  return row;
}

function jackMark() {
  const flag = el('span', 'jack');
  flag.setAttribute('aria-hidden', 'true');
  flag.innerHTML = '<svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#012169"/><path d="M0 0 60 40M60 0 0 40" stroke="#fff" stroke-width="8"/><path d="M0 0 60 40M60 0 0 40" stroke="#c8102e" stroke-width="4"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="14"/><path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="8"/></svg>';
  return flag;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function shouldShowHeard() {
  if (!settings.autoSpeak) return false;
  if (settings.heardSam === 'yes') return false;
  return ui.heardPrompt || settings.heardSam === 'no';
}

function heardBanner() {
  const box = el('div', 'heard');
  box.id = 'heard-banner';
  box.setAttribute('role', 'status');
  box.append(el('p', null, settings.heardSam === 'no'
    ? 'Sama nie było słychać. Na iPhonie wyłącz tryb cichy — przełącznik z boku. Safari go nie widzi.'
    : 'Słyszysz Sama? Jeśli nie, wyłącz tryb cichy. Na iPhonie to przełącznik z boku — Safari go nie widzi.'));
  const row = el('div', 'heard-actions');
  const yes = el('button', 'send', 'Słyszę');
  yes.type = 'button';
  yes.addEventListener('click', () => {
    settings.heardSam = 'yes';
    ui.heardPrompt = false;
    saveSettings(store, settings);
    render();
  });
  const no = el('button', 'side-btn', 'Nie słyszę');
  no.type = 'button';
  no.addEventListener('click', () => {
    settings.heardSam = 'no';
    ui.heardPrompt = true;
    saveSettings(store, settings);
    render();
  });
  row.append(yes, no);
  box.append(row);
  return box;
}

function offlineBanner() {
  return el('p', 'banner', 'Jesteś offline. Słówka i raporty są na telefonie. Rozmowa z modelem poczeka na sieć. Tryb próbny działa.');
}

function goalStrip() {
  const progress = goalProgress(messages, settings.dailyGoal);
  const box = el('div', 'goal');
  const top = el('div', 'goal-top');
  top.append(el('strong', null, progress.met ? 'Cel na dziś zrobiony.' : `Dziś ${progress.done} z ${progress.goal}`));
  top.append(el('span', null, `Seria ${streakCount()}`));
  box.append(top);
  const meter = el('div', 'meter');
  const fill = el('span');
  fill.style.width = `${Math.round(progress.ratio * 100)}%`;
  meter.append(fill);
  box.append(meter);
  return box;
}

function weekChart() {
  const counts = weekCounts(messages);
  const max = Math.max(1, ...counts.map((item) => item.count));
  const chart = el('div', 'week');
  for (const item of counts) {
    const col = el('div', 'week-col');
    const bar = el('span', 'bar');
    bar.style.height = `${Math.max(8, Math.round((item.count / max) * 100))}%`;
    if (!item.count) bar.classList.add('is-empty');
    col.append(bar, el('small', null, item.label));
    col.title = `${item.label}: ${item.count}`;
    chart.append(col);
  }
  return chart;
}

function scenarioGrid() {
  const grid = el('div', 'scenario-grid');
  for (const scenario of SCENARIOS) {
    const button = el('button', 'scenario-card');
    button.type = 'button';
    const art = el('span', 'scenario-art');
    art.innerHTML = scenarioArt(scenario.id);
    button.append(art, el('strong', null, scenario.pl), el('span', null, scenario.hint));
    button.addEventListener('click', () => startScenario(scenario));
    grid.append(button);
  }
  return grid;
}

function reviewBar() {
  const box = el('div', 'review');
  box.id = 'review';
  if (!ui.holdReview) box.append(el('div', 'review-wait'));
  const caption = el('p', 'review-label', ui.holdReview ? 'Usłyszałem. Wyślij albo popraw.' : 'Usłyszałem. Za chwilę wyślę.');
  const field = document.createElement('textarea');
  field.id = 'review-text';
  field.rows = 2;
  field.value = ui.pending;
  field.setAttribute('aria-label', 'Rozpoznany tekst');
  field.addEventListener('input', () => {
    ui.pending = field.value;
    ui.holdReview = true;
    cancelAutoSend();
    box.querySelector('.review-wait')?.remove();
    caption.textContent = 'Poprawiasz. Stuknij Wyślij, gdy będzie dobrze.';
    setStatus('Poprawiasz tekst. Stuknij Wyślij.');
  });
  const send = el('button', 'send wide', 'Wyślij');
  send.type = 'button';
  send.id = 'review-send';
  send.addEventListener('click', () => {
    const text = field.value || ui.pending;
    cancelAutoSend();
    ui.pending = '';
    submitText(text);
  });
  const alt = el('div', 'review-alt');
  const edit = el('button', 'text-btn', 'Popraw');
  edit.type = 'button';
  edit.addEventListener('click', () => {
    ui.holdReview = true;
    cancelAutoSend();
    box.querySelector('.review-wait')?.remove();
    caption.textContent = 'Popraw tekst i stuknij Wyślij.';
    field.focus();
  });
  const again = el('button', 'text-btn', 'Jeszcze raz');
  again.type = 'button';
  again.addEventListener('click', () => {
    cancelAutoSend();
    ui.pending = '';
    ui.holdReview = false;
    render();
    onTalk();
  });
  alt.append(edit, again);
  box.append(caption, field, send, alt);
  return box;
}

function armAutoSend() {
  cancelAutoSend();
  const started = Date.now();
  const wait = 2200;
  const tick = () => {
    if (!ui.pending || ui.holdReview) return;
    const left = wait - (Date.now() - started);
    const bar = document.querySelector('.review-wait');
    if (bar) bar.style.setProperty('--wait', String(Math.max(0, Math.min(1, 1 - left / wait))));
    if (left <= 0) {
      const text = (document.getElementById('review-text')?.value || ui.pending).trim();
      ui.pending = '';
      submitText(text);
      return;
    }
    autoSendTimer = window.setTimeout(tick, 80);
  };
  tick();
}

function watchRecorderSilence(stream) {
  try {
    const ctx = sharedAudioContext();
    if (!ctx || !stream) return;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let quietSince = 0;
    let heardVoice = false;
    const loop = () => {
      if (!ui.listening || !recorder) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const sample = (data[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > 0.025) {
        heardVoice = true;
        quietSince = 0;
        if (!ui.live) setLive('Słyszę Cię…');
      } else if (heardVoice) {
        if (!quietSince) quietSince = now;
        else if (now - quietSince > 1300) {
          stopListening(false);
          return;
        }
      }
      silenceFrame = window.requestAnimationFrame(loop);
    };
    silenceFrame = window.requestAnimationFrame(loop);
  } catch {
    /* Stop still ends the recording if the analyser cannot start. */
  }
}

async function submitGarbled(text) {
  if (ui.busy) return;
  markPractice();
  showMessage({ id: uid(), role: 'user', text, at: Date.now() });
  const turn = garbleTurn();
  showMessage({
    id: uid(),
    role: 'assistant',
    text: turn.reply,
    corrections: [],
    phrases: [],
    hint_pl: 'To brzmiało jak pomyłka dyktowania. Powiedz jeszcze raz, wolniej, jednym zdaniem.',
    at: Date.now(),
  });
  if (settings.autoSpeak) {
    try {
      await speak(turn.reply);
      if (settings.heardSam !== 'yes') ui.heardPrompt = true;
    } catch {
      setStatus('Nie udało się odtworzyć głosu. Tekst zostaje na ekranie.');
    }
  }
  setStatus('Powiedz to jeszcze raz albo popraw tekst na dole.');
  if (ui.route === 'talk') render();
}

function maybeHandsFree() {
  if (!settings.handsFree || !handsFreeArmed) return;
  window.setTimeout(() => {
    if (!handsFreeArmed || ui.busy || ui.listening || ui.pending || ui.route !== 'talk' || ui.onboard || ui.error) {
      handsFreeArmed = false;
      return;
    }
    onTalk();
  }, 450);
}

function finishSession() {
  const report = buildSessionReport({ messages, scenario: ui.scenario, level: settings.level });
  if (!report.turns) {
    showProblem('Najpierw powiedz chociaż jedno zdanie. Potem stuknij Raport.');
    return;
  }
  sessions = [report, ...sessions.filter((item) => item.id !== report.id)].slice(0, 40);
  saveSessions(store, sessions);
  ui.openReport = report.id;
  showToast('Raport zapisany.');
  if (location.hash !== '#/historia') location.hash = '#/historia';
  else {
    ui.route = 'history';
    render();
  }
}

async function startScenario(scenario) {
  if (ui.busy) return;
  ui.scenario = scenario;
  unlockAudio(audioEl);
  stopSpeaking();
  showMessage({
    id: uid(),
    role: 'note',
    text: `${scenario.pl}. Cel: ${scenario.goal}`,
    at: Date.now(),
  });
  await submitText(topicKickoff(scenario), { hidden: true, topicId: scenario.id });
}

function renderOnboarding() {
  const screen = el('section', 'screen onboard');
  const art = el('div', 'onboard-art');
  art.innerHTML = welcomeArt();
  const sheet = el('div', 'onboard-sheet');
  const step = ui.onboardStep;
  sheet.append(el('p', 'dots', `${step + 1} z 3`));
  if (step === 0) {
    sheet.append(el('h2', null, 'Na jakim jesteś poziomie?'));
    sheet.append(el('p', null, 'Sam dopasuje zdania. Zawsze możesz to zmienić u góry.'));
    const levels = el('div', 'segment');
    for (const level of ['A2', 'B1', 'B2', 'C1']) {
      const button = el('button', null, level);
      button.type = 'button';
      button.setAttribute('aria-pressed', settings.level === level ? 'true' : 'false');
      button.addEventListener('click', () => {
        settings.level = level;
        levelSelect.value = level;
        render();
      });
      levels.append(button);
    }
    sheet.append(levels);
    const next = el('button', 'send wide', 'Dalej');
    next.type = 'button';
    next.addEventListener('click', () => {
      ui.onboardStep = 1;
      render();
    });
    sheet.append(next);
  } else if (step === 1) {
    sheet.append(el('h2', null, 'Skąd brać odpowiedzi?'));
    sheet.append(el('p', null, 'Klucz zostaje tylko w tym telefonie. Bez klucza jest tryb próbny.'));
    const provider = document.createElement('select');
    provider.id = 'onboard-provider';
    for (const spec of Object.values(PROVIDERS)) {
      const option = el('option', null, spec.label);
      option.value = spec.id;
      provider.append(option);
    }
    provider.value = settings.provider;
    const field = el('label', 'field', 'Dostawca');
    field.append(provider);
    const key = document.createElement('input');
    key.id = 'onboard-key';
    key.type = 'password';
    key.autocomplete = 'off';
    key.placeholder = 'Klucz, jeśli już masz';
    const keyField = el('label', 'field', 'Klucz (możesz pominąć)');
    keyField.append(key);
    const next = el('button', 'send wide', 'Dalej');
    next.type = 'button';
    next.addEventListener('click', () => {
      settings.provider = provider.value;
      rememberOnboardKey(key.value);
      ui.onboardStep = 2;
      render();
    });
    sheet.append(field, keyField, next);
  } else {
    sheet.append(el('h2', null, 'Żeby słyszeć Sama'));
    sheet.append(el('p', null, 'Jeśli iPhone jest wyciszony, głosu nie będzie. Wyłącz tryb cichy — przełącznik z boku. Potem stuknij czerwony przycisk i mów.'));
    const next = el('button', 'send wide', 'Zaczynamy');
    next.type = 'button';
    next.id = 'onboard-start';
    next.addEventListener('click', finishOnboard);
    sheet.append(next);
  }
  const skip = el('button', 'text-btn onboard-skip', 'Pomiń');
  skip.type = 'button';
  skip.id = 'onboard-skip';
  skip.addEventListener('click', finishOnboard);
  sheet.append(skip);
  screen.append(art, sheet);
  return screen;
}

function rememberOnboardKey(value) {
  const key = String(value || '').trim();
  if (!key) return;
  if (settings.provider === 'xai') settings.xaiKey = key;
  else settings.openaiKey = key;
}

function finishOnboard() {
  const provider = document.getElementById('onboard-provider');
  if (provider?.value) settings.provider = provider.value;
  rememberOnboardKey(document.getElementById('onboard-key')?.value);
  saveSettings(store, settings);
  ui.onboard = false;
  render();
}

function renderHistory() {
  const screen = el('section', 'screen');
  screen.dataset.screen = 'history';
  const scroll = el('div', 'scroll');
  if (ui.offline) scroll.append(offlineBanner());
  const back = el('button', 'text-link', '← Rozmowa');
  back.type = 'button';
  back.addEventListener('click', () => {
    location.hash = '#/';
  });
  scroll.append(back, weekChart());
  const open = sessions.find((item) => item.id === ui.openReport);
  if (open) scroll.append(reportCard(open));
  if (!sessions.length) {
    const done = el('div', 'done');
    done.append(el('h2', null, 'Tu będą raporty.'));
    done.append(el('p', null, 'Porozmawiaj, a na końcu stuknij Raport. Zostanie wynik, poprawki i nowe słowa.'));
    const go = el('button', 'send', 'Do rozmowy');
    go.type = 'button';
    go.addEventListener('click', () => {
      location.hash = '#/';
    });
    done.append(go);
    scroll.append(done);
  } else {
    scroll.append(el('h2', 'history-title', 'Ostatnie sesje'));
    for (const report of sessions) {
      if (open && report.id === open.id) continue;
      const button = el('button', 'history-item');
      button.type = 'button';
      button.append(
        el('strong', null, report.scenarioPl || 'Rozmowa'),
        el('span', null, `${report.score}/100 · ${report.turns} ${report.turns === 1 ? 'zdanie' : 'zdań'}`),
      );
      button.addEventListener('click', () => {
        ui.openReport = report.id;
        render();
      });
      scroll.append(button);
    }
  }
  screen.append(scroll);
  return screen;
}

function reportCard(report) {
  const card = el('article', 'report');
  const head = el('div', 'report-head');
  const ring = el('div', 'ring-wrap');
  ring.innerHTML = scoreRing(report.score);
  const titles = el('div');
  titles.append(el('h2', null, report.scenarioPl || 'Rozmowa'));
  if (report.goal) titles.append(el('p', null, report.goal));
  head.append(ring, titles);
  card.append(head);
  card.append(el('p', 'section-label', 'Co poszło dobrze'));
  for (const line of report.wentWell || []) card.append(el('p', 'report-line', line));
  if (report.corrections?.length) {
    card.append(el('p', 'section-label', 'Najważniejsze poprawki'));
    for (const fix of report.corrections) {
      const line = el('p', 'report-line');
      const better = el('span', null, fix.better);
      better.lang = 'en-GB';
      line.append(better);
      if (fix.why_pl) line.append(el('small', null, fix.why_pl));
      card.append(line);
    }
  }
  if (report.words?.length) {
    card.append(el('p', 'section-label', 'Nowe słowa'));
    const row = el('div', 'phrases');
    for (const word of report.words) {
      const chip = el('span', 'chip', word.en);
      chip.lang = 'en-GB';
      row.append(chip);
    }
    card.append(row);
  }
  const again = el('button', 'send wide', 'Nowa rozmowa');
  again.type = 'button';
  again.addEventListener('click', () => {
    ui.openReport = '';
    newChat();
  });
  card.append(again);
  return card;
}

function drillNote() {
  const note = el('p', `drill drill-${ui.drill?.grade || 'wait'}`, ui.drill?.note || '');
  note.id = 'drill-note';
  return note;
}

function paintDrill() {
  const existing = document.getElementById('drill-note');
  if (existing) existing.replaceWith(drillNote());
}

async function practisePhrase(card) {
  if (ui.busy || ui.listening) return;
  ui.busy = true;
  paintListen();
  ui.drill = { id: card.id, note: 'Słuchaj wzoru…', grade: '' };
  if (!document.getElementById('drill-note')) render();
  else paintDrill();
  try {
    await speak(card.en, { slow: true });
    if (!getRecognitionCtor() || ui.recognitionBroken) {
      ui.drill = { id: card.id, note: 'Posłuchaj wzoru i powtórz na głos. Gdy dyktowanie działa, porównam to, co usłyszę.', grade: '' };
      paintDrill();
      return;
    }
    ui.drill = { id: card.id, note: 'Teraz ty. Powiedz to wyrażenie.', grade: '' };
    paintDrill();
    const heard = await listenOnce();
    const result = comparePronunciation(card.en, heard);
    ui.drill = { id: card.id, note: `${result.note_pl} Usłyszałem: ${heard}`, grade: result.grade };
    buzz(result.grade === 'good' ? 16 : [8, 40, 8]);
    paintDrill();
  } catch {
    ui.drill = { id: card.id, note: 'Nie złapałem głosu. Stuknij Powiedz to jeszcze raz.', grade: 'again' };
    paintDrill();
  } finally {
    ui.busy = false;
    paintListen();
  }
}

function listenOnce() {
  return new Promise((resolve, reject) => {
    let started = false;
    let rec;
    const timer = window.setTimeout(() => {
      try { rec?.stop(); } catch { /* ignore */ }
    }, 7000);
    const watchdog = window.setTimeout(() => {
      if (!started) {
        window.clearTimeout(timer);
        try { rec?.abort(); } catch { /* ignore */ }
        reject(new Error('no-start'));
      }
    }, 2500);
    try {
      rec = startBrowserRecognition({
        continuous: false,
        onStart: () => {
          started = true;
          window.clearTimeout(watchdog);
        },
        onPartial: (text) => {
          if (!ui.drill) return;
          ui.drill.note = text || 'Słucham…';
          paintDrill();
        },
        onError: (code) => {
          if (code === 'aborted' || code === 'no-speech') return;
          window.clearTimeout(timer);
          window.clearTimeout(watchdog);
          reject(new Error(code));
        },
        onEnd: (text) => {
          window.clearTimeout(timer);
          window.clearTimeout(watchdog);
          const heard = String(text || '').trim();
          if (!heard) reject(new Error('empty'));
          else resolve(heard);
        },
      });
    } catch (err) {
      window.clearTimeout(timer);
      window.clearTimeout(watchdog);
      reject(err);
    }
  });
}

function boot() {
  document.documentElement.dataset.font = settings.fontScale || 'md';
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
    if (navigator.serviceWorker.controller) sessionStorage.setItem('ae.had-controller', '1');
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('ae.had-controller') === '1') location.reload();
      sessionStorage.setItem('ae.had-controller', '1');
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('online', () => {
    ui.offline = false;
    render();
  });
  window.addEventListener('offline', () => {
    ui.offline = true;
    render();
  });
  render();
}

function render() {
  document.documentElement.dataset.font = settings.fontScale || 'md';
  title.textContent = ui.onboard ? 'Start' : (TITLES[ui.route] || 'Rozmowa');
  levelSelect.value = settings.level;
  const nav = document.querySelector('.nav');
  if (nav) nav.hidden = ui.onboard;
  const levelWrap = document.querySelector('.level');
  if (levelWrap) levelWrap.hidden = ui.onboard;
  document.querySelectorAll('.nav button').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.route === ui.route ? 'page' : 'false');
  });
  const due = dueCards(cards).length;
  dueBadge.hidden = due === 0;
  dueBadge.textContent = due > 99 ? '99+' : String(due);
  main.replaceChildren();
  if (ui.onboard) {
    main.append(renderOnboarding());
    return;
  }
  if (ui.route === 'talk') main.append(renderTalk());
  else if (ui.route === 'cards') main.append(renderCards());
  else if (ui.route === 'history') main.append(renderHistory());
  else main.append(renderSettings());
}

function inputPath() {
  return describeInputPath({
    inputMode: settings.inputMode,
    hasRecognition: Boolean(getRecognitionCtor()) && !ui.recognitionBroken,
    hasRecorder: mediaRecorderSupported(),
    preferRecorder: isStandalone() || ui.recognitionBroken,
  });
}

function showProblem(text) {
  ui.error = text;
  setStatus(text);
  const screen = document.querySelector('.screen');
  if (!screen) return;
  let node = screen.querySelector('.error');
  if (!node) {
    node = el('p', 'error', text);
    const dock = screen.querySelector('.dock');
    if (dock) screen.insertBefore(node, dock);
    else screen.append(node);
  } else node.textContent = text;
}

function clearProblem() {
  ui.error = '';
  document.querySelector('.screen .error')?.remove();
}

function renderTalk() {
  const screen = el('section', 'screen');
  screen.dataset.screen = 'talk';
  if (ui.offline) screen.append(offlineBanner());
  if (!activeKey(settings)) {
    const banner = el('p', 'banner');
    banner.append(el('strong', null, 'Tryb próbny. '));
    banner.append('Bez klucza odpowiadam z telefonu, nie z modelu. Pisz na dole albo dodaj klucz w Ustawieniach.');
    screen.append(banner);
  }
  const hasChat = messages.some((message) => !message.hidden);
  if (hasChat) {
    const topics = el('div', 'topics');
    const report = el('button', 'chip-strong', 'Raport');
    report.type = 'button';
    report.addEventListener('click', finishSession);
    topics.append(report);
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
  }

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
  if (shouldShowHeard()) screen.append(heardBanner());

  const dock = el('div', 'dock');
  if (ui.pending) dock.append(reviewBar());
  const live = el('p', 'live', ui.live);
  live.id = 'live';
  dock.append(live);
  if (!ui.pending) dock.append(composerBlock(), talkBlock());
  const status = el('p', 'path', ui.status || idleStatus());
  status.id = 'status';
  status.setAttribute('aria-live', 'polite');
  dock.append(status);
  screen.append(dock);
  queueMicrotask(revealLatest);
  return screen;
}

function composerBlock() {
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
  return composer;
}

function talkBlock() {
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
  talk.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-7 9a1 1 0 0 0-2 0 9 9 0 0 0 8 8.9V22H9v2h6v-2h-2v-1.1A9 9 0 0 0 21 12a1 1 0 0 0-2 0 7 7 0 0 1-14 0z"/></svg><span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';
  const label = el('span', null, ui.listening ? 'Stop' : 'Mów');
  label.id = 'talk-label';
  talk.append(label);
  talk.addEventListener('click', onTalk);
  row.append(cancel, talk);
  return row;
}

function emptyState() {
  const box = el('div', 'home');
  box.id = 'empty';
  const hero = el('div', 'hero');
  hero.append(jackMark());
  hero.append(el('p', 'hero-kicker', greeting()));
  hero.append(el('h2', null, 'Mów, jak na budowie.'));
  hero.append(el('p', null, 'Czerwony przycisk na dole. Powiedz zdanie po angielsku. Gdy zamilkniesz, pokażę tekst i wyślę.'));
  box.append(hero);
  box.append(goalStrip());
  box.append(el('p', 'section-label', 'Wybierz sytuację'));
  box.append(scenarioGrid());
  box.append(statsRow());
  box.append(el('p', 'section-label', 'Ostatnie 7 dni'));
  box.append(weekChart());
  const free = TOPICS.find((topic) => topic.id === 'free');
  const freeBtn = el('button', 'text-link', 'Albo wolny temat, bez scenariusza');
  freeBtn.type = 'button';
  freeBtn.addEventListener('click', () => startTopic(free));
  const reports = el('button', 'text-link', sessions.length ? `Raporty (${sessions.length})` : 'Raporty');
  reports.type = 'button';
  reports.addEventListener('click', () => { location.hash = '#/historia'; });
  const links = el('div', 'home-links');
  links.append(freeBtn, reports);
  box.append(links);
  const suggest = el('div', 'suggest');
  suggest.append(el('p', 'section-label', 'Albo stuknij zdanie'));
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
  if (message.hint_pl) {
    const hint = el('p', 'hint-pl', message.hint_pl);
    hint.lang = 'pl';
    article.append(hint);
  }
  if (fixes.length) article.append(fixesView(fixes));
  if (message.role === 'assistant') {
    const who = el('div', 'tutor');
    const avatar = el('span', 'avatar');
    avatar.innerHTML = AVATAR_SVG;
    if (ui.speaking) avatar.classList.add('is-speaking');
    who.append(avatar, el('span', 'tutor-name', 'Sam'));
    article.prepend(who);
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
  stats.append(statsRow(), tabs);
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
  wrap.append(el('p', 'path queue-left', `Zostało ${ui.queue.length}`));
  const scene = el('div', 'flash-scene');
  const inner = el('div', ui.flipped ? 'flash-inner is-flipped' : 'flash-inner');
  const front = el('div', 'flash-face front');
  front.append(el('p', 'meta', card.source === 'seed' ? 'Zestaw startowy' : 'Z rozmowy'));
  const word = el('h2', 'word', card.en);
  word.lang = 'en-GB';
  front.append(word);
  const back = el('div', 'flash-face back');
  const gloss = el('p', 'gloss', card.pl);
  gloss.lang = 'pl';
  back.append(gloss);
  if (card.example) {
    const example = el('p', 'example', card.example);
    example.lang = 'en-GB';
    back.append(example);
  }
  const practise = el('button', 'text-btn', 'Powiedz to');
  practise.type = 'button';
  practise.addEventListener('click', (event) => {
    event.stopPropagation();
    unlockAudio(audioEl);
    practisePhrase(card);
  });
  back.append(practise);
  if (ui.drill?.id === card.id) back.append(drillNote());
  inner.append(front, back);
  scene.append(inner);
  wrap.append(scene);
  const actions = el('div', 'card-actions');
  const flip = el('button', 'text-btn', ui.flipped ? 'Ukryj tłumaczenie' : 'Pokaż tłumaczenie');
  flip.type = 'button';
  const say = el('button', 'text-btn', 'Wymowa');
  say.type = 'button';
  say.addEventListener('click', () => {
    unlockAudio(audioEl);
    const line = card.example ? `${card.en}. ${card.example}` : card.en;
    speak(line, { slow: true });
  });
  const grades = el('div', 'grades');
  grades.hidden = !ui.flipped;
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
  flip.addEventListener('click', () => {
    if (inner.classList.contains('is-flipping')) return;
    const apply = () => {
      ui.flipped = !ui.flipped;
      inner.classList.toggle('is-flipped', ui.flipped);
      flip.textContent = ui.flipped ? 'Ukryj tłumaczenie' : 'Pokaż tłumaczenie';
      grades.hidden = !ui.flipped;
      inner.classList.remove('is-revealed');
      void inner.offsetWidth;
      inner.classList.add('is-revealed');
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply();
      return;
    }
    inner.classList.add('is-flipping');
    window.setTimeout(() => {
      inner.classList.remove('is-flipping');
      apply();
    }, 160);
  });
  actions.append(flip, say);
  wrap.append(actions, grades);
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
  const scene = document.querySelector('.flash-scene');
  if (scene) scene.classList.add(grade < 3 ? 'is-miss' : 'is-hit');
  window.setTimeout(() => {
    markPractice();
    cards = cards.map((card) => (card.id === id ? reviewCard(card, grade) : card));
    saveCards(store, cards);
    ui.queue = ui.queue.filter((item) => item !== id);
    if (grade < 3) ui.queue.push(id);
    ui.flipped = false;
    render();
  }, scene ? 220 : 0);
}

function probeRecognition() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const rec = startBrowserRecognition({
        onStart: () => {
          try { rec.abort(); } catch { /* ignore */ }
          done(true);
        },
        onError: () => done(false),
        onEnd: () => done(false),
      });
      window.setTimeout(() => {
        try { rec.abort(); } catch { /* ignore */ }
        done(false);
      }, 1500);
    } catch {
      done(false);
    }
  });
}

async function diagnose(button, report) {
  button.disabled = true;
  report.hidden = false;
  const lines = [];
  const standalone = isStandalone();
  lines.push(standalone ? 'Tryb: aplikacja z ekranu początkowego.' : 'Tryb: karta Safari.');
  if (!getRecognitionCtor()) lines.push('Dyktowanie: brak w tej przeglądarce. Zostaje pisanie, a z kluczem także nagranie.');
  else if (standalone) lines.push('Dyktowanie: API jest, ale z ikony na iPhonie często milczy. Z kluczem nagram dźwięk (audio/mp4).');
  else {
    const started = await probeRecognition();
    lines.push(started
      ? 'Dyktowanie: wystartowało. Mów po angielsku po stuknięciu Mów.'
      : mediaRecorderSupported()
        ? 'Dyktowanie: nie wystartowało. Z kluczem nagram dźwięk, bez klucza wpisz zdanie.'
        : 'Dyktowanie: nie wystartowało. Zostaje pisanie.');
  }
  if (!mediaRecorderSupported()) lines.push('Nagranie: ta przeglądarka go nie umie.');
  else {
    const mime = pickRecorderMime((type) => {
      try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
    }, { ios: isIos() });
    lines.push(`Nagranie: jest, format ${mime || 'domyślny przeglądarki'}.`);
  }
  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 8000);
      }),
    ]);
    stream.getTracks().forEach((track) => track.stop());
    lines.push('Mikrofon: zgoda jest.');
  } catch (err) {
    lines.push(err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
      ? 'Mikrofon: odmowa. Zezwól w Ustawienia → Safari → Mikrofon. Z ikony na ekranie: Ustawienia → Elektryk EN.'
      : err?.name === 'TimeoutError'
        ? 'Mikrofon: przeglądarka nie odpowiedziała. Zezwól na mikrofon w ustawieniach iPhone’a i stuknij jeszcze raz.'
        : `Mikrofon: nie działa (${err?.name || 'błąd'}).`);
  }
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) lines.push('Głos iPhone’a: brak.');
  else {
    try {
      unlockAudio();
      await speakBrowser('Test.', { lang: 'en-GB', rate: 1 });
      lines.push('Głos iPhone’a: próba „Test” skończona. Jeśli była cisza, włącz dźwięk i stuknij jeszcze raz.');
    } catch {
      lines.push('Głos iPhone’a: nie zagrał. Włącz dźwięk, stuknij ekran i spróbuj ponownie.');
    }
  }
  const key = activeKey(settings);
  if (!key) {
    lines.push('Klucz: brak. Pisanie działa w trybie próbnym (odpowiedź z telefonu, nie z modelu). Klucz wklejasz poniżej — OpenAI albo xAI.');
  } else {
    try {
      const result = await verifyKey({ provider: settings.provider, apiKey: key });
      lines.push(result.ok
        ? `Klucz ${settings.provider === 'xai' ? 'xAI' : 'OpenAI'}: działa.`
        : `Klucz odrzucony (${result.status}). ${result.message || 'Sprawdź, czy wkleiłeś go w całości.'}`);
    } catch (err) {
      lines.push(polishError(err));
    }
  }
  if (settings.provider === 'xai') {
    lines.push('xAI: rozmowa idzie do api.x.ai. Gdy nagranie albo głos dostawcy odpadnie, zostaje pisanie i głos iPhone’a (en-GB).');
  }
  ui.diagnostics = lines.join('\n');
  report.textContent = ui.diagnostics;
  button.disabled = false;
}

function renderSettings() {
  const screen = el('section', 'screen');
  screen.dataset.screen = 'settings';
  const scroll = el('div', 'scroll');

  const doctor = el('section', 'panel');
  doctor.append(el('h2', null, 'Czy działa?'));
  doctor.append(el('p', null, 'Sprawdza mikrofon, dyktowanie, głos iPhone’a i klucz. Wynik zostaje na tym ekranie.'));
  const test = el('button', 'send', 'Sprawdź telefon');
  test.type = 'button';
  test.id = 'diagnose';
  const report = el('p', 'diagnostics', ui.diagnostics || '');
  report.id = 'diagnostics';
  if (!ui.diagnostics) report.hidden = true;
  test.addEventListener('click', () => diagnose(test, report));
  doctor.append(test, report);
  scroll.append(doctor);

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
  talk.append(toggle('Wysyłaj sam, gdy zamilknę', settings.sendMode !== 'manual', (value) => {
    settings.sendMode = value ? 'auto' : 'manual';
    saveSettings(store, settings);
  }));
  talk.append(toggle('Zawsze pytaj przed wysłaniem', settings.confirmBeforeSend, (value) => {
    settings.confirmBeforeSend = value;
    saveSettings(store, settings);
  }));
  talk.append(toggle('Po odpowiedzi Sama słuchaj znowu', settings.handsFree, (value) => {
    settings.handsFree = value;
    saveSettings(store, settings);
  }));
  talk.append(el('p', 'help', 'Przy włączonym wysyłaniu cisza kończy zdanie. Masz chwilę, żeby poprawić tekst. Rozmowa bez rąk na iPhonie czasem potrzebuje stuknięcia Mów — wtedy napiszę, co zrobić.'));
  const goalField = el('label', 'field', 'Cel dzienny');
  const goal = document.createElement('select');
  for (const [value, label] of [['3', '3 zdania'], ['5', '5 zdań'], ['8', '8 zdań']]) {
    const option = el('option', null, label);
    option.value = value;
    goal.append(option);
  }
  goal.value = String(settings.dailyGoal || 5);
  goal.addEventListener('change', () => {
    settings.dailyGoal = Number(goal.value);
    saveSettings(store, settings);
  });
  goalField.append(goal);
  talk.append(goalField);
  const fontField = el('div', 'field');
  fontField.append(el('span', null, 'Wielkość tekstu'));
  const fonts = el('div', 'segment');
  for (const [value, label] of [['sm', 'Mniejszy'], ['md', 'Zwykły'], ['lg', 'Większy']]) {
    const button = el('button', null, label);
    button.type = 'button';
    button.setAttribute('aria-pressed', settings.fontScale === value ? 'true' : 'false');
    button.addEventListener('click', () => {
      settings.fontScale = value;
      saveSettings(store, settings);
      render();
    });
    fonts.append(button);
  }
  fontField.append(fonts);
  talk.append(fontField);
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
  talk.append(el('p', 'help', 'W Safari na iPhonie najpierw dyktowanie (en-GB). Włącz je: Ustawienia → Ogólne → Klawiatura → Dyktowanie, język English (UK). Z ikony na ekranie początkowym dyktowanie często milczy, więc nagrywam audio/mp4 i wysyłam je do dostawcy — do tego trzeba klucza. Gdy xAI nie przyjmie nagrania albo głosu, zostaje pisanie i głos iPhone’a. Pisanie jest zawsze pod ręką.'));
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
  phone.append(el('p', null, 'Dodaj stronę do ekranu początkowego: Udostępnij, potem „Do ekranu początkowego”. Z ikony mikrofon idzie nagraniem i potrzebuje klucza. W Safari, bez ikony, najpierw próbuje dyktowania. Pisanie na dole działa zawsze. Pierwsze stuknięcie włącza dźwięk.'));
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
    store.removeItem(PRACTICE_KEY);
    settings = loadSettings(store);
    cards = ensureSeed([], SEED).cards;
    saveCards(store, cards);
    messages = [];
    sessions = [];
    ui.scenario = null;
    ui.queueReady = false;
    ui.formNote = '';
    ui.onboard = true;
    ui.onboardStep = 0;
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
  if (messages.length && !window.confirm('Zacząć nową rozmowę? Słówka i raporty zostają.')) return;
  messages = [];
  saveMessages(store, messages);
  ui.scenario = null;
  ui.pending = '';
  ui.error = '';
  ui.live = '';
  cancelAutoSend();
  stopListening(true);
  stopSpeaking();
  if (location.hash !== '#/') location.hash = '#/';
  else {
    ui.route = 'talk';
    render();
  }
}

async function startTopic(topic) {
  if (ui.busy) return;
  ui.scenario = { id: topic.id, pl: topic.pl, goal: topic.goal || '' };
  unlockAudio(audioEl);
  stopSpeaking();
  showMessage({ id: uid(), role: 'note', text: `Temat: ${topic.pl}`, at: Date.now() });
  await submitText(topicKickoff(topic), { hidden: true, topicId: topic.id });
}

function sendDraft() {
  const draft = document.getElementById('draft');
  const text = draft ? draft.value : '';
  cancelAutoSend();
  ui.pending = '';
  unlockAudio(audioEl);
  submitText(text);
}

async function onTalk() {
  unlockAudio();
  stopSpeaking();
  if (ui.busy) return;
  if (ui.listening) {
    stopListening(false);
    return;
  }
  clearProblem();
  const path = inputPath();
  if (path === 'record' && !activeKey(settings)) {
    showProblem('Nagranie mogę wysłać tylko z kluczem API. Wpisz zdanie na dole albo dodaj klucz: Ustawienia → Klucz API.');
    document.getElementById('draft')?.focus();
    return;
  }
  if (path === 'type') {
    showProblem('Na tym telefonie zostaje pisanie. Wpisz zdanie i stuknij strzałkę.');
    document.getElementById('draft')?.focus();
    return;
  }
  if (path === 'browser') startRecognition();
  else startRecording();
}

function startRecognition() {
  cancelListen = false;
  ui.listening = true;
  ui.pending = '';
  cancelAutoSend();
  paintListen();
  buzz(10);
  const auto = autoSendEnabled();
  setStatus(auto ? 'Słucham… zamilknij, a pokażę tekst.' : 'Słucham… stuknij Stop, gdy skończysz.');
  setLive('');
  let started = false;
  let watchdog = 0;
  const fail = (code) => {
    window.clearTimeout(watchdog);
    clearSilence();
    if (!ui.listening && code !== 'no-start') return;
    cancelListen = true;
    const gestureMiss = handsFreeArmed && (code === 'not-allowed' || code === 'service-not-allowed');
    ui.recognitionBroken = !gestureMiss && code !== 'no-speech';
    try {
      recognizer?.abort();
    } catch {
      /* already stopped */
    }
    recognizer = null;
    ui.listening = false;
    paintListen();
    const polite = handsFreeArmed && (code === 'not-allowed' || code === 'service-not-allowed')
      ? 'iPhone chce stuknięcia. Stuknij Mów, żeby powiedzieć następną kwestię.'
      : recognitionProblem(code, {
        standalone: isStandalone(),
        hasKey: Boolean(activeKey(settings)),
        hasRecorder: mediaRecorderSupported(),
      });
    handsFreeArmed = false;
    showProblem(polite);
    document.getElementById('draft')?.focus();
  };
  try {
    recognizer = startBrowserRecognition({
      continuous: !auto,
      onStart: () => {
        started = true;
        window.clearTimeout(watchdog);
      },
      onPartial: (text) => {
        setLive(text);
        if (!auto || !text) return;
        window.clearTimeout(silenceTimer);
        silenceTimer = window.setTimeout(() => {
          try { recognizer?.stop(); } catch { /* already ended */ }
        }, 1400);
      },
      onError: (code) => {
        if (code === 'aborted') return;
        if (code === 'no-speech') {
          cancelListen = true;
          clearSilence();
          handsFreeArmed = false;
          showProblem(recognitionProblem('no-speech'));
          return;
        }
        fail(code);
      },
      onEnd: (text) => {
        window.clearTimeout(watchdog);
        clearSilence();
        recognizer = null;
        const heard = (text || ui.live || '').trim();
        ui.listening = false;
        paintListen();
        setLive('');
        if (cancelListen || ui.error) {
          cancelListen = false;
          handsFreeArmed = false;
          return;
        }
        if (!started) {
          fail('no-start');
          return;
        }
        onHeard(heard);
      },
    });
    watchdog = window.setTimeout(() => {
      if (!started && ui.listening) fail('no-start');
    }, 2500);
  } catch {
    fail('no-recognition');
  }
}

function openRecorder(stream) {
  const ios = isIos();
  const detected = pickRecorderMime((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }, { ios });
  const attempts = [];
  if (detected) attempts.push(detected);
  if (ios && detected !== 'audio/mp4') attempts.push('audio/mp4');
  attempts.push('');
  let lastError = null;
  for (const type of attempts) {
    try {
      const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      return { recorder: rec, mime: type || rec.mimeType || (ios ? 'audio/mp4' : '') };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('recorder');
}

async function startRecording() {
  cancelListen = false;
  ui.listening = true;
  ui.pending = '';
  cancelAutoSend();
  paintListen();
  buzz(10);
  const auto = autoSendEnabled();
  setStatus(auto ? 'Nagrywam… zamilknij, a wyślę.' : 'Nagrywam… stuknij Stop, gdy skończysz.');
  try {
    recorderStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const opened = openRecorder(recorderStream);
    recorder = opened.recorder;
    const mime = opened.mime;
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
        if (!ui.error) setStatus(pathLabel(inputPath()));
        return;
      }
      if (blob.size < 64) {
        showProblem('Nagranie jest puste. Mów sekundę dłużej i stuknij Stop, albo wpisz zdanie.');
        return;
      }
      transcribeBlob(blob, type);
    });
    recorder.start();
    if (auto) watchRecorderSilence(recorderStream);
    recordCap = window.setTimeout(() => {
      if (ui.listening && recorder?.state === 'recording') stopListening(false);
    }, auto ? 20000 : 45000);
  } catch (err) {
    ui.listening = false;
    paintListen();
    cleanupStream();
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showProblem(denied
      ? 'Brak zgody na mikrofon. Zezwól: Ustawienia → Safari → Mikrofon (albo Ustawienia → Elektryk EN, gdy aplikacja jest na ekranie początkowym). Możesz też wpisać zdanie.'
      : 'Nie udało się nagrać. Wpisz zdanie na dole.');
    document.getElementById('draft')?.focus();
  }
}

function stopListening(cancelled) {
  cancelListen = cancelled;
  clearSilence();
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
    showProblem('Nagranie mogę wysłać tylko z kluczem API. Wpisz zdanie na dole albo dodaj klucz: Ustawienia → Klucz API.');
    document.getElementById('draft')?.focus();
    return;
  }
  if (settings.provider === 'xai' && ui.providerSpeech === false) {
    showProblem('xAI nie przyjął nagrania. Wpisz zdanie. Odpowiedź i tak przeczytam głosem iPhone’a.');
    document.getElementById('draft')?.focus();
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
      mime: type || 'audio/mp4',
      filename: `speech.${extensionForMime(type || 'audio/mp4')}`,
    });
    setStatus('');
    await onHeard(text);
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 404 || err.status === 405)) ui.providerSpeech = false;
    const message = err instanceof ProviderError && (err.status === 404 || err.status === 405)
      ? 'Ten dostawca nie ma rozpoznawania mowy. Wpisz zdanie. Głos odpowiedzi przeczytam głosem iPhone’a.'
      : polishError(err);
    showProblem(message);
    document.getElementById('draft')?.focus();
  } finally {
    ui.busy = false;
    paintListen();
  }
}

async function onHeard(text) {
  const clean = text.trim();
  handsFreeArmed = false;
  if (!clean) {
    setStatus('Nic nie usłyszałem. Stuknij Mów jeszcze raz albo wpisz.');
    return;
  }
  if (looksGarbled(clean)) {
    await submitGarbled(clean);
    return;
  }
  ui.pending = clean;
  ui.holdReview = !autoSendEnabled();
  render();
  if (!ui.holdReview) armAutoSend();
  else setStatus('Sprawdź tekst i stuknij Wyślij.');
}

async function submitText(text, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean || ui.busy) return;
  cancelAutoSend();
  ui.pending = '';
  document.getElementById('review')?.remove();
  const draft = document.getElementById('draft');
  if (draft && !opts.hidden) draft.value = '';
  stopSpeaking();
  abandonRecognizer();
  if (!opts.hidden) {
    markPractice();
    buzz(16);
  }
  showMessage({
    id: uid(),
    role: 'user',
    text: clean,
    hidden: Boolean(opts.hidden),
    at: Date.now(),
  });
  ui.busy = true;
  clearProblem();
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
    let spoke = false;
    if (settings.autoSpeak && !opts.hidden) {
      setStatus('Mówię…');
      try {
        await speak(turn.reply);
        spoke = true;
      } catch {
        setStatus('Nie udało się odtworzyć głosu. Tekst zostaje na ekranie. Sprawdź, czy iPhone nie jest wyciszony.');
      }
    }
    if (spoke && settings.heardSam !== 'yes') ui.heardPrompt = true;
    if (!ui.listening && !String(ui.status).startsWith('Nie udało')) setStatus(idleStatus());
    handsFreeArmed = Boolean(settings.handsFree && !opts.hidden && !turn.garbled);
  } catch (err) {
    handsFreeArmed = false;
    showProblem(polishError(err));
  } finally {
    ui.busy = false;
    if (ui.route === 'talk' && !ui.onboard) render();
    else paintListen();
    if (handsFreeArmed) maybeHandsFree();
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
  revealLatest();
}

function refreshPreviousUser() {
  const list = document.getElementById('transcript');
  if (!list) return;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.hidden) {
      const node = list.querySelector(`[data-id="${message.id}"]`);
      node?.replaceWith(messageView(message, index));
      revealLatest();
      return;
    }
    if (message.role === 'assistant') return;
  }
}

function revealLatest() {
  const list = document.getElementById('transcript');
  if (!list) return;
  const users = list.querySelectorAll('.msg-user');
  const target = users[users.length - 1] || list.querySelector('.msg');
  if (!target) return;
  let end = target;
  const next = target.nextElementSibling;
  if (next && next.classList.contains('msg-assistant')) end = next;
  const listRect = list.getBoundingClientRect();
  const turnHeight = end.getBoundingClientRect().bottom - target.getBoundingClientRect().top;
  if (turnHeight > 0 && turnHeight <= list.clientHeight - 12) {
    const delta = end.getBoundingClientRect().bottom - listRect.bottom;
    list.scrollTop += delta + 8;
    return;
  }
  const delta = target.getBoundingClientRect().top - listRect.top;
  list.scrollTop += delta - 8;
}

function paintListen() {
  const talk = document.getElementById('talk');
  const label = document.getElementById('talk-label');
  const cancel = document.getElementById('cancel-listen');
  const send = document.getElementById('send');
  if (talk) {
    talk.classList.toggle('is-live', ui.listening);
    talk.classList.toggle('is-speaking', ui.speaking && !ui.listening);
    talk.disabled = ui.busy && !ui.listening;
    talk.setAttribute('aria-pressed', ui.listening ? 'true' : 'false');
  }
  document.querySelectorAll('.avatar').forEach((node) => {
    node.classList.toggle('is-speaking', ui.speaking && !ui.listening);
  });
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
  const gen = ++speakGen;
  ui.speaking = true;
  paintListen();
  try {
    const useProvider = settings.voiceMode === 'provider' && activeKey(settings);
    if (useProvider && ui.providerSpeech !== false) {
      try {
        const blob = await synthesizeSpeech({
          provider: settings.provider,
          apiKey: activeKey(settings),
          text: line,
          voice: currentVoice(),
        });
        await playBlob(blob);
        return;
      } catch (err) {
        if (err instanceof ProviderError && (err.status === 404 || err.status === 405)) ui.providerSpeech = false;
        setStatus('Głos dostawcy niedostępny. Czytam głosem iPhone’a.');
      }
    }
    await speakBrowser(line, { lang: 'en-GB', rate: slow ? 0.9 : 0.96 });
  } finally {
    if (gen === speakGen) {
      ui.speaking = false;
      paintListen();
    }
  }
}

async function playBlob(blob) {
  await waitForAudioUnlock();
  try {
    await playWithWebAudio(blob);
    return;
  } catch {
    /* Web Audio keeps dictation alive on iOS. The <audio> tag is only a fallback. */
  }
  ui.recognitionBroken = true;
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  audioEl.src = currentObjectUrl;
  await audioEl.play();
  await new Promise((resolve, reject) => {
    const finish = () => resolve();
    audioEl.onended = finish;
    audioEl.onpause = () => {
      if (audioEl.ended || audioEl.currentTime > 0) finish();
    };
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
