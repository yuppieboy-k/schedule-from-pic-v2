# Schedule from Pic 

A small, single-page **PWA that turns a photo of a flyer, poster, or
screenshot into a calendar event**. Snap a picture, the app extracts the
**title, date, time, location, and description** using a free
vision-capable LLM, lets you review/edit the fields, and then sends you
to **Google Calendar**, downloads an **Apple/Outlook `.ics`** file, or
copies the event as JSON.

No build step, no backend, no account, no credit card. Bring your own
free API key from Google, Groq, or HuggingFace.

## Features

- 📷 **Take a photo or pick from library** — uses the native camera on
  mobile (`capture="environment"`)
- 🪄 **Smart extraction** — uses a vision LLM that "reads" the image
  the way a human would (handles stylized fonts, multi-language, overlapping
  graphics, etc.)
- 🔁 **Auto-failover across 3 free providers** — starts with your
  preferred one, falls back to the others on rate-limit or error
- 🌑 **Fully offline fallback** — Tesseract.js OCR + rule-based parser
  kicks in when no network is available
- ✏️ **Editable review form** — every field can be tweaked before export;
  per-field confidence dots (●●● / ●●○ / ●○○) show how sure the model is
- 📅 **Three export targets**:
  - **Google Calendar** — one-click deep link
  - **Apple Calendar / Outlook** — downloads a valid RFC 5545 `.ics` file
  - **Copy as JSON** — for power users / scripting
- 🌓 **Light / Dark / Auto theme** — frosted glass over an animated
  mesh gradient (Apple-inspired)
- 📱 **Installable PWA** — add to home screen, runs offline, no
  address bar
- 🔒 **100% client-side** — your image and API keys never touch any
  server you don't choose. Keys are stored in `localStorage` only.

## How it works

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Pick or shoot   │ -> │  Vision LLM      │ -> │  Review & tweak  │
│  a photo         │    │  (Gemini/Groq/   │    │  (form with      │
│                  │    │   HuggingFace)   │    │   confidence)    │
└──────────────────┘    └──────────────────┘    └──────────────────┘
                                                        │
                                                        ▼
                                                ┌──────────────────┐
                                                │ Export to:       │
                                                │  • Google        │
                                                │  • .ics (Apple)  │
                                                │  • JSON          │
                                                └──────────────────┘
```

If all cloud providers are unreachable **and** you're offline, the app
falls back to **Tesseract.js** running on-device (the WASM blob is ~10 MB
and is loaded only on first offline use, then cached).

## How to run

The app is a static site with no build step. You just need to serve the
project folder over HTTP.

### Option 1: Python (recommended — no install needed if you have Python)

```bash
# 1. Move into the project folder
cd "/Users/kwc/Documents/Vibe Coding/Schedule from pic"

# 2. Start a static server on port 8765
python3 -m http.server 8765
```

Then open <http://localhost:8765/index.html> in any browser.

To stop the server, press `Ctrl+C` in the terminal where it's running.

### Why a server instead of double-clicking `index.html`?

The app uses native ES modules (`<script type="module">`), which
browsers refuse to load from `file://` URLs. A static server gives you a
real `http://` origin. The service worker (for PWA install + offline
support) also requires `http://` or `https://`.

### Other one-liners (any of these work)

```bash
# Node.js
npx serve -l 8765

# PHP
php -S localhost:8765

# Ruby
ruby -run -e httpd . -p 8765
```

## Get a free API key (BYOK — "Bring Your Own Key")

The app needs **one** free API key to work online. All three providers
below offer a genuinely free tier — no credit card, no trial that
expires. Pick whichever you like; the app will auto-failover to the
others if your first choice rate-limits or errors.

| Provider | Free tier | Sign up | Get key |
|---|---|---|---|
| **Google Gemini 3.6 Flash** (recommended) | 15 RPM, 1,500 req/day | [aistudio.google.com](https://aistudio.google.com/) | [API key page](https://aistudio.google.com/apikey) |
| **Groq Llama 3.2 Vision** (fastest) | 30 RPM, ~14,400 req/day | [console.groq.com](https://console.groq.com/) | [Keys page](https://console.groq.com/keys) |
| **HuggingFace Qwen2-VL** (open source) | Rate-limited but free | [huggingface.co](https://huggingface.co/) | [Token settings](https://huggingface.co/settings/tokens) |

> **Capacity sanity check:** Gemini's free tier allows 1,500 requests
> per day. A user who extracts 50 flyers/month = 600/year, which is
> 0.12% of the daily free capacity. **Total cost for normal personal
> use: $0.**

### How to paste your key into the app

1. Open the app in your browser.
2. Tap the **⚙ gear** in the top-right of the home screen.
3. The settings drawer slides in. Paste your Gemini key (or any of the
   others) into the corresponding field.
4. Pick a default provider (Gemini is the recommended default).
5. Close the drawer — keys are saved to `localStorage` automatically.

That's it. The home screen's "Take Photo" / "Choose Photo" buttons are
now fully functional.

> Your keys **never leave your device** — they're stored only in your
> browser's `localStorage`, and the app calls the provider APIs
> directly from your device. No proxy server is involved.

## Deploy (free, ~30 seconds)

The app needs **HTTPS** for `getUserMedia()` (camera) and for the
service worker. All of these provide HTTPS for free.

### Easiest: Netlify Drop

1. Visit <https://app.netlify.com/drop>
2. Drag the **entire `Schedule from pic` folder** onto the page
3. You instantly get a `https://<random-name>.netlify.app` URL
4. Open it on your phone, install to home screen

### Other free options

| Host | Command / URL | Notes |
|---|---|---|
| **Surge.sh** | `npm i -g surge && surge` | CLI, `https://<name>.surge.sh` |
| **Cloudflare Pages** | Drag-drop at [pages.cloudflare.com](https://pages.cloudflare.com/) | `https://<name>.pages.dev` |
| **GitHub Pages** | Push folder to repo → enable Pages | `https://<user>.github.io/<repo>` |

> **Caveat:** Once you deploy, open the deployed URL in **Safari on
> iOS** (or Chrome on Android), tap Share → "Add to Home Screen" to
> install as a real PWA. The service worker then caches the app shell
> so the app works offline after first launch.

### Updating the deployed app

When you change any of the local files, the service worker will keep
serving the old cached version. To force an update:

1. Bump the cache version in `sw.js` — change `CACHE_VERSION = 'schedule-v2'`
   to `schedule-v3` (or higher).
2. Re-deploy.
3. On the phone, close and reopen the app (or pull-to-refresh in
   Chrome's install dialog). The new SW replaces the old one and
   re-caches the updated assets.

## How to test

Three layers of tests, all run from the project root.

### 1. Unit tests (Node, no browser)

```bash
node --test tests/parser.test.mjs tests/export.test.mjs tests/prompt.test.mjs
```

**41 tests** covering the date/time/address/title parser, the
`.ics` generator (RFC 5545), and the LLM-response validator.

### 2. Manual end-to-end walkthrough

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765/index.html> in Chrome or Safari and:

1. **Open settings** (⚙ top-right). Paste a Gemini key. Close the drawer.
2. **Tap "Choose Photo"** and pick any flyer-style image.
3. **Tap "Extract Event →"**. Within 2–5 seconds you should see the
   review form pre-filled with title, date, time, location, description.
4. **Tap "Continue →"**. The export screen shows three buttons.
5. **Tap "Google Calendar"** — a new tab opens with the event template.
6. **Tap "Apple / Outlook"** — a `.ics` file downloads; double-clicking
   it on macOS opens Calendar, on iOS opens the system calendar.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell — 5 screens + settings drawer. |
| `styles.css` | Single stylesheet, dark/light theme, frosted glass, mesh gradient, spring easing. |
| `app.js` | State machine, image downscale, event delegation, form binding. |
| `prompt.js` | Extraction prompt + JSON schema + LLM-response validator. |
| `providers.js` | Three vision-LLM adapters (Gemini, Groq, HF) + auto-failover. |
| `export.js` | Hand-written RFC 5545 `.ics` generator + Google Calendar deep-link builder. |
| `parser.js` | Rule-based parser (offline Tesseract mode + sanity-checks). |
| `ocr.js` | Lazy-loaded Tesseract.js wrapper for the offline fallback. |
| `sw.js` | Cache-first service worker. |
| `manifest.json` | PWA manifest. |
| `icon.svg` | Home-screen / app-drawer icon. |
| `tests/*.test.mjs` | Node `node --test` unit tests. |
| `README.md` | This file. |

## Project structure

```
Schedule from pic/
├── index.html              # App shell (5 screens + settings drawer)
├── styles.css              # Design system, light/dark, animations
├── app.js                  # State machine + image downscale + form binding
├── prompt.js               # JSON schema + system prompt + response validator
├── providers.js            # Gemini / Groq / HF adapters + auto-failover
├── export.js               # .ics generator + Google Calendar URL builder
├── parser.js               # Rule-based offline parser
├── ocr.js                  # Tesseract.js lazy loader (offline mode)
├── manifest.json           # PWA manifest
├── sw.js                   # Cache-first service worker
├── icon.svg                # Calendar-themed icon
├── README.md               # This file
└── tests/
    ├── parser.test.mjs     # 18 tests for parser.js
    ├── export.test.mjs     # 13 tests for export.js
    └── prompt.test.mjs     # 10 tests for prompt.js
```

## Design notes

### Apple-inspired visual design

The app uses the same visual language as the other projects in this
"Vibe Coding" folder:

- **Frosted glass window** via `backdrop-filter: blur(30px) saturate(180%)`
- **Layered mesh gradient** background (subtly animated)
- **Spring easing** (`cubic-bezier(0.34, 1.56, 0.64, 1)`) on button
  press, drawer slide-in, and toast pop-in
- **SF Pro** system font stack (no Google Fonts download — keeps the
  app truly offline)

### Multi-provider auto-failover

`providers.js` exports `extractWithFailover(startingWith, dataUrl, keys, opts)`,
which tries providers in order:

1. **Primary** (whatever the user picked in settings)
2. **Gemini → Groq → HuggingFace** for the remaining two
3. **On-device Tesseract** as a last resort if `navigator.onLine` is
   false (the SW correctly excludes LLM API hosts from cache so a
   network failure is detected by `fetch()` throwing, not by stale data)

A 429 or 5xx from any provider is treated as "try the next one." A
"no API key configured" provider is silently skipped (not tried).

### Image downscale

Vision-LLM APIs charge by input token count and many of them
downscale uploaded images server-side anyway. To save your free
quota, `downscaleImage()` in `providers.js` uses a `<canvas>` to
resize the image to **max 1600px** on its longest edge and re-encodes
as JPEG at quality 0.85. For a typical flyer photo this takes the
file from ~3 MB to ~250 KB — a 10× reduction in upload size and
token cost.

### `.ics` line folding (RFC 5545)

Apple Calendar is strict about line lengths. `export.js` implements
proper 75-octet line folding with leading-space continuations and
CRLF terminators, and escapes `\`, `,`, `;`, and newlines per
§3.3.11. The 13 tests in `export.test.mjs` cover all of these
behaviors.

### Tesseract.js lazy load

Tesseract is **~10 MB** of WASM + worker scripts. We don't want that
on the initial download. `ocr.js` injects the script tag only when
the offline path is actually taken, and the service worker then
caches it for next time.

## Troubleshooting

- **"No API keys configured"** — Open ⚙ settings and paste at least
  one key.
- **"Gemini 400: API key not valid"** — Double-check the key starts
  with `AIza`. The free key is the one from **Google AI Studio**, not
  the Google Cloud Console.
- **"Groq 401"** — Groq keys start with `gsk_`.
- **"HuggingFace 401"** — Make sure the token has the default
  read/inference scope. The free tier token works.
- **"All providers failed"** — Check your internet connection. If
  you're offline, the app should automatically fall back to
  Tesseract.js (and load it on first use).
- **Camera button doesn't open the camera** — Make sure the app is
  served over HTTPS (or `http://localhost`). `getUserMedia()` is
  blocked on plain HTTP origins.
- **Stale PWA after I edited the code** — Bump `CACHE_VERSION` in
  `sw.js` and reload.

## License

MIT — do whatever you want.
