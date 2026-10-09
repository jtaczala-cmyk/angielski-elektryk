import { scenarioById, topicById } from './tutor.js';

function turn(reply, corrections = [], phrases = []) {
  return {
    reply,
    corrections,
    phrases,
  };
}

const OPENERS = {
  site: turn(
    'Morning. Are you on site today, or is it an office day? What are you actually fitting at the moment?',
    [],
    [{ en: 'on site', pl: 'na budowie', example: 'I will be on site until four.' }],
  ),
  install: turn(
    'Let us talk about the install. Are you on first fix, or is it second fix and faces on already?',
    [],
    [{ en: 'first fix', pl: 'pierwszy etap instalacji, przed wykończeniem', example: 'First fix is nearly done on level two.' }],
  ),
  test: turn(
    'Testing day, then. Have you got as far as safe isolation, or are you already on the dead tests?',
    [],
    [{ en: 'safe isolation', pl: 'bezpieczne odłączenie napięcia', example: 'Safe isolation before you take the cover off.' }],
  ),
  people: turn(
    'Imagine the foreman has just walked over. What do you need to tell him — a delay, a missing part, or that you are done?',
    [],
    [{ en: 'foreman', pl: 'brygadzista', example: 'I will tell the foreman we need another hour.' }],
  ),
  hse: turn(
    'Before we start, picture the toolbox talk. What is the main hazard on your job this week?',
    [],
    [{ en: 'toolbox talk', pl: 'krótka odprawa BHP', example: 'We had a toolbox talk about isolation.' }],
  ),
  job: turn(
    'Right, interview practice. Tell me, in a couple of sentences, what sort of electrical work you have been doing.',
    [],
    [{ en: 'day rate', pl: 'stawka dzienna', example: 'The day rate is on the advert.' }],
  ),
  chat: turn(
    'Kettle is on. How is the week treating you — busy, or are you getting away on time?',
    [],
    [{ en: 'knock off', pl: 'kończyć pracę', example: 'We knock off early on Friday.' }],
  ),
  free: turn(
    'We can talk about whatever you like — the job, the day, something that annoyed you. What is on your mind?',
    [],
    [],
  ),
  induction: turn(
    "Morning. I'm Sam. Before you go on the tools, who are you and what are you on today?",
    [],
    [{ en: 'on the tools', pl: 'przy robocie, na narzędziach', example: 'I will be on the tools after the induction.' }],
  ),
  fault: turn(
    'Right, imagine the client is stood there looking worried. What is not working, in one plain sentence?',
    [],
    [{ en: 'packed up', pl: 'przestało działać', example: 'The lights in the kitchen have packed up.' }],
  ),
  eicr: turn(
    'Testing, then. Have you done safe isolation, or are you already writing the EICR?',
    [],
    [{ en: 'safe isolation', pl: 'bezpieczne odłączenie napięcia', example: 'Safe isolation before the cover comes off.' }],
  ),
  toolbox: turn(
    'Toolbox talk. Keep it short. What is the one hazard you want the crew to remember today?',
    [],
    [{ en: 'toolbox talk', pl: 'krótka odprawa BHP', example: 'We had a toolbox talk about isolation.' }],
  ),
  interview: turn(
    'Interview hat on. In a couple of sentences, what sort of electrical work have you been doing?',
    [],
    [{ en: 'hands-on', pl: 'praktyczny, przy robocie', example: 'Most of my work is hands-on installation.' }],
  ),
  supplier: turn(
    'You are on the phone to the wholesaler. What do you need, and when does it have to be on site?',
    [],
    [{ en: 'on site', pl: 'na budowie', example: 'Can you get it on site by Thursday?' }],
  ),
};

function scripted(text) {
  const lower = text.toLowerCase();
  if (/[ąćęłńóśźż]/i.test(text)) {
    return turn(
      'I caught some Polish there. Have another go in English, even a short sentence. What are you working on today?',
      [],
      [{ en: 'What are you working on today?', pl: 'Nad czym dziś pracujesz?', example: 'What are you working on today?' }],
    );
  }

  const corrections = [];
  if (/\bi am electrician\b/.test(lower)) {
    corrections.push({
      heard: 'I am electrician',
      better: "I'm an electrician",
      why_pl: 'Przed nazwą zawodu dajemy a albo an: an electrician.',
    });
  }
  const since = text.match(/\bsince\b[^.]{0,24}\byears?\b/i);
  if (since) {
    corrections.push({
      heard: since[0],
      better: since[0].replace(/since/i, 'for'),
      why_pl: 'Okres (two years) łączymy z for. since tylko z momentem, na przykład since 2024.',
    });
  }
  if (/\byesterday\b/.test(lower) && /\bi change\b/.test(lower)) {
    corrections.push({
      heard: 'I change',
      better: 'I changed',
      why_pl: 'yesterday wymaga czasu przeszłego: I changed, nie I change.',
    });
  }
  if (/\bbreaker panel\b/.test(lower)) {
    corrections.push({
      heard: 'breaker panel',
      better: 'consumer unit',
      why_pl: 'W brytyjskim angielskim tablica w mieszkaniu to consumer unit, nie breaker panel.',
    });
  }
  if (/\bgfci\b/.test(lower)) {
    corrections.push({
      heard: 'GFCI',
      better: 'RCD',
      why_pl: 'Amerykańskie GFCI to po brytyjsku RCD, wyłącznik różnicowoprądowy.',
    });
  }
  if (/\bground wire\b/.test(lower)) {
    corrections.push({
      heard: 'ground wire',
      better: 'earth',
      why_pl: 'Po brytyjsku mówimy earth, nie ground.',
    });
  }

  if (corrections.length) {
    const phrases = [];
    const bits = [];
    if (corrections.some((item) => /electrician/i.test(item.better))) bits.push("you're an electrician");
    if (corrections.some((item) => /\bsince\b/i.test(item.heard))) {
      bits.push("you've been at it for a good while");
      phrases.push({
        en: 'for two years',
        pl: 'od dwóch lat; przez dwa lata',
        example: 'I have worked in Norway for two years.',
      });
    }
    if (corrections.some((item) => item.better === 'I changed')) {
      bits.push('you changed that yesterday');
    }
    for (const item of corrections) {
      if (/consumer unit|RCD|^earth$/i.test(item.better) && phrases.length < 2) {
        phrases.push({
          en: item.better,
          pl: item.better === 'RCD' ? 'wyłącznik różnicowoprądowy' : item.better === 'earth' ? 'uziemienie; przewód ochronny' : 'rozdzielnica mieszkaniowa',
          example: `Check the ${item.better} before you leave site.`,
        });
      }
    }
    const followUp = /\bconsumer unit\b|\bboard\b|\bunit\b/i.test(text)
      ? 'Was it a straight swap, or did they need a bigger board?'
      : 'What are you on this week?';
    if (followUp.includes('straight swap') && phrases.length < 2) {
      phrases.push({
        en: 'straight swap',
        pl: 'wymiana jeden do jednego, bez przeróbek',
        example: 'It was a straight swap in the same cupboard.',
      });
    }
    const reply = bits.length
      ? `Right — ${bits.join(', and ')}. ${followUp}`
      : `In British English I would say “${corrections[0].better}”. How did the rest of the job go?`;
    return turn(reply, corrections, phrases.slice(0, 2));
  }

  if (/\bconsumer unit\b|\brcd\b|\brcbo\b|\btrunking\b|\bearthing\b|\bmegger\b/.test(lower)) {
    return turn(
      'Right, that is proper site talk. Was it a straightforward job, or did something fight you — access, the old board, or the test results?',
      [],
      [{ en: 'straightforward', pl: 'prosty, bez komplikacji', example: 'It was a straightforward swap in the end.' }],
    );
  }

  if (text.length <= 70) {
    return turn(
      `Right. ${text.replace(/\s+/g, ' ')} What happened next, and who else was involved?`,
      [],
      [{ en: 'who else was involved', pl: 'kto jeszcze brał w tym udział', example: 'Who else was involved in the shutdown?' }],
    );
  }

  return turn(
    'I am with you. Tell me the next bit — what did you do, and how did the other person take it?',
    [],
    [{ en: 'the next bit', pl: 'dalsza część, co było potem', example: 'Tell me the next bit after the test failed.' }],
  );
}

export function demoReply(userText, topicId) {
  const text = String(userText || '').trim();
  if (!text) {
    const topic = topicById(topicId) || scenarioById(topicId);
    const opener = (topic && OPENERS[topic.id]) || OPENERS.free;
    return structuredClone(opener);
  }
  return scripted(text);
}
