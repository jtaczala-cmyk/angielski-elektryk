/** Browser speech. iOS Safari has webkitSpeechRecognition (since 14.5, including iOS 26) but only partial support. */

export function getRecognitionCtor(win = globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function mediaRecorderSupported(win = globalThis) {
  return typeof win.MediaRecorder !== 'undefined' && Boolean(win.navigator?.mediaDevices?.getUserMedia);
}

export function isIos(win = globalThis) {
  const nav = win.navigator;
  const ua = nav?.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return nav?.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1;
}

/** Home Screen web app. iOS exposes webkitSpeechRecognition here, but it often never starts. */
export function isStandalone(win = globalThis) {
  if (win.navigator?.standalone === true) return true;
  try {
    return win.matchMedia?.('(display-mode: standalone)')?.matches === true;
  } catch {
    return false;
  }
}

export function describeInputPath({ inputMode, hasRecognition, hasRecorder, preferRecorder = false }) {
  if (inputMode === 'type') return 'type';
  if (inputMode === 'record') return hasRecorder ? 'record' : 'type';
  if (inputMode === 'browser') {
    if (hasRecognition && !preferRecorder) return 'browser';
    return hasRecorder ? 'record' : 'type';
  }
  if (preferRecorder && hasRecorder) return 'record';
  if (hasRecognition) return 'browser';
  if (hasRecorder) return 'record';
  return 'type';
}

export function pickRecorderMime(isSupported, { ios = false } = {}) {
  const preferred = ['audio/mp4', 'audio/aac', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const type of preferred) {
    try {
      if (isSupported(type)) return type;
    } catch {
      /* ignore broken detectors */
    }
  }
  // iOS Safari records AAC in an mp4 even when isTypeSupported('audio/mp4') is false.
  if (ios) return 'audio/mp4';
  return '';
}

export function recognitionProblem(code, { standalone = false, hasKey = false, hasRecorder = true } = {}) {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'Safari nie dało mikrofonu albo dyktowania. Zezwól: Ustawienia → Safari → Mikrofon, oraz Ustawienia → Ogólne → Klawiatura → Dyktowanie, język English (UK). Możesz też wpisać zdanie.';
  }
  if (code === 'audio-capture') return 'Nie widzę mikrofonu. Zamknij inną aplikację, która go używa, albo wpisz zdanie.';
  if (code === 'network') return 'Dyktowanie Apple potrzebuje internetu. Sprawdź sieć albo wpisz zdanie.';
  if (code === 'no-speech') return 'Nic nie usłyszałem. Powiedz głośniej albo wpisz zdanie.';
  if (code === 'no-start' || code === 'hung') {
    if (!hasRecorder) return 'Dyktowanie nie wystartowało. Wpisz zdanie na dole.';
    if (standalone && !hasKey) {
      return 'Z ekranu początkowego iPhone nie rozpoznaje mowy bez klucza API. Wpisz zdanie na dole albo dodaj klucz w Ustawieniach — wtedy nagram i wyślę plik.';
    }
    return 'Dyktowanie nie wystartowało. Stuknij Mów jeszcze raz (nagram dźwięk) albo wpisz zdanie.';
  }
  if (code === 'no-recognition') return 'To Safari nie ma dyktowania. Wpisz zdanie albo dodaj klucz, żeby wysłać nagranie.';
  return 'Dyktowanie niedostępne. Wpisz zdanie albo stuknij „Sprawdź telefon” w Ustawieniach.';
}

export function extensionForMime(mime) {
  const type = String(mime || '').toLowerCase();
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return 'm4a';
}

export function pickBritishVoice(voices) {
  const list = Array.from(voices || []);
  const british = list.filter((voice) => /^en-GB/i.test(voice.lang || ''));
  const names = ['Daniel', 'Kate', 'Serena', 'Arthur', 'Martha', 'Google UK English'];
  for (const name of names) {
    const hit = british.find((voice) => String(voice.name || '').includes(name));
    if (hit) return hit;
  }
  if (british[0]) return british[0];
  return list.find((voice) => /^en/i.test(voice.lang || '')) || null;
}

export function pathLabel(path) {
  if (path === 'browser') return 'Dyktowanie en-GB';
  if (path === 'record') return 'Nagranie, potem transkrypcja';
  return 'Wpisywanie';
}

let audioUnlocked = false;
let unlockGate = Promise.resolve();
let sharedContext = null;
let activeSource = null;
let bridgeOn = false;
let htmlReady = false;
const speechWaiters = new Set();
const voiceNotes = [];

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

/** Last playback attempts, for the hidden Szczegóły panel. */
export function noteVoice(step, detail) {
  voiceNotes.push(`${step}: ${detail}`);
  if (voiceNotes.length > 40) voiceNotes.shift();
}

export function voiceTrace() {
  return voiceNotes.join('\n');
}

export function htmlAudioReady() {
  return htmlReady;
}

/** How long a spoken line may keep the screen in “Mówię…” before we give up. */
export function speakBudget(text) {
  const chars = String(text || '').trim().length;
  return Math.min(20000, Math.max(4500, chars * 70));
}

export function withTimeout(promise, ms, win = globalThis) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = win.setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
  });
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  return Promise.race([guarded, timeout]).finally(() => win.clearTimeout(timer));
}

export function sharedAudioContext(win = globalThis) {
  if (sharedContext) return sharedContext;
  const Ctor = win.AudioContext || win.webkitAudioContext;
  if (!Ctor) return null;
  sharedContext = new Ctor();
  return sharedContext;
}

/**
 * Resume Web Audio from the tap itself. A silent buffer counts as a gesture.
 * Do not play the <audio> element here: on iOS 26 that hangs the next
 * webkitSpeechRecognition (WebKit bug 321436).
 */
export function unlockAudio() {
  const ctx = sharedAudioContext();
  if (ctx) {
    try {
      if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
        const resumed = Promise.resolve(ctx.resume()).catch((err) => {
          audioUnlocked = false;
          noteVoice('ctx-resume', err?.name || 'error');
        });
        if (!audioUnlocked) unlockGate = resumed;
      }
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      audioUnlocked = true;
      noteVoice('ctx', ctx.state);
    } catch (err) {
      noteVoice('ctx', err?.name || 'error');
    }
  }
  return unlockGate;
}

/**
 * iOS only speaks if speechSynthesis.speak() ran inside the tap, before any await.
 * One silent utterance unlocks the page; onend keeps a silent bridge across the
 * network wait so the real line can be queued without a new gesture.
 * Call this after any cancel(), still inside the click.
 */
export function primeSpeechSynthesis() {
  const synth = globalThis.speechSynthesis;
  if (!synth || typeof synth.speak !== 'function' || !globalThis.SpeechSynthesisUtterance) {
    noteVoice('prime', 'brak');
    return false;
  }
  const activation = globalThis.navigator?.userActivation;
  if (activation && activation.isActive === false) {
    noteVoice('prime', 'poza gestem');
    return false;
  }
  bridgeOn = true;
  queueBridge();
  return true;
}

/** Stop queueing more silence. Do not cancel — that would drop the iOS unlock. */
export function suspendSpeechBridge() {
  bridgeOn = false;
}

function queueBridge() {
  if (!bridgeOn) return;
  const synth = globalThis.speechSynthesis;
  if (!synth || synth.speaking || synth.pending) return;
  const blip = new globalThis.SpeechSynthesisUtterance(' ');
  blip.volume = 0;
  blip.lang = 'en-GB';
  blip.rate = 2;
  blip.onend = () => {
    if (bridgeOn) globalThis.setTimeout(queueBridge, 60);
  };
  blip.onerror = (event) => {
    noteVoice('prime', event?.error || 'error');
    bridgeOn = false;
  };
  try {
    Promise.resolve(synth.resume?.()).catch(() => {});
    synth.speak(blip);
    noteVoice('prime', 'gest');
  } catch (err) {
    noteVoice('prime', err?.name || 'throw');
    bridgeOn = false;
  }
}

/**
 * Unlock an <audio> element for a later blob. Only call this on a tap that
 * does not start webkitSpeechRecognition — playing the element first hangs it.
 */
export function unlockHtmlAudio(audio) {
  if (!audio) {
    noteVoice('html-unlock', 'brak');
    return;
  }
  htmlReady = false;
  try {
    audio.setAttribute('playsinline', '');
    audio.src = SILENT_WAV;
    const played = audio.play();
    htmlReady = true;
    noteVoice('html-unlock', 'wywołane');
    Promise.resolve(played).then(() => {
      try { audio.pause(); } catch { /* already paused */ }
      noteVoice('html-unlock', 'ok');
    }).catch((err) => {
      htmlReady = false;
      noteVoice('html-unlock', err?.name || 'error');
    });
  } catch (err) {
    htmlReady = false;
    noteVoice('html-unlock', err?.name || 'throw');
  }
}

export function preferPlaybackSession() {
  const session = globalThis.navigator?.audioSession;
  if (!session) {
    noteVoice('sesja', 'brak');
    return;
  }
  try {
    session.type = 'playback';
    noteVoice('sesja', session.type || 'playback');
  } catch (err) {
    noteVoice('sesja', err?.name || 'error');
  }
}

export function stopProviderPlayback() {
  const source = activeSource;
  activeSource = null;
  try {
    source?.stop();
  } catch {
    /* already stopped */
  }
}

export async function playWithWebAudio(blob, win = globalThis, onStart) {
  const ctx = sharedAudioContext(win);
  if (!ctx || typeof ctx.decodeAudioData !== 'function') throw new Error('no-web-audio');
  if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
    try {
      await withTimeout(ctx.resume(), 800, win);
    } catch {
      /* resume outside a tap can hang; the caller falls back */
    }
  }
  if (ctx.state !== 'running') {
    throw Object.assign(new Error(`audio-${ctx.state}`), { name: `audio-${ctx.state}` });
  }
  const bytes = await blob.arrayBuffer();
  const buffer = await withTimeout(ctx.decodeAudioData(bytes.slice(0)), 4000, win);
  if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('bad-audio');
  const startedAt = ctx.currentTime;
  const t0 = typeof win.performance?.now === 'function' ? win.performance.now() : Date.now();
  const now = () => (typeof win.performance?.now === 'function' ? win.performance.now() : Date.now());
  await new Promise((resolve, reject) => {
    const source = ctx.createBufferSource();
    activeSource = source;
    source.buffer = buffer;
    source.connect(ctx.destination);
    let settled = false;
    let poll = 0;
    let endTimer = 0;
    let noted = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      win.clearTimeout(poll);
      win.clearTimeout(endTimer);
      if (activeSource === source) activeSource = null;
      if (err) reject(err);
      else resolve();
    };
    const noteStart = () => {
      if (noted) return;
      noted = true;
      onStart?.();
    };
    source.onended = () => finish();
    try {
      source.start();
    } catch (err) {
      finish(err);
      return;
    }
    const check = () => {
      if (settled) return;
      if (ctx.currentTime > startedAt + 0.05) {
        noteStart();
        return;
      }
      if (now() - t0 > 2500) finish(Object.assign(new Error('audio-did-not-start'), { name: 'audio-did-not-start' }));
      else poll = win.setTimeout(check, 200);
    };
    poll = win.setTimeout(check, 200);
    endTimer = win.setTimeout(() => finish(), Math.min(20000, buffer.duration * 1000 + 600));
  });
}

export function waitForAudioUnlock() {
  return unlockGate;
}

export function stopBrowserSpeech() {
  bridgeOn = false;
  const synth = globalThis.speechSynthesis;
  try {
    synth?.cancel();
  } catch {
    /* ignore */
  }
  for (const finish of speechWaiters) finish();
  speechWaiters.clear();
}

export function playHtmlAudio(audio, blob, onStart, win = globalThis) {
  if (!audio) return Promise.reject(Object.assign(new Error('no-html-audio'), { name: 'no-html-audio' }));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    let settled = false;
    let started = false;
    let cap = 0;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      win.clearTimeout(cap);
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve();
    };
    audio.onplaying = () => {
      started = true;
      onStart?.();
    };
    audio.onended = () => finish();
    audio.onerror = () => finish(Object.assign(new Error('html-audio'), { name: 'html-audio' }));
    audio.setAttribute('playsinline', '');
    audio.src = url;
    let played;
    try {
      played = audio.play();
    } catch (err) {
      finish(Object.assign(new Error(err?.name || 'html-audio'), { name: err?.name || 'html-audio' }));
      return;
    }
    Promise.resolve(played).catch((err) => {
      finish(Object.assign(new Error(err?.name || 'NotAllowedError'), { name: err?.name || 'NotAllowedError' }));
    });
    cap = win.setTimeout(() => {
      if (settled) return;
      if (!started) finish(Object.assign(new Error('html-did-not-start'), { name: 'html-did-not-start' }));
      else cap = win.setTimeout(() => finish(), 20000);
    }, 1500);
  });
}

export function speakBrowser(text, { lang = 'en-GB', rate = 0.96, onStart } = {}) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !globalThis.SpeechSynthesisUtterance) {
    return Promise.reject(new Error('no-speech-synthesis'));
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      suspendSpeechBridge();
      const utterance = new globalThis.SpeechSynthesisUtterance(String(text || ''));
      utterance.lang = lang;
      utterance.rate = rate;
      const voice = pickBritishVoice(synth.getVoices?.() || []);
      if (voice) {
        try { utterance.voice = voice; } catch { /* a fake voice must not cancel the utterance */ }
      }
      let settled = false;
      let startTimer = 0;
      let endTimer = 0;
      let heardStart = false;
      const cleanup = () => {
        speechWaiters.delete(finish);
        window.clearInterval(keepAlive);
        window.clearTimeout(startTimer);
        window.clearTimeout(endTimer);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const noteStart = () => {
        if (heardStart) return;
        heardStart = true;
        onStart?.();
      };
      speechWaiters.add(finish);
      utterance.onstart = noteStart;
      utterance.onend = finish;
      utterance.onerror = (event) => {
        const code = event?.error || 'speech-synthesis';
        fail(Object.assign(new Error(code), { name: code }));
      };
      const keepAlive = window.setInterval(() => {
        if (synth.speaking || synth.pending) {
          noteStart();
          Promise.resolve(synth.resume?.()).catch(() => {});
        }
      }, 1000);
      startTimer = window.setTimeout(() => {
        if (settled || heardStart) return;
        fail(Object.assign(new Error('speech-did-not-start'), { name: 'speech-did-not-start' }));
      }, 2000);
      endTimer = window.setTimeout(() => {
        if (heardStart || synth.speaking || synth.pending) finish();
        else fail(new Error('speech-did-not-start'));
      }, Math.min(120000, Math.max(4000, String(text || '').length * 80)));
      Promise.resolve(synth.resume?.()).catch(() => {});
      synth.speak(utterance);
    };
    const voices = synth.getVoices?.() || [];
    if (voices.length || !synth.addEventListener) {
      start();
      return;
    }
    const onVoices = () => {
      synth.removeEventListener?.('voiceschanged', onVoices);
      start();
    };
    synth.addEventListener('voiceschanged', onVoices);
    window.setTimeout(onVoices, 400);
  });
}

/**
 * Fresh recognizer every time. On iOS, reusing one after HTML audio has played
 * can hang with no result and no error (WebKit bug 321436).
 */
export function startBrowserRecognition({ lang = 'en-GB', continuous = true, onPartial, onStart, onError, onEnd, win = globalThis } = {}) {
  const Ctor = getRecognitionCtor(win);
  if (!Ctor) throw new Error('no-recognition');
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = true;
  try {
    recognition.continuous = Boolean(continuous);
  } catch {
    /* Some Safari builds reject continuous; one utterance still works. */
  }
  recognition.maxAlternatives = 1;
  let finalText = '';
  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const chunk = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalText += `${chunk} `;
      else interim += chunk;
    }
    onPartial?.(`${finalText} ${interim}`.replace(/\s+/g, ' ').trim());
  };
  recognition.onstart = () => onStart?.();
  recognition.onerror = (event) => {
    onError?.(event?.error || 'error');
  };
  recognition.onend = () => {
    onEnd?.(finalText.replace(/\s+/g, ' ').trim());
  };
  recognition.start();
  return recognition;
}
