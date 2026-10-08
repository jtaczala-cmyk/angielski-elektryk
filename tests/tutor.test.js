import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { demoReply } from '../js/demo.js';
import {
  PROVIDERS,
  activeModel,
  buildChatRequest,
  buildSpeechRequest,
  buildTranscriptionRequest,
  chatComplete,
  extractMessageText,
  redactSecrets,
  synthesizeSpeech,
  transcribeAudio,
  verifyKey,
} from '../js/providers.js';
import { SEED } from '../js/seed.js';
import {
  describeInputPath,
  extensionForMime,
  pickBritishVoice,
  pickRecorderMime,
  recognitionProblem,
} from '../js/speech.js';
import { dueCards, ensureSeed, reviewCard, slug, upsertPhrase } from '../js/srs.js';
import { createMemoryStore, loadSettings, saveSettings } from '../js/storage.js';
import { buildSystemPrompt, messagesForApi, parseTutorReply, splitHighlights, topicKickoff } from '../js/tutor.js';

const REQUIRED = [
  'consumer unit',
  'RCD',
  'RCBO',
  'MCB',
  'earthing',
  'cable tray',
  'trunking',
  'conduit',
  'isolator',
  'socket outlet',
  'live',
  'neutral',
  'earth',
  'megger',
  'insulation resistance test',
];

test('starter deck has British trade terms and unique ids', () => {
  const ens = SEED.map((card) => card.en.toLowerCase());
  for (const term of REQUIRED) assert.ok(ens.includes(term.toLowerCase()), term);
  const seeded = ensureSeed([], SEED, 1_700_000_000_000);
  assert.equal(seeded.added, SEED.length);
  const ids = seeded.cards.map((card) => card.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(slug('RCD'), 'rcd');
  assert.ok(seeded.cards.every((card) => card.pl && card.example && card.due === 1_700_000_000_000));
});

test('SM-2 schedules successes and keeps lapses due now', () => {
  const now = 1_700_000_000_000;
  const fresh = { en: 'isolator', ease: 2.5, interval: 0, repetitions: 0, lapses: 0 };
  const first = reviewCard(fresh, 4, now);
  assert.equal(fresh.repetitions, 0);
  assert.equal(first.repetitions, 1);
  assert.equal(first.interval, 1);
  assert.equal(first.ease, 2.5);
  assert.equal(first.due, now + 86400000);

  const second = reviewCard(first, 4, now);
  assert.equal(second.repetitions, 2);
  assert.equal(second.interval, 6);

  const third = reviewCard(second, 4, now);
  assert.equal(third.interval, 15);
  assert.equal(third.repetitions, 3);

  const lapsed = reviewCard(third, 1, now);
  assert.equal(lapsed.repetitions, 0);
  assert.equal(lapsed.interval, 0);
  assert.equal(lapsed.due, now);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.ease, 1.96);
  assert.equal(dueCards([lapsed, first], now)[0].en, 'isolator');
});

test('new phrases are saved once, with a Polish gloss', () => {
  let cards = [];
  const first = upsertPhrase(cards, {
    en: 'straight swap',
    pl: 'wymiana jeden do jednego',
    example: 'It was a straight swap.',
  }, 50);
  cards = first.cards;
  assert.equal(first.added, true);
  const again = upsertPhrase(cards, {
    en: 'Straight Swap',
    pl: 'inne',
    example: 'Different.',
  }, 60);
  assert.equal(again.added, false);
  assert.equal(again.cards, cards);
  assert.equal(cards[0].example, 'It was a straight swap.');
});

test('settings stay on the device store and survive a reload', () => {
  const memory = createMemoryStore();
  const saved = loadSettings(memory);
  saved.provider = 'xai';
  saved.xaiKey = 'xai-secret-value';
  saved.level = 'B2';
  saved.voiceMode = 'browser';
  saved.polishHints = false;
  saveSettings(memory, saved);
  const loaded = loadSettings(memory);
  assert.equal(loaded.provider, 'xai');
  assert.equal(loaded.xaiKey, 'xai-secret-value');
  assert.equal(loaded.level, 'B2');
  assert.equal(loaded.voiceMode, 'browser');
  assert.equal(loaded.polishHints, false);
  assert.equal(loaded.openaiKey, '');
  const junk = createMemoryStore();
  junk.setItem('ae.settings.v1', JSON.stringify({ provider: 'nope', level: 'Z', voiceMode: 'loud' }));
  const healed = loadSettings(junk);
  assert.equal(healed.provider, 'openai');
  assert.equal(healed.level, 'B1');
  assert.equal(healed.voiceMode, 'provider');
});

test('OpenAI chat request matches the current completions shape', () => {
  const request = buildChatRequest({
    provider: 'openai',
    apiKey: 'sk-test-secret',
    model: '',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test-secret');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_completion_tokens, 1200);
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(JSON.stringify(body).includes('sk-test-secret'), false);
  assert.match(buildSystemPrompt({ level: 'B1', polishHints: true }), /British/);
});

test('older OpenAI models keep temperature and max_tokens', () => {
  const body = JSON.parse(buildChatRequest({
    provider: 'openai',
    apiKey: 'sk-test-secret',
    model: 'gpt-4o-mini',
    messages: [],
  }).init.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.max_tokens, 800);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(activeModel('openai', '  gpt-4.1-mini '), 'gpt-4.1-mini');
});

test('xAI chat request uses the OpenAI-compatible endpoint', () => {
  const request = buildChatRequest({
    provider: 'xai',
    apiKey: 'xai-test-secret',
    model: '',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(request.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer xai-test-secret');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, PROVIDERS.xai.defaultModel);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.temperature, 0.7);
});

test('chatComplete reads message content and retries a 400 in compat mode', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'unsupported response_format' } }), { status: 400 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: 'text', text: '{"reply":"Morning.","corrections":[],"phrases":[]}' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const turn = await chatComplete({
    provider: 'openai',
    apiKey: 'sk-test-secret',
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'Hi' }],
    fetchImpl,
  });
  assert.equal(turn.reply, 'Morning.');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[1].body.response_format, undefined);
  assert.equal(calls[1].body.temperature, 0.7);
});

test('provider errors redact the key and a network failure is marked', async () => {
  await assert.rejects(
    () => chatComplete({
      provider: 'openai',
      apiKey: 'sk-test-secret',
      model: 'gpt-4o-mini',
      messages: [],
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'Incorrect API key provided: sk-test-secret' },
      }), { status: 401 }),
    }),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.corsBlocked, false);
      assert.equal(String(err.message).includes('sk-test-secret'), false);
      return true;
    },
  );
  await assert.rejects(
    () => verifyKey({
      provider: 'xai',
      apiKey: 'xai-test-secret',
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }),
    (err) => err.corsBlocked === true,
  );
  assert.equal(redactSecrets('key sk-abcdefghijk', 'sk-abcdefghijk').includes('sk-abcdefghijk'), false);
});

test('speech and transcription requests match OpenAI and xAI', async () => {
  const speech = buildSpeechRequest({ provider: 'openai', apiKey: 'sk-test', text: 'Hello', voice: 'coral' });
  const speechBody = JSON.parse(speech.init.body);
  assert.equal(speech.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(speechBody.model, 'gpt-4o-mini-tts');
  assert.equal(speechBody.voice, 'coral');
  assert.match(speechBody.instructions, /British/);

  const xaiSpeech = JSON.parse(buildSpeechRequest({
    provider: 'xai',
    apiKey: 'xai-test',
    text: 'Hello',
    voice: 'eve',
  }).init.body);
  assert.equal(xaiSpeech.voice_id, 'eve');
  assert.equal(xaiSpeech.language, 'en');

  const openaiStt = buildTranscriptionRequest({
    provider: 'openai',
    apiKey: 'sk-test',
    audio: new Blob(['abc'], { type: 'audio/mp4' }),
    mime: 'audio/mp4',
    filename: 'speech.m4a',
  });
  assert.equal(openaiStt.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(openaiStt.init.headers['Content-Type'], undefined);
  const openaiFields = [...openaiStt.init.body.keys()];
  assert.equal(openaiFields.at(-1), 'file');
  assert.equal(openaiStt.init.body.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(openaiStt.init.body.get('language'), 'en');

  const xaiStt = buildTranscriptionRequest({
    provider: 'xai',
    apiKey: 'xai-test',
    audio: new Blob(['abc'], { type: 'audio/mp4' }),
    mime: 'audio/mp4',
    filename: 'speech.m4a',
  });
  assert.equal(xaiStt.url, 'https://api.x.ai/v1/stt');
  const xaiFields = [...xaiStt.init.body.keys()];
  assert.equal(xaiFields.at(-1), 'file');
  assert.equal(xaiStt.init.body.get('model'), 'grok-voice-transcribe-2.0');
  assert.ok(xaiFields.filter((key) => key === 'keyterm').length >= 8);

  const heard = await transcribeAudio({
    provider: 'openai',
    apiKey: 'sk-test',
    audio: new Blob(['abc']),
    mime: 'audio/mp4',
    filename: 'speech.m4a',
    fetchImpl: async () => new Response(JSON.stringify({ text: '  I changed the board.  ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal(heard, 'I changed the board.');

  const blob = await synthesizeSpeech({
    provider: 'xai',
    apiKey: 'xai-test',
    text: 'Hello',
    voice: 'leo',
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }),
  });
  assert.equal((await blob.arrayBuffer()).byteLength, 4);
});

test('tutor JSON survives fences and highlights the heard span', () => {
  const parsed = parseTutorReply('```json\n{"reply":"Nice.","corrections":[{"heard":"I am electrician","better":"I\'m an electrician","why_pl":"an"}],"phrases":[{"en":"spark","pl":"elektryk","example":"He is a spark."}]}\n```');
  assert.equal(parsed.reply, 'Nice.');
  assert.equal(parsed.corrections[0].better, "I'm an electrician");
  assert.equal(parsed.phrases[0].pl, 'elektryk');
  const parts = splitHighlights('I am electrician on site', ['I am electrician']);
  assert.deepEqual(parts.filter((part) => part.hit).map((part) => part.text), ['I am electrician']);
  assert.equal(parseTutorReply('Just a chat.').reply, 'Just a chat.');
  const text = extractMessageText({ choices: [{ message: { content: '  {"reply":"Hi"} ' } }] });
  assert.match(text, /Hi/);
});

test('history sent to the model is the recent JSON turns', () => {
  const messages = [{ role: 'note', text: 'Temat: BHP' }];
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: 'user', text: `turn ${i}` });
    messages.push({ role: 'assistant', text: `reply ${i}`, corrections: [], phrases: [] });
  }
  const api = messagesForApi(messages, 'system');
  assert.equal(api[0].role, 'system');
  assert.equal(api.length, 17);
  assert.equal(api.at(-1).role, 'assistant');
  assert.equal(JSON.parse(api.at(-1).content).reply, 'reply 19');
  assert.match(topicKickoff({ en: 'a toolbox talk' }), /toolbox talk/);
});

test('demo conversation corrects a typical Polish-English sentence', () => {
  const turn = demoReply('I am electrician and I work in Norway since two years.');
  assert.match(turn.reply, /electrician/);
  assert.equal(turn.corrections.some((item) => item.better === "I'm an electrician"), true);
  assert.equal(turn.corrections.some((item) => /for /i.test(item.better)), true);
  assert.ok(turn.phrases.some((item) => item.en === 'for two years' && item.pl));
  const topic = demoReply('', 'test');
  assert.match(topic.reply, /\?/);
  assert.equal(topic.corrections.length, 0);
});

test('speech path prefers British voices and iPhone mp4 recordings', () => {
  const voice = pickBritishVoice([
    { name: 'Samantha', lang: 'en-US' },
    { name: 'Daniel', lang: 'en-GB' },
    { name: 'Kate', lang: 'en-GB' },
  ]);
  assert.equal(voice.name, 'Daniel');
  assert.equal(pickRecorderMime((type) => type === 'audio/mp4' || type === 'audio/webm'), 'audio/mp4');
  assert.equal(pickRecorderMime(() => false, { ios: true }), 'audio/mp4');
  assert.equal(extensionForMime('audio/mp4'), 'm4a');
  assert.equal(describeInputPath({ inputMode: 'auto', hasRecognition: true, hasRecorder: true }), 'browser');
  assert.equal(describeInputPath({ inputMode: 'auto', hasRecognition: true, hasRecorder: true, preferRecorder: true }), 'record');
  assert.equal(describeInputPath({ inputMode: 'auto', hasRecognition: false, hasRecorder: true }), 'record');
  assert.equal(describeInputPath({ inputMode: 'browser', hasRecognition: false, hasRecorder: false }), 'type');
  assert.match(recognitionProblem('not-allowed'), /Mikrofon|Dyktowanie|mikrofonu/i);
  assert.match(recognitionProblem('no-start', { standalone: true, hasKey: false }), /klucza/);
  assert.match(recognitionProblem('network'), /internetu/);
});

test('the static site uses relative paths and does not contain a key', () => {
  const files = ['index.html', 'sw.js', 'manifest.json', 'README.md'];
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /manifest\.json/);
  assert.match(html, /lang="pl"/);
  assert.doesNotMatch(html, /(?:href|src)=["']\//);
  for (const file of files) {
    if (file === 'README.md') continue;
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{12,}/);
  }
  const jsFiles = readdirSync(new URL('../js/', import.meta.url));
  assert.ok(jsFiles.includes('app.js'));
});
