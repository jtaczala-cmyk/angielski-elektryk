export const KEYS = {
  settings: 'ae.settings.v1',
  cards: 'ae.cards.v1',
  messages: 'ae.messages.v1',
  installDismissed: 'ae.installDismissed.v1',
};

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  openaiKey: '',
  xaiKey: '',
  model: '',
  level: 'B1',
  polishHints: true,
  autoSpeak: true,
  confirmBeforeSend: false,
  voiceMode: 'provider',
  openaiVoice: 'coral',
  xaiVoice: 'eve',
  inputMode: 'auto',
};

const LEVELS = ['A2', 'B1', 'B2', 'C1'];

export function createMemoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

function readJson(store, key, fallback) {
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function loadSettings(store) {
  const saved = readJson(store, KEYS.settings, {});
  const merged = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (merged.provider !== 'openai' && merged.provider !== 'xai') merged.provider = 'openai';
  if (!LEVELS.includes(merged.level)) merged.level = 'B1';
  if (merged.voiceMode !== 'browser') merged.voiceMode = 'provider';
  if (!['auto', 'browser', 'record', 'type'].includes(merged.inputMode)) merged.inputMode = 'auto';
  merged.openaiKey = String(merged.openaiKey || '');
  merged.xaiKey = String(merged.xaiKey || '');
  merged.model = String(merged.model || '');
  merged.polishHints = Boolean(merged.polishHints);
  merged.autoSpeak = Boolean(merged.autoSpeak);
  merged.confirmBeforeSend = Boolean(merged.confirmBeforeSend);
  merged.openaiVoice = String(merged.openaiVoice || 'coral');
  merged.xaiVoice = String(merged.xaiVoice || 'eve');
  return merged;
}

export function saveSettings(store, settings) {
  store.setItem(KEYS.settings, JSON.stringify(settings));
}

export function loadCards(store) {
  const cards = readJson(store, KEYS.cards, []);
  return Array.isArray(cards) ? cards : [];
}

export function saveCards(store, cards) {
  store.setItem(KEYS.cards, JSON.stringify(cards));
}

export function loadMessages(store) {
  const messages = readJson(store, KEYS.messages, []);
  return Array.isArray(messages) ? messages : [];
}

export function saveMessages(store, messages) {
  const trimmed = messages.slice(-80);
  store.setItem(KEYS.messages, JSON.stringify(trimmed));
}

export function clearAll(store) {
  store.removeItem(KEYS.settings);
  store.removeItem(KEYS.cards);
  store.removeItem(KEYS.messages);
}

export function activeKey(settings) {
  const key = settings.provider === 'xai' ? settings.xaiKey : settings.openaiKey;
  return String(key || '').trim();
}
