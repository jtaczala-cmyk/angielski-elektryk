export const TOPICS = [
  {
    id: 'site',
    pl: 'Na budowie',
    en: 'a normal day on a construction site in Norway, talking with the foreman and other trades',
  },
  {
    id: 'install',
    pl: 'Montaż',
    en: 'electrical installation: containment, cabling, consumer units, first fix and second fix',
  },
  {
    id: 'test',
    pl: 'Pomiary',
    en: 'testing and inspection: safe isolation, continuity, insulation resistance, earth fault loop, commissioning',
  },
  {
    id: 'people',
    pl: 'Ludzie',
    en: 'talking to a client or a foreman about progress, a problem, or a delay',
  },
  {
    id: 'hse',
    pl: 'BHP',
    en: 'safety and HSE: RAMS, permits, PPE, toolbox talks, and reporting a hazard',
  },
  {
    id: 'job',
    pl: 'Rozmowa o pracę',
    en: 'a job interview for an electrician role: experience, tickets, and why he wants the job',
  },
  {
    id: 'chat',
    pl: 'Small talk',
    en: 'small talk with colleagues: the weather, the weekend, lunch, and where he is from',
  },
  {
    id: 'free',
    pl: 'Wolny temat',
    en: 'whatever is on his mind; invite him to choose the subject',
  },
];

export function topicById(id) {
  return TOPICS.find((topic) => topic.id === id) || null;
}

export function buildSystemPrompt({ level, polishHints }) {
  const hints = polishHints
    ? 'why_pl is one short sentence in Polish for a native speaker. Explain the grammar or the word, not a lecture. If there is nothing to explain, use an empty string.'
    : 'The learner turned Polish hints off. Always set why_pl to an empty string. The reply stays in English.';

  return `You are a conversation partner for Jacek, a Polish electrician and electrical engineer working on sites in Norway. He is learning spoken British English. The phone app around you is in Polish. You do not teach in Polish, and you do not write Polish in the reply.

Talk like a friendly colleague from England: warm, plain, modern British English. Not American, not a posh caricature, not a teacher with a red pen. This is a loose chat, not a quiz and not a drill.

Use British electrical language when the work comes up: consumer unit, distribution board, RCD, RCBO, MCB, earthing, earth, live, neutral, socket outlet, cable tray, trunking, conduit, isolator, safe isolation, and so on. If he uses an American term (breaker panel, outlet, ground, hot, GFCI), answer with the British term and treat that as a correction. His sites are in Norway; do not pretend he is in Britain, and do not correct Norwegian site life. The English he is aiming for is still British.

His level today is ${level} on the CEFR scale.
- A2: short sentences, common words, one idea at a time, still like a person.
- B1: everyday site and life language, clear, not childish.
- B2: natural pace, the odd idiom, still kind.
- C1: a normal colleague, light humour is welcome.

Each turn:
1. Answer what he actually said. Keep the chat going with exactly one follow-up question. Do not stack questions.
2. If his grammar, word choice, or phrasing is unnatural, use the better British phrasing yourself inside the reply. Do not say "wrong", do not score him, do not list rules out loud. Put the detail in corrections. heard must be a short exact span from his last message, not your paraphrase.
3. If his English is fine, corrections is an empty array. Never invent a mistake.
4. phrases has at most two useful chunks from this turn (a trade term, a British phrase, or the better wording from a correction). Skip words he already handled well and skip trivial words. pl is a real Polish translation. example is one natural British sentence.
5. reply is spoken aloud. No markdown, no lists, no labels, no Polish, no stage directions. Two to four sentences.

${hints}

Return only a JSON object:
{"reply":"spoken British English","corrections":[{"heard":"his words","better":"British phrasing","why_pl":"short Polish note or empty"}],"phrases":[{"en":"phrase","pl":"Polish translation","example":"One British sentence."}]}`;
}

export function topicKickoff(topic) {
  return `Let's start a fresh conversation. The situation: ${topic.en}. Open naturally in British English, as if we have just started chatting, and ask me one question I can answer from my own work or life. Do not mention that you were given a topic.`;
}

export function messagesForApi(messages, system) {
  const recent = messages
    .filter((message) => message && message.text && message.role !== 'note')
    .slice(-16);
  const api = [{ role: 'system', content: system }];
  for (const message of recent) {
    if (message.role === 'user') {
      api.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      api.push({
        role: 'assistant',
        content: JSON.stringify({
          reply: message.text,
          corrections: message.corrections || [],
          phrases: message.phrases || [],
        }),
      });
    }
  }
  return api;
}

function asText(value) {
  return String(value ?? '').trim();
}

export function parseTutorReply(raw) {
  const text = asText(raw);
  if (!text) return { reply: '', corrections: [], phrases: [] };
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return { reply: stripFences(text), corrections: [], phrases: [] };
  }
  const corrections = Array.isArray(parsed.corrections)
    ? parsed.corrections
        .map((item) => ({
          heard: asText(item?.heard),
          better: asText(item?.better),
          why_pl: asText(item?.why_pl),
        }))
        .filter((item) => item.better)
        .slice(0, 4)
    : [];
  const phrases = Array.isArray(parsed.phrases)
    ? parsed.phrases
        .map((item) => ({
          en: asText(item?.en).slice(0, 80),
          pl: asText(item?.pl),
          example: asText(item?.example).slice(0, 220),
        }))
        .filter((item) => item.en && item.pl)
        .slice(0, 3)
    : [];
  return { reply: asText(parsed.reply), corrections, phrases };
}

function parseJsonObject(text) {
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const direct = JSON.parse(fenced);
    if (direct && typeof direct === 'object') return direct;
  } catch {
    /* try a slice */
  }
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const sliced = JSON.parse(fenced.slice(start, end + 1));
      if (sliced && typeof sliced === 'object') return sliced;
    } catch {
      return null;
    }
  }
  return null;
}

function stripFences(text) {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

/** Split text into plain and highlighted spans. Phrases are matched case-insensitively. */
export function splitHighlights(text, phrases) {
  const source = String(text || '');
  const ranges = [];
  const lower = source.toLowerCase();
  const sorted = [...new Set((phrases || []).map((phrase) => String(phrase || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    const needle = phrase.toLowerCase();
    let from = 0;
    while (needle && from < source.length) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const end = index + phrase.length;
      const overlaps = ranges.some((range) => index < range.end && end > range.start);
      if (!overlaps) ranges.push({ start: index, end });
      from = end;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: source.slice(cursor, range.start), hit: false });
    parts.push({ text: source.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < source.length || parts.length === 0) {
    parts.push({ text: source.slice(cursor), hit: false });
  }
  return parts;
}
