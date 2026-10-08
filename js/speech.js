/** Browser speech. iOS Safari has webkitSpeechRecognition (since 14.5, including iOS 26) but only partial support. */

const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export function getRecognitionCtor(win = globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function mediaRecorderSupported(win = globalThis) {
  return typeof win.MediaRecorder !== 'undefined' && Boolean(win.navigator?.mediaDevices?.getUserMedia);
}

export function describeInputPath({ inputMode, hasRecognition, hasRecorder }) {
  if (inputMode === 'type') return 'type';
  if (inputMode === 'record') return hasRecorder ? 'record' : 'type';
  if (inputMode === 'browser') {
    if (hasRecognition) return 'browser';
    return hasRecorder ? 'record' : 'type';
  }
  if (hasRecognition) return 'browser';
  if (hasRecorder) return 'record';
  return 'type';
}

export function pickRecorderMime(isSupported) {
  const preferred = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const type of preferred) {
    try {
      if (isSupported(type)) return type;
    } catch {
      /* ignore broken detectors */
    }
  }
  return '';
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

export function unlockAudio(audio) {
  if (!audio || audioUnlocked) return unlockGate;
  audioUnlocked = true;
  audio.src = SILENT_WAV;
  const played = audio.play();
  unlockGate = (played || Promise.resolve())
    .then(() => {
      audio.pause();
    })
    .catch(() => {
      audioUnlocked = false;
    });
  const synth = globalThis.speechSynthesis;
  if (synth && typeof synth.speak === 'function' && globalThis.SpeechSynthesisUtterance) {
    try {
      const blip = new globalThis.SpeechSynthesisUtterance(' ');
      blip.volume = 0;
      blip.lang = 'en-GB';
      synth.resume?.();
      synth.speak(blip);
    } catch {
      /* ignore unlock failures */
    }
  }
  return unlockGate;
}

export function waitForAudioUnlock() {
  return unlockGate;
}

export function stopBrowserSpeech() {
  const synth = globalThis.speechSynthesis;
  try {
    synth?.cancel();
  } catch {
    /* ignore */
  }
}

export function speakBrowser(text, { lang = 'en-GB', rate = 0.96 } = {}) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !globalThis.SpeechSynthesisUtterance) {
    return Promise.reject(new Error('no-speech-synthesis'));
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      const utterance = new globalThis.SpeechSynthesisUtterance(String(text || ''));
      utterance.lang = lang;
      utterance.rate = rate;
      const voice = pickBritishVoice(synth.getVoices?.() || []);
      if (voice) utterance.voice = voice;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearInterval(keepAlive);
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearInterval(keepAlive);
        reject(new Error('speech-synthesis'));
      };
      const keepAlive = window.setInterval(() => {
        if (synth.speaking) synth.resume?.();
        else window.clearInterval(keepAlive);
      }, 4000);
      synth.resume?.();
      synth.speak(utterance);
      window.setTimeout(finish, Math.min(120000, Math.max(4000, String(text || '').length * 80)));
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
export function startBrowserRecognition({ lang = 'en-GB', onPartial, onError, onEnd, win = globalThis } = {}) {
  const Ctor = getRecognitionCtor(win);
  if (!Ctor) throw new Error('no-recognition');
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = true;
  try {
    recognition.continuous = true;
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
  recognition.onerror = (event) => {
    onError?.(event?.error || 'error');
  };
  recognition.onend = () => {
    onEnd?.(finalText.replace(/\s+/g, ' ').trim());
  };
  recognition.start();
  return recognition;
}
