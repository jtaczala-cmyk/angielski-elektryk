# Angielski elektryk

A static British English conversation tutor for a Polish electrician working in Norway. The screen is in Polish. The chat, the corrections, and the spoken replies are in British English.

There is no build step and no server. GitHub Pages serves this repository from the main branch root, so the app lives at `/angielski-elektryk/` (for example `https://jtaczala-cmyk.github.io/angielski-elektryk/`, which redirects to `https://stop60.no/angielski-elektryk/`). Asset paths are relative, so the same files work in that subfolder and from a local static server.

## Dla Jacka

Otwórz stronę w Safari na iPhonie. Najwygodniej dodać ją do ekranu początkowego: **Udostępnij → Do ekranu początkowego**.

1. Wejdź w **Ustawienia** i wklej swój klucz API (OpenAI albo xAI). Klucz zostaje tylko w pamięci tej przeglądarki. Ta strona nie ma serwera i nigdzie go nie zapisuje poza telefonem.
2. Klucz OpenAI tworzysz na [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Klucz xAI na [console.x.ai](https://console.x.ai/).
3. To kosztuje trochę. Płacisz dostawcy za tekst i osobno za czytanie na głos. Krótka wymiana to zwykle grosze albo ułamek korony, dłuższa sesja się sumuje. Ustaw limit wydatków w panelu dostawcy. Przycisk **Sprawdź klucz** tylko pyta, czy klucz jest ważny.
4. Na ekranie **Rozmowa** stuknij pomarańczowy przycisk i mów po angielsku. Drugie stuknięcie wysyła. Możesz też wpisać zdanie. Partner odpowiada po brytyjsku, na głos, dopytuje i delikatnie poprawia.
5. Nowe zwroty wpadają do **Słówek**. Powtórki liczy algorytm SM-2 (znowu zostaje na dziś, „Dobrze” odkłada kartę o dzień, potem o sześć, potem coraz rzadziej). **Wymowa** czyta brytyjskim głosem.

Bez klucza działa **tryb próbny**: krótka, zapisana w telefonie odpowiedź, żeby dało się poklikać. To nie jest model.

Na iPhonie włącz dyktowanie i dodaj język English (UK): **Ustawienia → Ogólne → Klawiatura → Dyktowanie**. Pierwsze stuknięcie włącza dźwięk, bo iOS nie pozwala stronie mówić bez gestu.

## What it does

- Free conversation with follow-up questions, level A2–C1, and gentle corrections (grammar, word choice, unnatural or American phrasing) plus an optional Polish hint.
- Topic starters: site work, installation, testing, clients and foremen, HSE, a job interview, small talk, or a free subject.
- Personal word list with Polish translation, an example sentence, and SM-2 review. A starter deck of UK electrical language is included (consumer unit, RCD, RCBO, trunking, earthing, megger, and the rest).
- Speech in: browser dictation in `en-GB` where it exists, otherwise a recording sent to the provider, and always a text box.
- Speech out: provider TTS with a British voice, falling back to `speechSynthesis` and an `en-GB` voice.

## API keys

The key is written only to `localStorage` (`ae.settings.v1`) on the device. Requests go from the browser straight to the provider with `Authorization: Bearer`. Nothing in this repository is a key. The page sets `referrerPolicy: no-referrer` and strips key-shaped strings out of error text before showing it.

Defaults, both overridable in settings:

| Provider | Chat | Speech out | Speech in |
| --- | --- | --- | --- |
| OpenAI | `gpt-5.6-luna` (`reasoning_effort: low`, JSON mode) | `gpt-4o-mini-tts` with a British-accent instruction, voice `coral` | `gpt-4o-mini-transcribe`, language `en` |
| xAI | `grok-4.3` on `https://api.x.ai/v1/chat/completions` | `POST /v1/tts`, voice `eve` (documented British accent; `leo` is the other British voice) | `POST /v1/stt`, model `grok-voice-transcribe-2.0` |

`gpt-5.6-luna` is OpenAI’s current low-cost chat model (about $0.20 / $1.20 per million input / output tokens as published in July 2026). `grok-4.3` is the cheaper Grok default; `grok-4.7` is there if you want the flagship. Prices move, so the settings screen points at the provider’s own pricing page. GPT-5 style models send `max_completion_tokens` and `reasoning_effort`. Older ids such as `gpt-4o-mini` send `max_tokens` and `temperature`. If a model rejects JSON mode with HTTP 400, the app retries once without it and still parses a JSON object out of the text.

## CORS, checked 8 October 2026

A static page can call these APIs. Preflight was checked with `Origin: https://stop60.no`, `https://jtaczala-cmyk.github.io`, and `http://localhost:8080`.

**OpenAI.** `OPTIONS` on `/v1/chat/completions`, `/v1/audio/speech`, and `/v1/audio/transcriptions` returned 200 with `Access-Control-Allow-Origin` echoing the page origin, `Access-Control-Allow-Headers: authorization, content-type`, and `Access-Control-Allow-Methods: GET, OPTIONS, POST`. Unauthenticated responses and `GET /v1/models` also include the CORS header (the models call goes through their wasm proxy). A `POST` with an **invalid** key currently returns 401 **without** `Access-Control-Allow-Origin` (`x-openai-authorization-error`), so the browser reports a network error instead of the JSON body. `GET /v1/models` with a bad key still returns a readable 401, which is why **Sprawdź klucz** uses that endpoint. A valid key was not available here; successful calls are expected to follow the same proxy that already sets the CORS header on the unauthenticated path.

**xAI.** `OPTIONS` and `POST` on `/v1/chat/completions`, `/v1/tts`, and `/v1/stt` returned `Access-Control-Allow-Origin: *` and allow the authorization and content-type headers. An invalid key is a readable JSON 400. The `file` field is sent last on `/v1/stt`, which is what their speech-to-text API requires.

## Speech on an iPhone 15 Pro

Safari on iOS has `webkitSpeechRecognition` since iOS 14.5, including iOS 26, with partial support. The app sets `lang` to `en-GB`, `interimResults`, and `continuous` when the browser allows it. Dictation has to be enabled, with English (UK) downloaded.

WebKit bug 321436: after an `<audio>` element plays, the same recognizer can hang with no result and no error. The app aborts any live recognizer before playback and creates a **new** recognizer for the next turn.

If recognition is missing or fails, the app records with `MediaRecorder`. iOS Safari typically produces `audio/mp4`, which both OpenAI transcriptions and xAI `/v1/stt` accept (sent as `.m4a`). The text field is always there.

Playback uses one `<audio playsinline>` element. The first tap plays a silent clip on that element so later speech is allowed under iOS autoplay rules. If provider TTS fails, the app uses `speechSynthesis`, prefers an `en-GB` voice (Daniel, Kate, Serena, …), and calls `resume()` while speaking so iOS does not pause a long utterance.

The layout is a single column, thumb-reachable: topics along the top, the transcript in the middle, the composer and the large talk button above the tab bar, with safe-area padding for the iPhone home indicator. `visualViewport` keeps the composer above the keyboard.

## Tests

```bash
node --test tests/tutor.test.js
```

The tests mock `fetch`. They check the real request shapes (URLs, headers, JSON mode, reasoning effort, TTS instructions, multipart field order) and the SM-2, word-list, and demo-correction behaviour. No test calls a live provider.

## Offline shell

`sw.js` caches the app shell for a flaky site connection. Conversation and speech still need the network and a key. The web app manifest and icons are set up so the page can be installed.
