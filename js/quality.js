/** Pure helpers for voice checks, pronunciation, and session reports. */

export function looksGarbled(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (raw.length < 6) return false;
  const letters = (raw.match(/[A-Za-z]/g) || []).length;
  const digits = (raw.match(/\d/g) || []).length;
  const runs = raw.match(/\d{3,}/g) || [];
  if (runs.length >= 2) return true;
  if (digits >= 6 && letters / Math.max(letters + digits, 1) < 0.55) return true;
  const compact = raw.replace(/\s/g, '');
  if (compact.length >= 14 && letters / compact.length < 0.4) return true;
  return false;
}

export function garbleTurn() {
  return {
    reply: "Sorry, that came through as a jumble. Say it again for me, a bit slower, just one sentence.",
    corrections: [],
    phrases: [],
    garbled: true,
  };
}

function normaliseSpeech(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsClose(expected, heard) {
  if (expected === heard) return true;
  if (expected.length >= 4 && (heard.startsWith(expected) || expected.startsWith(heard))) return true;
  if (Math.abs(expected.length - heard.length) > 2) return false;
  let slips = 0;
  const length = Math.max(expected.length, heard.length);
  for (let i = 0; i < length; i += 1) {
    if (expected[i] !== heard[i]) slips += 1;
  }
  return slips <= 1;
}

export function comparePronunciation(expected, heard) {
  const target = normaliseSpeech(expected);
  const said = normaliseSpeech(heard);
  if (!said) {
    return { grade: 'again', score: 0, note_pl: 'Nic nie usłyszałem. Powiedz jeszcze raz, wolniej.' };
  }
  const wanted = target.split(' ').filter(Boolean);
  const spoken = said.split(' ').filter(Boolean);
  if (!wanted.length) return { grade: 'again', score: 0, note_pl: 'Brak wzoru do porównania.' };
  let hits = 0;
  const pool = spoken.slice();
  for (const word of wanted) {
    const index = pool.findIndex((item) => wordsClose(word, item));
    if (index >= 0) {
      hits += 1;
      pool.splice(index, 1);
    }
  }
  const score = Math.round((hits / wanted.length) * 100);
  if (score >= 90) return { grade: 'good', score, note_pl: 'Dobrze. Brzmi jasno.' };
  if (score >= 60) return { grade: 'close', score, note_pl: 'Prawie. Posłuchaj jeszcze raz i powtórz wolniej.' };
  return { grade: 'again', score, note_pl: 'Spróbuj jeszcze raz. Słuchaj wzoru i powiedz całe wyrażenie.' };
}

function uniquePush(list, item, key) {
  if (!item || !item[key]) return;
  const id = String(item[key]).toLowerCase();
  if (list.some((entry) => String(entry[key]).toLowerCase() === id)) return;
  list.push(item);
}

export function buildSessionReport({ messages, scenario, level, now = Date.now() } = {}) {
  const visible = (messages || []).filter((message) => message && !message.hidden && (message.role === 'user' || message.role === 'assistant'));
  const users = visible.filter((message) => message.role === 'user');
  const corrections = [];
  const words = [];
  for (const message of visible) {
    if (message.role !== 'assistant') continue;
    for (const fix of message.corrections || []) {
      if (!fix?.better) continue;
      uniquePush(corrections, {
        heard: String(fix.heard || ''),
        better: String(fix.better),
        why_pl: String(fix.why_pl || ''),
      }, 'better');
    }
    for (const phrase of message.phrases || []) {
      if (!phrase?.en) continue;
      uniquePush(words, { en: String(phrase.en), pl: String(phrase.pl || '') }, 'en');
    }
  }
  const turns = users.length;
  let score = turns ? 42 : 0;
  score += Math.min(36, turns * 8);
  score += Math.min(12, words.length * 3);
  score -= Math.min(18, Math.max(0, corrections.length - 1) * 5);
  score = Math.max(0, Math.min(100, score));

  const wentWell = [];
  if (turns >= 4) wentWell.push('Dociągnąłeś rozmowę — kilka pełnych wymian, nie jedno zdanie.');
  else if (turns >= 1) wentWell.push('Zacząłeś po angielsku i dostałeś odpowiedź.');
  if (turns && corrections.length === 0) wentWell.push('Sam nie musiał poprawiać. Zdania brzmiały naturalnie.');
  else if (corrections.length > 0 && corrections.length <= 2) wentWell.push('Poprawek było mało. To dobry znak na budowie.');
  if (words.length) wentWell.push(`Nowe zwroty zostały w słówkach: ${words.slice(0, 3).map((word) => word.en).join(', ')}.`);
  if (!wentWell.length) wentWell.push('Sesja krótka. Następnym razem powiedz trzy zdania o robocie.');

  return {
    id: `ses-${now}`,
    at: now,
    level: level || 'B1',
    scenarioId: scenario?.id || '',
    scenarioPl: scenario?.pl || 'Wolna rozmowa',
    goal: scenario?.goal || '',
    turns,
    score,
    wentWell: wentWell.slice(0, 3),
    corrections: corrections.slice(0, 2),
    words: words.slice(0, 6),
  };
}

export function localDay(time = Date.now()) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function turnsOnDay(messages, day) {
  return (messages || []).filter((message) => message && message.role === 'user' && !message.hidden && localDay(message.at) === day).length;
}

const WEEKDAYS = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So'];

export function weekCounts(messages, now = Date.now()) {
  const origin = new Date(now);
  origin.setHours(12, 0, 0, 0);
  const counts = [];
  for (let ago = 6; ago >= 0; ago -= 1) {
    const cursor = new Date(origin);
    cursor.setDate(origin.getDate() - ago);
    const day = localDay(cursor);
    counts.push({
      day,
      label: WEEKDAYS[cursor.getDay()],
      count: turnsOnDay(messages, day),
    });
  }
  return counts;
}

export function goalProgress(messages, goal, now = Date.now()) {
  const target = Math.max(1, Number(goal) || 5);
  const done = turnsOnDay(messages, localDay(now));
  return {
    done,
    goal: target,
    met: done >= target,
    ratio: Math.max(0, Math.min(1, done / target)),
  };
}
