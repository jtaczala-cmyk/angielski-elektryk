import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionReport, comparePronunciation, goalProgress, looksGarbled, weekCounts } from '../js/quality.js';
import { loadSettings } from '../js/storage.js';
import { createMemoryStore } from '../js/storage.js';
import { SCENARIOS, buildSystemPrompt } from '../js/tutor.js';
import { demoReply } from '../js/demo.js';

const GARBLED = "12345 1015 how are you what called why you don't tell me";

test('dictation junk with number runs is treated as garbled', () => {
  assert.equal(looksGarbled(GARBLED), true);
  assert.equal(looksGarbled('1234567890 hi'), true);
  assert.equal(looksGarbled('I am electrician and I work in Norway since two years.'), false);
  assert.equal(looksGarbled('I fitted two RCDs on level two.'), false);
  assert.equal(looksGarbled('Can you get 100 metres of 2.5?'), false);
});

test('pronunciation compare is kind about small slips', () => {
  const good = comparePronunciation('consumer unit', 'consumer unit');
  assert.equal(good.grade, 'good');
  assert.equal(good.score, 100);
  const close = comparePronunciation('safe isolation', 'safe isolations');
  assert.equal(close.grade, 'good');
  const again = comparePronunciation('toolbox talk', 'banana');
  assert.equal(again.grade, 'again');
  assert.match(comparePronunciation('earth', '').note_pl, /Nic nie usłyszałem/);
});

test('session report keeps the useful corrections and a score', () => {
  const now = 1_700_000_000_000;
  const report = buildSessionReport({
    now,
    level: 'B1',
    scenario: SCENARIOS[0],
    messages: [
      { role: 'note', text: 'start', hidden: false },
      { role: 'user', text: 'I am electrician', hidden: false },
      {
        role: 'assistant',
        text: 'Right.',
        corrections: [
          { heard: 'I am electrician', better: "I'm an electrician", why_pl: 'an' },
          { heard: 'ground', better: 'earth', why_pl: 'earth' },
          { heard: 'outlet', better: 'socket', why_pl: 'socket' },
        ],
        phrases: [
          { en: 'on the tools', pl: 'przy robocie' },
          { en: 'on the tools', pl: 'duplikat' },
        ],
      },
    ],
  });
  assert.equal(report.turns, 1);
  assert.equal(report.corrections.length, 2);
  assert.equal(report.words.length, 1);
  assert.equal(report.scenarioPl, 'Wejście na budowę');
  assert.ok(report.score > 0 && report.score <= 100);
  assert.ok(report.wentWell.length >= 1);
  const empty = buildSessionReport({ messages: [], now });
  assert.equal(empty.turns, 0);
  assert.equal(empty.score, 0);
});

test('a week of practice is seven days ending today', () => {
  const now = new Date('2026-10-08T12:00:00').getTime();
  const messages = [{ role: 'user', text: 'Morning', at: now, hidden: false }];
  const week = weekCounts(messages, now);
  assert.equal(week.length, 7);
  assert.equal(week[6].count, 1);
  assert.equal(week[0].count, 0);
  const progress = goalProgress(messages, 5, now);
  assert.equal(progress.done, 1);
  assert.equal(progress.met, false);
});

test('new settings heal and scenarios open in British', () => {
  const healed = loadSettings(createMemoryStore());
  assert.equal(healed.sendMode, 'auto');
  assert.equal(healed.handsFree, false);
  assert.equal(healed.dailyGoal, 5);
  assert.equal(healed.fontScale, 'md');
  assert.equal(healed.heardSam, '');
  const prompt = buildSystemPrompt({ level: 'B1', polishHints: true });
  assert.match(prompt, /British/);
  assert.match(prompt, /one follow-up question/i);
  assert.equal(SCENARIOS.length, 6);
  const opener = demoReply('', 'supplier');
  assert.match(opener.reply, /\?/);
  assert.match(opener.reply, /site|wholesaler|need/i);
});
