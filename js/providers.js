import { parseTutorReply } from './tutor.js';

/**
 * Browser CORS, checked 8 October 2026 with Origin https://stop60.no,
 * https://jtaczala-cmyk.github.io and http://localhost:8080.
 *
 * OpenAI preflight (OPTIONS) on /v1/chat/completions, /v1/audio/speech and
 * /v1/audio/transcriptions returns Access-Control-Allow-Origin echoing the
 * page origin, and allows authorization + content-type. Unauthenticated
 * responses and GET /v1/models include the CORS header. A POST with an
 * invalid key currently comes back 401 without Access-Control-Allow-Origin,
 * so the browser reports a network error instead of the JSON body. GET
 * /v1/models still returns a readable 401, which is what "Sprawdź klucz" uses.
 *
 * xAI preflight and POST on /v1/chat/completions, /v1/tts and /v1/stt return
 * Access-Control-Allow-Origin: *. An invalid key is a readable JSON 400.
 */

export const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-luna',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-4.1-mini', 'gpt-4o-mini'],
    voices: ['coral', 'fable', 'nova', 'alloy', 'ash', 'verse', 'marin', 'shimmer'],
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.3',
    keyUrl: 'https://console.x.ai/',
    models: ['grok-4.3', 'grok-4.7', 'grok-4.6'],
    voices: ['eve', 'leo', 'ara', 'sal', 'rex'],
  },
};

export const BRITISH_TTS_INSTRUCTIONS =
  'Speak in a natural modern British English accent, like a friendly colleague from England on a building site. Clear and warm, not posh, not American, steady pace, no character voice.';

export const TRADE_KEYTERMS = [
  'consumer unit',
  'RCD',
  'RCBO',
  'MCB',
  'earthing',
  'trunking',
  'conduit',
  'isolator',
  'socket outlet',
  'megger',
  'SWA',
  'EICR',
];

export class ProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = details.status || 0;
    this.corsBlocked = Boolean(details.corsBlocked);
  }
}

export function activeModel(provider, model) {
  const trimmed = String(model || '').trim();
  if (trimmed) return trimmed;
  return PROVIDERS[provider].defaultModel;
}

export function redactSecrets(text, secret) {
  let out = String(text || '');
  if (secret) out = out.split(secret).join('••••');
  out = out.replace(/\bsk-[A-Za-z0-9_\-]{4,}/g, 'sk-••••');
  out = out.replace(/\bxai-[A-Za-z0-9_\-]{4,}/g, 'xai-••••');
  return out;
}

export function readErrorMessage(payload, status) {
  if (!payload || typeof payload !== 'object') return `HTTP ${status}`;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  if (typeof payload.message === 'string') return payload.message;
  return `HTTP ${status}`;
}

export function extractMessageText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function isReasoningModel(model) {
  return /^gpt-5/i.test(model) || /^o\d/i.test(model);
}

export function buildChatRequest({ provider, apiKey, model, messages, compat = false }) {
  const spec = PROVIDERS[provider];
  const chosen = activeModel(provider, model);
  const body = {
    model: chosen,
    messages,
  };
  if (!compat) {
    body.response_format = { type: 'json_object' };
    if (provider === 'openai' && isReasoningModel(chosen)) {
      body.max_completion_tokens = 1200;
      body.reasoning_effort = 'low';
    } else if (provider === 'openai') {
      body.max_tokens = 800;
      body.temperature = 0.7;
    } else {
      body.max_tokens = 800;
      body.temperature = 0.7;
    }
  } else {
    body.max_tokens = 800;
    body.temperature = 0.7;
  }
  return {
    url: `${spec.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    },
  };
}

export function buildSpeechRequest({ provider, apiKey, text, voice }) {
  const spec = PROVIDERS[provider];
  const spoken = String(text || '').slice(0, 1500);
  if (provider === 'xai') {
    return {
      url: `${spec.baseUrl}/tts`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: spoken,
          voice_id: voice || 'eve',
          language: 'en',
          speed: 0.95,
        }),
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      },
    };
  }
  return {
    url: `${spec.baseUrl}/audio/speech`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: voice || 'coral',
        input: spoken,
        instructions: BRITISH_TTS_INSTRUCTIONS,
      }),
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    },
  };
}

export function buildTranscriptionRequest({ provider, apiKey, audio, mime, filename }) {
  const spec = PROVIDERS[provider];
  const form = new FormData();
  const file = audio instanceof File ? audio : new File([audio], filename || 'speech.m4a', { type: mime || 'audio/mp4' });
  if (provider === 'xai') {
    form.append('model', 'grok-voice-transcribe-2.0');
    form.append('language', 'en');
    for (const term of TRADE_KEYTERMS) form.append('keyterm', term);
    form.append('file', file, file.name);
    return {
      url: `${spec.baseUrl}/stt`,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      },
    };
  }
  form.append('model', 'gpt-4o-mini-transcribe');
  form.append('language', 'en');
  form.append('prompt', `British English on a building site. Terms: ${TRADE_KEYTERMS.join(', ')}.`);
  form.append('file', file, file.name);
  return {
    url: `${spec.baseUrl}/audio/transcriptions`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    },
  };
}

async function send(url, init, fetchImpl) {
  const extra = {};
  if (!init.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    extra.signal = AbortSignal.timeout(30000);
  }
  try {
    return await fetchImpl(url, { ...init, ...extra });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProviderError('Połączenie trwało za długo. Sprawdź internet i spróbuj jeszcze raz.');
    }
    throw new ProviderError('Połączenie przerwane.', { corsBlocked: err instanceof TypeError });
  }
}

async function readBody(response) {
  const raw = await response.text();
  if (!raw) return { raw: '', data: null };
  try {
    return { raw, data: JSON.parse(raw) };
  } catch {
    return { raw, data: null };
  }
}

export async function chatComplete({ provider, apiKey, model, messages, fetchImpl = fetch, compat = false, _retried = false }) {
  const request = buildChatRequest({ provider, apiKey, model, messages, compat });
  const response = await send(request.url, request.init, fetchImpl);
  const { data, raw } = await readBody(response);
  if (!response.ok) {
    if (response.status === 400 && !_retried) {
      return chatComplete({
        provider,
        apiKey,
        model,
        messages,
        fetchImpl,
        compat: true,
        _retried: true,
      });
    }
    throw new ProviderError(redactSecrets(readErrorMessage(data, response.status) || raw, apiKey), {
      status: response.status,
    });
  }
  return parseTutorReply(extractMessageText(data));
}

export async function synthesizeSpeech({ provider, apiKey, text, voice, fetchImpl = fetch }) {
  const request = buildSpeechRequest({ provider, apiKey, text, voice });
  const response = await send(request.url, request.init, fetchImpl);
  const type = response.headers.get('content-type') || '';
  if (!response.ok || type.includes('json') || type.startsWith('text/')) {
    const { data, raw } = await readBody(response);
    throw new ProviderError(redactSecrets(readErrorMessage(data, response.status) || raw, apiKey), {
      status: response.status,
    });
  }
  return response.blob();
}

export async function transcribeAudio({ provider, apiKey, audio, mime, filename, fetchImpl = fetch }) {
  const request = buildTranscriptionRequest({ provider, apiKey, audio, mime, filename });
  const response = await send(request.url, request.init, fetchImpl);
  const { data, raw } = await readBody(response);
  if (!response.ok) {
    throw new ProviderError(redactSecrets(readErrorMessage(data, response.status) || raw, apiKey), {
      status: response.status,
    });
  }
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new ProviderError('Transkrypcja jest pusta.', { status: response.status });
  return text;
}

export async function verifyKey({ provider, apiKey, fetchImpl = fetch }) {
  const response = await send(
    `${PROVIDERS[provider].baseUrl}/models`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    },
    fetchImpl,
  );
  const { data, raw } = await readBody(response);
  if (response.ok) return { ok: true, status: response.status };
  return {
    ok: false,
    status: response.status,
    message: redactSecrets(readErrorMessage(data, response.status) || raw, apiKey),
  };
}
