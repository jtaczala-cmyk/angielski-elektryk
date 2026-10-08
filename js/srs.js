/** SM-2 spaced repetition. Grades below 3 are a lapse; 3–5 schedule the next gap. */

export function slug(en) {
  return String(en || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[łŁ]/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function reviewCard(card, grade, now = Date.now()) {
  const next = { ...card };
  let ease = Number(next.ease ?? 2.5);
  let reps = Number(next.repetitions ?? 0);
  let interval = Number(next.interval ?? 0);
  const q = Number(grade);

  if (q < 3) {
    reps = 0;
    interval = 0;
    next.lapses = Number(next.lapses || 0) + 1;
    next.due = now;
  } else {
    if (reps <= 0) interval = 1;
    else if (reps === 1) interval = 6;
    else interval = Math.max(1, Math.round(interval * ease));
    reps += 1;
    next.due = now + interval * 86400000;
  }

  ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ease < 1.3) ease = 1.3;
  next.ease = Math.round(ease * 100) / 100;
  next.repetitions = reps;
  next.interval = interval;
  next.lastGrade = q;
  next.lastReviewed = now;
  return next;
}

export function upsertPhrase(cards, phrase, now = Date.now()) {
  const list = Array.isArray(cards) ? cards : [];
  const en = String(phrase.en || '').trim();
  const pl = String(phrase.pl || '').trim();
  const example = String(phrase.example || '').trim();
  if (!en || !pl || en.length > 80) return { cards: list, added: false };
  const id = slug(en) || `card-${now}`;
  const index = list.findIndex(
    (card) => card.id === id || String(card.en).toLowerCase() === en.toLowerCase(),
  );
  if (index >= 0) {
    const existing = list[index];
    const seedUpdate = existing.source === 'seed' && phrase.source === 'seed';
    const fillExample = !existing.example && example;
    if (!seedUpdate && !fillExample) return { cards: list, added: false };
    const next = list.slice();
    next[index] = {
      ...existing,
      en: seedUpdate ? en : existing.en,
      pl: seedUpdate ? pl : existing.pl,
      example: example || existing.example,
    };
    return { cards: next, added: false };
  }
  return {
    cards: [
      ...list,
      {
        id,
        en,
        pl,
        example,
        source: phrase.source || 'conversation',
        addedAt: now,
        ease: 2.5,
        interval: 0,
        repetitions: 0,
        due: now,
        lapses: 0,
      },
    ],
    added: true,
  };
}

export function ensureSeed(cards, seed, now = Date.now()) {
  let next = Array.isArray(cards) ? cards : [];
  let added = 0;
  for (const item of seed) {
    const result = upsertPhrase(next, { ...item, source: 'seed' }, now);
    next = result.cards;
    if (result.added) added += 1;
  }
  return { cards: next, added };
}

export function dueCards(cards, now = Date.now()) {
  return cards
    .filter((card) => Number(card.due ?? 0) <= now)
    .slice()
    .sort((a, b) => Number(a.due ?? 0) - Number(b.due ?? 0) || a.en.localeCompare(b.en, 'en'));
}

export function searchCards(cards, query) {
  const q = String(query || '').trim().toLowerCase();
  const sorted = cards.slice().sort((a, b) => a.en.localeCompare(b.en, 'en'));
  if (!q) return sorted;
  return sorted.filter((card) => `${card.en} ${card.pl} ${card.example}`.toLowerCase().includes(q));
}

export function removeCard(cards, id) {
  return cards.filter((card) => card.id !== id);
}
