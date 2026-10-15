# Schedule from Pic — Project Documentation

A complete file-by-file reference for the **Schedule from Pic** PWA. This
document describes every file in the project, what it does, how it
interacts with the others, and the design decisions behind it.

> **TL;DR.** A static, no-build, installable PWA that turns a photo of
> any flyer / poster / screenshot into a calendar event. The frontend
> is vanilla HTML + CSS + ES-module JS. Image understanding is done by
> a free vision-LLM (Gemini 3.6 Flash, Groq Llama 3.2 Vision, or
> HuggingFace Qwen2-VL), with a Tesseract.js fallback for offline use.
> Event export targets Google Calendar (deep link) and Apple/Outlook
> (RFC 5545 `.ics` download).

---

## Table of Contents

1. [Project layout at a glance](#1-project-layout-at-a-glance)
2. [Architecture & data flow](#2-architecture--data-flow)
3. [File reference](#3-file-reference)
4. [End-to-end walkthroughs](#4-end-to-end-walkthroughs)
5. [State machine reference](#5-state-machine-reference)
6. [Settings & localStorage schema](#6-settings--localstorage-schema)
7. [Build, deploy, test](#7-build-deploy-test)
8. [Design notes & conventions](#8-design-notes--conventions)

---

## 1. Project layout at a glance

```
Schedule from pic/
├── index.html              # App shell: 5 screens + settings drawer
├── styles.css              # Design system, light/dark/auto theme
├── app.js                  # State machine, event wiring, settings persistence
├── prompt.js               # LLM system prompt + JSON schema + response validator
├── providers.js            # Gemini / Groq / HF adapters + auto-failover
├── export.js               # RFC 5545 .ics generator + Google Calendar URL builder
├── parser.js               # Rule-based parser (offline Tesseract mode)
├── ocr.js                  # Tesseract.js lazy loader (offline fallback)
├── sw.js                   # Cache-first service worker
├── manifest.json           # PWA manifest
├── icon.svg                # Calendar-themed home-screen icon
├── README.md               # User-facing quickstart
├── DOCUMENTATION.md        # ← this file
└── tests/
    ├── parser.test.mjs     # 18 unit tests for parser.js
    ├── export.test.mjs     # 13 unit tests for export.js (.ics + Google URL)
    └── prompt.test.mjs     # 10 unit tests for prompt.js
```

**Totals:** ~2,700 lines across 12 source files + 3 test files. ~135 KB
on disk. Zero build step, zero npm dependencies at runtime.

---

## 2. Architecture & data flow

### High-level

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│                                                                  │
│  ┌──────────┐  pick/shoot   ┌──────────┐  extract     ┌────────┐ │
│  │  Home    │ ────────────► │ Preview  │ ──────────► │Extract.│ │
│  │  screen  │               │  screen  │             │  spin  │ │
│  └──────────┘               └──────────┘             └───┬────┘ │
│       ▲                                                   │      │
│       │ settings                              ┌──────────┘      │
│       │ drawer                                 ▼                 │
│  ┌──────────┐  save    ┌───────────────────────────────┐         │
│  │ Settings │ ◄─────── │   providers.js (failover)    │         │
│  │ drawer   │  keys    │   or ocr.js (offline)         │         │
│  └──────────┘          └───────────┬───────────────────┘         │
│                                    │ event (validated)          │
│                                    ▼                            │
│                            ┌──────────────┐                     │
│                            │   Review     │ ◄── user edits      │
│                            │   form       │                     │
│                            └──────┬───────┘                     │
│                                   │                             │
│                                   ▼                             │
│                            ┌──────────────┐  Google / .ics /JSON│
│                            │   Export     │ ──────────────────► │
│                            │   screen     │                     │
│                            └──────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

### Module dependency graph

```
        index.html
            │
            ▼
         app.js  ──────────────────────────►  (entry point; loaded as <script type="module">)
            │
            ├─► providers.js ──► prompt.js  (each adapter validates via validateAndNormalize)
            ├─► export.js                          (no deps; pure RFC 5545 builder)
            ├─► ocr.js ──► parser.js               (Tesseract → raw text → heuristic event)
            └─► (transitively) parser.js           (also exported; tested in isolation)
```

There is no bundler. The browser loads each file via a separate HTTP
request, and ES-module `import` statements resolve at runtime. This
keeps the project completely static and dev-tools friendly (open
DevTools → Sources and inspect any file).

### Where data lives

| Data | Lives in | Cleared on |
|---|---|---|
| API keys | `localStorage` (key `schedule-from-pic:settings:v1`) | "Clear all data" button in settings |
| Theme preference | same `localStorage` object | same |
| Default provider | same | same |
| Currently-picked image | In-memory `state.imageFile` + object URL | `startOver()` or page reload |
| Extracted event | In-memory `state.event` | `startOver()` or page reload |
| Cached app shell | `CacheStorage` (managed by `sw.js`) | When `CACHE_VERSION` changes |
| Cached Tesseract.js | `CacheStorage` (CDN-cached) | When evicted by browser |

Nothing is sent to any server except the image bytes themselves, which
go directly from the browser to whichever LLM provider the user picks
(only when they tap **Extract Event →**).

---

## 3. File reference

### 3.1 `index.html` — app shell

**Role.** Defines the entire DOM of the app: 5 full-screen "screens"
plus a settings drawer and a toast. Contains zero JavaScript and zero
inline styles. The structure is what `app.js` mutates and what
`styles.css` styles.

**Sections (siblings of each other inside `<main class="app-window">`):**

| `<section>` | `data-screen` | Purpose |
|---|---|---|
| `.screen-home` | `home` | Title, subtitle, two big action buttons, settings link, privacy badge |
| `.screen-preview` | `preview` | The picked image + "Re-pick" / "Extract Event →" buttons |
| `.screen-extracting` | `extracting` | Spinner + live status text + Cancel |
| `.screen-review` | `review` | Editable form: title, start/end, location, description, raw text |
| `.screen-export` | `export` | Event summary + three big "add to calendar" buttons |

**Other top-level elements:**

- `<div class="mesh-bg">` — the animated, blurred, two-layer mesh
  gradient that sits behind everything (`z-index: -1`).
- `<aside class="drawer" id="settings-drawer">` — the settings drawer
  (off-canvas panel that slides in from the right). Contains API-key
  fields, default-provider radios, theme radios, and a "Clear all
  data" button. Closes on backdrop click or X tap.
- `<div id="toast">` — transient status messages (e.g. "JSON copied",
  "Calendar file downloaded", error explanations).

**Action pattern.** All clickable elements that need JS handling use
`data-action="..."`. The single delegated click listener in `app.js`
reads the attribute and dispatches to the right handler. This avoids
per-button `addEventListener` calls and keeps the HTML declarative.

**File inputs.** Two hidden `<input type="file">` elements live in
the home screen:
- `#file-camera` — `accept="image/*" capture="environment"` — opens
  the rear camera on mobile.
- `#file-library` — `accept="image/*"` — opens the photo picker.
The "Take Photo" and "Choose Photo" buttons just call `.click()` on
the appropriate hidden input.

**Settings drawer inputs.** Each provider key field is a password
input (`type="password"`) with a `name` attribute matching the
provider id (`key-gemini`, `key-groq`, `key-huggingface`). The
default-provider radio group is named `default-provider`; the theme
group is `theme`. `app.js#commitSettings()` reads them by name and
serializes the result into `localStorage`.

**Scripts.** Exactly one: `<script type="module" src="./app.js">`,
loaded at the end of `<body>` so all DOM nodes exist when it runs.

**Lines:** 265.

---

### 3.2 `styles.css` — design system

**Role.** Single hand-written CSS file. No preprocessor, no
framework. Implements an Apple-inspired look (frosted glass over an
animated mesh gradient, spring-easing micro-interactions, light / dark
/ auto theme via a `data-theme` attribute on `<html>`).

**Structure (top to bottom):**

1. **Design tokens** (` :root` and `:root[data-theme="dark"]`,
   `:root[data-theme="light"]`).
   Defines every color, radius, and easing curve used in the rest of
   the file as a CSS custom property. Swapping the theme means setting
   one attribute on `<html>`; everything else cascades.

2. **Reset.** Minimal modern reset: `box-sizing: border-box`, full
   height on `html` / `body`, system font stack, baseline
   `line-height: 1.5`.

3. **Mesh gradient background.** Two pseudo-elements on `.mesh-bg`
   (`::before` and `::after`), each a stack of two radial gradients
   with a 24-second drift animation. `prefers-reduced-motion` disables
   the animation.

4. **App window.** The frosted-glass container `.app-window` uses
   `backdrop-filter: blur(30px) saturate(180%)` (with the
   `-webkit-` prefix for Safari). On wide screens (`min-width: 600px`)
   it gains rounded corners and a soft shadow; on phones it goes
   edge-to-edge.

5. **Screens.** The `.screen` class is a vertical flex column with a
   slide-in animation. Only one is visible at a time (the others are
   `hidden` via the HTML attribute). The animation is re-triggered each
   time the screen becomes visible (a small trick in `app.js#show`
   resets `style.animation`, reads `offsetHeight` to force a reflow,
   then clears the override).

6. **Screen headers.** Shared header pattern for the inner screens
   (preview / review / export): back button + centered title +
   spacer. The home screen's header is structurally similar but
   contains no back button.

7. **Big action cards.** `.big-action` is the "Take Photo" /
   "Choose Photo" / "Google Calendar" / "Download .ics" / "Copy as
   JSON" card. Has a `primary` modifier that paints it with a
   cyan→blue gradient. Icon, label, and hint sit in a row.

8. **Settings link.** `.settings-link` is the labeled "⚙ Settings"
   pill on the home screen (moved here from the header in the
   layout-redesign pass). Sits in a `.home-settings` row with a thin
   `border-top` divider above it.

9. **Review form.** Field labels in uppercase 12px, inputs with
   focus rings, a `data-level` attribute on `.conf` spans drives
   the `●●● / ●●○ / ●○○` confidence indicator (three colored dots
   via `::after` content).

10. **Buttons.** Generic `.btn` plus `.btn-primary` (gradient) and
    `.btn-ghost` (transparent) variants.

11. **Export summary + actions.** The export screen's event summary
    card and the three big action buttons.

12. **Drawer (settings).** Fixed-position aside that slides in from
    the right with a spring-easing animation. The backdrop fades in.

13. **Toast.** Fixed bottom-center pill that animates in/out via a
    `is-visible` class toggle.

**Lines:** 516.

---

### 3.3 `app.js` — state machine & glue

**Role.** The entry point. Loaded as `<script type="module">`. Imports
from the other modules, owns the in-memory `state` object, wires
every UI event, manages settings persistence, and orchestrates the
screen transitions.

**Top of file (lines 1-19).** Imports from `providers.js` (the
`extractWithFailover` helper and `downscaleImage`), `ocr.js`
(`ocrExtract`), and `export.js` (`generateICS`, `downloadICS`,
`googleCalendarURL`). Defines a mutable `state` object holding the
currently-picked file, its downscaled base64 form, the current blob
URL for the preview, the extracted event (if any), the current
`AbortController` for cancelling in-flight requests, and the name of
the last successful provider.

**Settings (lines 21-42).** Reads and writes a single
`localStorage` key, `schedule-from-pic:settings:v1`, that holds all
user preferences (three API keys, the default provider, the theme).
`getSettings()` returns a normalized shape with safe defaults.

**Theme (lines 44-59).** `applyTheme(theme)` sets
`data-theme="dark"` or `data-theme="light"` on `<html>`. `"auto"`
mode reads `prefers-color-scheme` and re-applies when the OS theme
changes. `initTheme()` is called once at boot.

**Screen routing (lines 61-78).** `show(name)` iterates over the
five `data-screen` sections, hides all but the one named, and
re-triggers the slide-in animation on the new one. Used by every
state transition.

**Toast (lines 80-93).** A tiny helper that shows the `#toast`
element for `ms` milliseconds (default 2.2 s) and then hides it. A
single global timer prevents overlapping toasts.

**File picking (lines 95-115).** `handleFileChosen(file)` runs when
either hidden file input fires:
1. Reject non-images with a toast.
2. Store the `File` in `state.imageFile`.
3. **Revoke the previous preview blob URL** (if any) to avoid a leak
   across multiple picks.
4. Create a **new** blob URL, store it in `state.previewUrl`, set it
   as the `<img id="preview-image">` `src`.
5. Call `show("preview")`.

The previous version of this function revoked the URL inside
`img.onload`, which caused the preview to be blank on some browsers
(the URL was being torn down before the browser finished painting).
The current version never revokes the in-use URL; it gets revoked
later in `startOver()`.

**Extraction (lines 117-165).** `startExtraction()` is the heart of
the app. It:
1. Validates that an image is picked.
2. Reads settings, checks `navigator.onLine` and whether at least one
   API key is configured.
3. Switches to the extracting screen and shows a status message.
4. Creates a new `AbortController` so the user can cancel.
5. Calls `downscaleImage()` on the file → 1600px JPEG, base64.
6. **Online + has keys:** calls `extractWithFailover(...)` which
   tries the user's default provider first, then the other two in
   registration order. Returns the first success.
7. **Offline:** calls `ocrExtract(...)`, which lazy-loads
   Tesseract.js, runs OCR on the device, then runs the rule-based
   `parseFromText()` from `parser.js`.
8. **Online but no keys:** throws a user-friendly error pointing at
   the settings drawer.
9. On success: stores the event in `state.event`, populates the
   review form, and shows it.
10. On failure: shows the preview screen again and toasts the error
    message (unless the user cancelled, in which case it just goes
    back silently).

`setExtractingStatus(msg)` is a tiny helper that updates the
"Reading your image…" status line.

**Review form (lines 168-225).** `populateReview(event)` takes the
LLM's response and writes the fields into the form:
- `title` → text input
- `startDateTime` / `endDateTime` → `<input type="datetime-local">`
  (via `toLocalInputValue`, which converts an ISO UTC string to the
  `YYYY-MM-DDTHH:MM` format those inputs expect)
- `location` → text input
- `description` → textarea
- `rawText` → a `<pre>` in a collapsible `<details>` (lets the user
  see exactly what the LLM read from the image)
- `confidence` → sets `data-level="high|medium|low"` on each `.conf`
  span, which CSS renders as `●●● / ●●○ / ●○○`

`readReviewForm()` reads the form back, converting the local datetime
values back to UTC ISO strings via `fromLocalInputValue`. This is
where the user's edits to the LLM's output are captured.

`updateMapsLink()` builds a Google Maps deep link for the current
location value and shows/hides the "📍 Maps" pill.

**Export (lines 227-264).** `goToExport()` validates the form (title
and start required, end defaults to +1h), updates the export
screen's summary, sets the Google Calendar link's `href` via
`googleCalendarURL(event)`, and shows the screen.

`formatRange(start, end)` formats the start–end range as
`<date>, <time> → <date>, <time>` using the user's locale.

`copyJson()` serializes the event to pretty-printed JSON and copies
it to the clipboard via the `navigator.clipboard` API.

**Settings drawer (lines 266-311).** `openSettings()` populates the
drawer fields from `localStorage` and reveals it.
`closeSettings()` calls `commitSettings()` first (so any pending
changes are saved) then hides. `commitSettings()` is also bound
directly to the `change` event of every input, so changes are saved
on every keystroke / radio change without needing to close the
drawer. `clearAllData()` wipes the localStorage key, toasts
"All data cleared", closes the drawer, and reloads the page after
600 ms.

**Event wiring (lines 313-384).** `bindEvents()` runs once at boot
and does four things:
1. Wires the two file inputs to `handleFileChosen`.
2. Installs **one** delegated `click` listener on `document` that
   reads `data-action` and dispatches. This is the entire app's
   click handling — every action button in the HTML drives a single
   switch statement.
3. Wires the location `<input>` to `updateMapsLink` on every
   keystroke.
4. Wires settings inputs to `commitSettings` so they save as the
   user types.
5. Registers the service worker (`./sw.js`) for PWA install + offline.

**Boot (lines 381-384).** `initTheme(); bindEvents(); show("home");`
— that's it. Three statements and the app is running.

**Lines:** 384.

---

### 3.4 `prompt.js` — LLM prompt & validator

**Role.** Single source of truth for the prompt the vision-LLM sees
and the validator that turns its response into a clean event object.
Imported by `providers.js` and (transitively) by `app.js` via
`tests/prompt.test.mjs`.

**Three exports:**

1. **`EVENT_SCHEMA`** — a plain JavaScript object that mirrors a
   JSON Schema. The properties are: `title` (string, required),
   `startDateTime` (ISO 8601 string, required), `endDateTime` (ISO
   8601, optional), `allDay` (boolean, optional), `location`
   (string, optional), `description` (string, optional), `confidence`
   (object with per-field `high|medium|low` strings, optional),
   `rawText` (string, optional). The schema is inlined into the
   system prompt so the LLM sees it as part of its instructions.

2. **`SYSTEM_PROMPT`** — a multiline template string instructing the
   LLM to act as a precise calendar extractor. It tells the model to:
   - Return **only** JSON (no prose, no markdown fences).
   - Omit fields that aren't in the image rather than inventing.
   - Use ISO 8601 with timezone offset for dates.
   - Pick the most prominent text as the title.
   - Be honest about confidence (mark uncertain fields as "low").

3. **`validateAndNormalize(raw)`** — the validator. Accepts either
   a string (the raw LLM response) or an object (already parsed). It:
   - Strips markdown fences if present (` ``` json ` wrapping).
   - Parses JSON.
   - Verifies the response is an object, not an array.
   - Trims and requires a non-empty `title` and `startDateTime`.
   - Confirms `startDateTime` actually parses as a date.
   - Defaults `endDateTime` to `startDateTime + 1h` if missing.
   - Re-emits both as canonical ISO UTC strings via `toISOString()`.
   - Trims `location` and `description` if present.
   - Calls `normalizeConfidence(...)` to keep only valid
     `high|medium|low` strings and drop anything else.
   - Returns a clean event object with the exact shape `app.js`
     expects: `{ title, startDateTime, endDateTime, allDay,
     location, description, rawText, confidence }`.

Throws a descriptive `Error` if the response is empty, unparseable,
or missing the required fields. `providers.js` lets those errors
propagate so the failover helper can try the next provider.

**Lines:** 123.

---

### 3.5 `providers.js` — vision-LLM adapters

**Role.** Each provider (Gemini, Groq, HuggingFace) has its own
endpoint, request format, and response shape. This file hides those
differences behind a uniform `extract(dataUrl, { apiKey, onStatus,
signal })` interface and adds two cross-cutting features:
**image downscaling** and **automatic failover**.

**Exports:**

- **`downscaleImage(file, maxEdge=1600, quality=0.85)`** — reads
  any `File` or `Blob`, draws it to an off-screen `<canvas>` at
  the smaller of its natural size and `maxEdge` on the longest
  side, and re-encodes as JPEG. Returns a base64 `data:` URL.
  Called once per extraction, before any LLM request. For a typical
  3 MB phone photo this brings the upload down to ~250 KB — about a
  10× reduction in token cost.
- **`splitDataUrl(dataUrl)`** — splits a `data:image/jpeg;base64,...`
  URL into its `{ mime, b64 }` parts. Used by every adapter.
- **`gemini`, `groq`, `huggingface`** — three adapter objects, each
  shaped as `{ name, needs, async extract(dataUrl, opts) }`. All
  three:
  1. Reject empty API keys with a clear error.
  2. Call `splitDataUrl` to extract the base64.
  3. Build the provider-specific request body.
  4. Fire a `fetch` POST.
  5. Convert the response to a plain string and call
     `validateAndNormalize` (from `prompt.js`).
  6. Throws on any HTTP error with a short error message including
     the status code and the first 300 chars of the error body.

**Per-provider details:**

- **Gemini 3.6 Flash** — endpoint
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`.
  Free tier: 15 RPM, 1,500 req/day. Request body uses
  `contents[].parts[].inline_data` with the base64 image; uses
  `responseMimeType: "application/json"` and `temperature: 0.1` to
  force deterministic JSON output. The response is read from
  `candidates[0].content.parts[0].text`.

- **Groq (Llama 3.2 Vision)** — endpoint
  `https://api.groq.com/openai/v1/chat/completions`. Free tier: 30
  RPM, ~14,400 req/day. Uses the OpenAI-compatible chat format with
  `model: "llama-3.2-11b-vision-preview"`, a system message carrying
  `SYSTEM_PROMPT`, and a user message with one text part plus one
  `image_url` part. `response_format: { type: "json_object" }`
  forces JSON.

- **HuggingFace (Qwen2-VL-7B-Instruct)** — endpoint
  `https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct`.
  Free tier: rate-limited but present. This adapter sends the raw
  image bytes as `application/octet-stream` (HF's image-to-text
  endpoint doesn't accept OpenAI-style JSON bodies for vision
  models). The `x-wait-for-model: true` header makes the API
  endpoint queue the request if the model is cold-starting.
  `extractJsonBlock()` helper at the bottom of the file handles the
  fact that Qwen2-VL sometimes returns prose with a JSON block
  embedded rather than pure JSON.

- **`PROVIDERS`** — `{ gemini, groq, huggingface }` registry.

- **`extractWithFailover(startingWith, dataUrl, keys, opts)`** —
  the auto-failover helper used by `app.js`. Iterates through
  `orderProviders(startingWith)`, skipping any provider that has
  no API key, calling `extract` on each one. On success, returns
  `{ event, provider, id }`. On failure (any error), moves to the
  next. If all providers fail, throws a single error whose
  `tried` array records the outcome of each attempt.

  The `signal` option (an `AbortController.signal`) lets the user
  cancel the whole chain by aborting the controller — any in-flight
  request that's still going throws `AbortError`, which is
  re-thrown by the helper.

**Lines:** 250.

---

### 3.6 `export.js` — calendar export

**Role.** Pure functions (no DOM dependencies except `downloadICS`)
that turn an event object into either a Google Calendar URL or a
fully RFC 5545-compliant `.ics` file body. Exhaustive unit testing
in `tests/export.test.mjs`.

**Internal helpers:**

- **`toICalUTC(d)`** — formats a JS `Date` as the iCalendar UTC
  timestamp form `YYYYMMDDTHHMMSSZ` (e.g. `20260315T193000Z`).
- **`escapeText(s)`** — escapes per RFC 5545 §3.3.11: backslash
  first, then newline → `\n`, comma → `\,`, semicolon → `\;`. Order
  matters: backslash has to be done first to avoid double-escaping
  the escapes that follow.
- **`fold(line)`** — RFC 5545 §3.1 line folding. Splits any line
  longer than 75 octets into a first chunk of 75 followed by
  continuation chunks of 74, prefixed with a single space, joined
  with CRLF. This is required because some calendar apps
  (especially older Apple Calendar builds) reject long summary
  lines.
- **`makeUID()`** — generates a stable UID per RFC 5545 §3.8.4.7.
  Format: `<base36 timestamp>-<8 random chars>@schedulefrompic`.

**Public exports:**

- **`generateICS(event, opts)`** — returns the full VCALENDAR body
  as a string. Validates that `title` and `startDateTime` are
  present, defaults `endDateTime` to `+1h` if missing, emits CRLF
  line endings, folds every line, includes the `PRODID`,
  `VERSION`, `CALSCALE`, `METHOD`, `UID`, `DTSTAMP`, `DTSTART`,
  `DTEND`, `SUMMARY`, optional `LOCATION` and `DESCRIPTION`, and
  `URL` fields. The `opts` object lets callers override `prodId`
  and `url`.

- **`downloadICS(event)`** — browser-only. Calls `generateICS`,
  wraps the result in a `Blob` with MIME
  `text/calendar;charset=utf-8`, creates an object URL, synthesizes
  a hidden `<a download="...">`, clicks it, and removes it. The
  filename is built by `makeFilename(event)` (e.g.
  `20260315-jazz-night-at-the-velvet-lounge.ics`). The object URL
  is revoked after 1 second.

- **`googleCalendarURL(event)`** — returns a Google Calendar
  "create event" template URL of the form
  `https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=…&location=…&details=…`.
  For non-all-day events, `dates` is `startUTC/endUTC` in
  `YYYYMMDDTHHMM00Z/YYYYMMDDTHHMM00Z` form. For all-day events,
  `dates` is `YYYYMMDD/YYYYMMDD` with the end date incremented by
  one day (Google's convention — the end date is exclusive).

**Lines:** 176.

---

### 3.7 `parser.js` — offline rule-based parser

**Role.** The last-resort extractor. When the user is offline and
all three cloud providers are unreachable, `ocr.js` runs
Tesseract.js on the device and feeds the resulting raw text into
this parser. It uses a handful of carefully-anchored regexes to
guess the title, date, time, and location. It is **deliberately
conservative** — every confidence level is "low" or "medium" at
best, so the user knows not to trust the result blindly.

**Constants (regex table at the top):**

- `MONTHS` — a lookup from month name → 0-indexed month number
  (`jan`/`january` → `0`, …, `dec`/`december` → `11`).
- `TIME_RE` — matches `7:30 PM`, `7:30`, `7pm`, `19:30`, `noon`,
  `midnight`. The regex is built to *require* either minutes or an
  am/pm suffix so that an isolated integer like "15" (a day number)
  doesn't get mis-parsed as 3 PM.
- `AT_RE` — matches the `at 7:30 PM` form preferentially.
- `MONTH_NAME_RE` / `DAY_MONTH_RE` — match `March 15, 2026` and
  `15 March 2026` respectively.
- `SLASH_RE` — matches `3/15/2026` or `15-03-2026`. If the first
  number is >12, it disambiguates to `DD/MM/YYYY`; otherwise it
  defaults to the US-style `MM/DD/YYYY`.
- `ISO_RE` — matches `2026-03-15` unambiguously.
- `ADDRESS_RE` — matches `123 Main Street`, `456 Park Ave`, etc.
  Tries the shortest street suffix first (`St` before `Street`),
  which works fine for both spelled-out and abbreviated forms.
- `AT_LOC_RE` — matches `at <Capitalized Venue Name>` when no
  street address is present.

**Public exports:**

- **`findDate(text)`** — returns the first plausible `Date` in the
  text or `null`. Tries the four formats in priority order
  (ISO → month name → day-month → slash).
- **`findTime(text)`** — returns `{ hour, minute }` in 24h form or
  `null`. Handles `noon` / `midnight` as special cases before
  regex matching. Prefers the `at <time>` form when present.
- **`findLocation(text)`** — returns a string or `""`. Prefers
  street addresses; falls back to the `at <venue>` pattern.
- **`findTitle(text)`** — splits on newlines, filters out any line
  that *looks* like a date, time, URL, or address, then picks the
  remaining candidate with the highest `scoreTitle` value
  (capital letters × 2 minus word count — heavily weighted toward
  Title Case lines).
- **`parseFromText(text)`** — top-level helper. Composes the four
  finders, builds a minimal event object, defaults the time to
  9:00 AM if no time was found, defaults the end to +1h, and
  attaches conservative confidence levels.

**Internal helpers (not exported):** `parseClock(s)` (parses a
clock-time string into 24h form, handling 12am and 12pm
correctly), `scoreTitle(line)`.

**Lines:** 181.

---

### 3.8 `ocr.js` — Tesseract.js lazy loader

**Role.** Wraps Tesseract.js so it only loads when actually needed
(when the user is offline and we have no working API key). This
keeps the initial download of the PWA tiny — Tesseract.js plus its
WASM blob is ~10 MB, and there's no reason to make online users
wait for it.

**Exports:**

- **`loadTesseract()`** — idempotent. Returns a `Promise` that
  resolves to the `window.Tesseract` global. Caches the in-flight
  promise in a module-level variable so a second call during the
  initial load reuses the same promise rather than injecting a
  second `<script>` tag. Injects a `<script src="…/tesseract.min.js">`
  from jsDelivr; the service worker's `fetch` handler doesn't cache
  jsDelivr responses (it's in the `cdn.jsdelivr.net` skip-list), so
  the browser handles subsequent loads via normal HTTP cache.
- **`ocrExtract(dataUrl, { onProgress, onStatus })`** — runs
  end-to-end OCR. Creates a Tesseract worker for English, fires
  `worker.recognize(dataUrl)`, then pipes the resulting text into
  `parseFromText` from `parser.js`. Calls `onStatus` at three
  checkpoints: "Loading Tesseract.js…", "Reading text on-device…",
  "Parsing text…". `onProgress` is called with a 0..1 float
  whenever Tesseract's logger emits a `recognizing text` event.
  The worker is always terminated in a `finally` block to free
  memory.

**Lines:** 58.

---

### 3.9 `sw.js` — service worker

**Role.** Makes the app installable as a PWA and lets the app
shell load when offline. Registered by `app.js#bindEvents`.

**`CACHE_VERSION = 'schedule-v5'`.** Bump this string (to
`schedule-v6`, `schedule-v7`, …) whenever you change any of the
files in `ASSETS`. The next page load will create a new cache
with the new name, and the `activate` handler will delete the old
one.

**`ASSETS` array.** The 11 files that make up the app shell: root
URL, `index.html`, `styles.css`, `app.js`, `providers.js`,
`prompt.js`, `export.js`, `parser.js`, `ocr.js`, `manifest.json`,
`icon.svg`. These are pre-cached on `install` so the app can boot
without a network connection.

**Lifecycle:**

- **`install`** — opens a cache with the current `CACHE_VERSION`
  and pre-populates it with all `ASSETS`. Calls `skipWaiting()` so
  the new SW replaces the old one immediately rather than waiting
  for all tabs to close.
- **`activate`** — lists every cache, deletes any whose name
  doesn't match `CACHE_VERSION`. Calls `clients.claim()` so the
  page currently being loaded uses the new SW without a refresh.
- **`fetch`** — three branches:
  1. **Skip list** — if the request URL host ends with
     `googleapis.com`, `groq.com`, `huggingface.co`,
     `cdn.jsdelivr.net`, or `unpkg.com`, return without
     `event.respondWith`. The browser fetches directly from the
     network. This is critical — caching LLM API responses would
     leak one user's extracted event to the next, and caching
     Tesseract would prevent the worker from picking up version
     updates.
  2. **Cache-first** — for any other `GET`, try the cache first.
     If found, return it. Otherwise fetch from the network, and
     if the response is a 200 same-origin response, store a copy
     in the cache for next time.
  3. **Network failure fallback** — if the network fetch throws
     (no connection), return the cached `index.html` so deep
     links still render a usable page.

**Lines:** 73.

---

### 3.10 `manifest.json` — PWA manifest

**Role.** Tells the browser how to render the app when installed
to the home screen, what its name is, and what icon to use.

**Fields:**

- `name` / `short_name` — full and abbreviated app names. iOS uses
  the short name under the icon if it's installed.
- `description` — the app store / install prompt description.
- `start_url: "./index.html"` — the URL to open when the icon is
  tapped. Setting it to the root (`./`) would also work, but
  `./index.html` is explicit and matches the file layout.
- `scope: "./"` — the URL scope the SW controls. Anything outside
  this scope won't be served from cache.
- `display: "standalone"` — no browser chrome when launched; the
  app feels native.
- `orientation: "portrait"` — locks to portrait on mobile.
- `background_color` / `theme_color` — both `#0f1226` (the deep
  navy of the dark theme). `background_color` is shown briefly
  during launch, before the CSS loads. `theme_color` tints the
  status bar on Android.
- `icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml",
  purpose: "any" }]` — a single SVG icon. Modern browsers render
  it at any size; older Android may need PNG fallbacks, but the
  current setup works on all up-to-date Safari and Chrome.

**Lines:** 19 (JSON).

---

### 3.11 `icon.svg` — app icon

**Role.** The home-screen / app-drawer icon. A 192×192 vector
depicting a calendar page with a cyan-blue gradient header strip,
two silver binding hooks at the top, a folded-corner photo motif
on the right, and a camera-lens-like circle in the lower-left to
hint at the "from a picture" use case. Uses two `<linearGradient>`
definitions (`bg` and `accent`) that match the dark-theme
background and accent color from `styles.css`.

**Lines:** 25.

---

### 3.12 `tests/*.test.mjs` — unit tests

Three Node test files, run with the built-in `node --test` runner
(no test framework dependency). Total: **41 tests**, all passing.

**`tests/parser.test.mjs` (18 tests).** Exercises every export of
`parser.js`:

- `findDate` — ISO format, `Month Day, Year`, `Day Month Year`,
  US `MM/DD/YYYY`, EU `DD/MM/YYYY` (when first number > 12), and
  the "no date found" case.
- `findTime` — `7:30 PM`, 24h `19:30`, `7pm` (no minutes),
  `noon`, `midnight`, `12am` (= 0:00), `12pm` (= 12:00).
- `findLocation` — street address with suffix, `at <Venue>`
  pattern, the no-match case.
- `findTitle` — picks the longest non-date/time line.
- `parseFromText` — end-to-end from a multi-line OCR-style input.

**`tests/export.test.mjs` (13 tests).** Exercises `export.js`:

- `generateICS` — required headers present, CRLF line endings
  only, UTC date format, escapes `,` `;` `\` and newlines per
  RFC 5545, folds lines at 75 octets with leading-space
  continuations, every VEVENT has a UID, defaults end to +1h,
  throws on missing title or start.
- `googleCalendarURL` — contains `action=TEMPLATE`, has the
  compact UTC date form, includes location and details.

**`tests/prompt.test.mjs` (10 tests).** Exercises `prompt.js`:

- `validateAndNormalize` — accepts a well-formed object, accepts
  a JSON string (with markdown fences stripped), throws on
  missing title, throws on missing start, throws on unparseable
  date, defaults end to +1h, drops unknown confidence levels,
  coerces non-string title to trimmed string.
- `EVENT_SCHEMA` — has the required fields.
- `SYSTEM_PROMPT` — instructs the model to return JSON and
  mentions the required fields by name.

**Run them all:**

```bash
node --test tests/parser.test.mjs tests/export.test.mjs tests/prompt.test.mjs
```

---

### 3.13 `README.md` — user-facing docs

The user-facing quickstart (313 lines). Walks the reader through
how to run the app locally, how to get a free API key from each
of the three providers, how to deploy to a free static host
(Netlify Drop, Surge.sh, Cloudflare Pages, GitHub Pages), how
to test, the file layout, design notes, and a troubleshooting
section. This `DOCUMENTATION.md` is the developer-facing
companion.

---

## 4. End-to-end walkthroughs

### 4.1 Happy path: online user with a Gemini key

1. User opens the app (e.g. via the home-screen icon). `app.js`
   runs `initTheme()` and `show("home")`.
2. User taps **Choose Photo** → `data-action="choose-photo"` →
   delegated click handler calls `fileLib.click()`. The hidden
   `<input type="file">` opens the system file picker.
3. User picks a flyer image. The `change` event on
   `#file-library` fires; `handleFileChosen(file)` runs.
4. `state.imageFile` is set; a new blob URL is created and
   stored in `state.previewUrl`; the `<img id="preview-image">`
   `src` is updated; `show("preview")` is called.
5. User taps **Extract Event →** → `data-action="extract"` →
   `startExtraction()`.
6. `downscaleImage()` produces a 1600px JPEG base64.
7. `extractWithFailover("gemini", dataUrl, keys, opts)` is
   called. It tries the `gemini` adapter first.
8. The Gemini adapter POSTs to
   `generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`
   with the image, the `SYSTEM_PROMPT`, and JSON mode enabled.
9. Gemini returns a JSON object. `validateAndNormalize` parses,
   normalizes, and returns a clean event.
10. `state.event` is set. `populateReview(event)` writes the
    fields into the form, with confidence dots.
11. `show("review")` transitions to the editable form.
12. User reviews / edits, then taps **Continue →** →
    `goToExport()` validates the form, builds the Google
    Calendar URL, and shows the export screen.
13. User taps **Google Calendar** → opens the URL in a new tab
    with the event pre-filled. They tap "Save" in Google and
    the event is in their calendar.

### 4.2 Offline path

1. Same as above up to step 6.
2. `navigator.onLine` is `false` (or no API keys), so
   `ocrExtract(dataUrl, …)` is called.
3. `loadTesseract()` injects a `<script>` from jsDelivr. First
   time, this is a ~10 MB download; the service worker doesn't
   cache it but the browser's HTTP cache will reuse it on
   subsequent loads.
4. `Tesseract.createWorker("eng", 1, …)` spins up a worker.
5. `worker.recognize(dataUrl)` returns `{ data: { text: "…" } }`.
6. `parseFromText(text)` from `parser.js` runs the rule-based
   heuristics and returns a best-effort event with "low" or
   "medium" confidence.
7. The review form is shown with a small banner ("Reduced
   accuracy — running on-device") to remind the user the result
   is less reliable than cloud LLM output. From here the
   export flow is the same.

### 4.3 .ics export path

1. User on the export screen taps **Apple / Outlook**.
2. `data-action="download-ics"` → delegated click → calls
   `downloadICS(state.event)` and toasts "Calendar file
   downloaded".
3. `downloadICS` calls `generateICS`, which returns the full
   VCALENDAR text.
4. A `Blob` is created, an object URL is generated, a hidden
   `<a>` with `download="20260315-jazz-night.ics"` is appended,
   clicked, and removed. The browser's download UI shows.
5. The user opens the `.ics` file. On macOS, Calendar.app opens
   and asks to add the event. On iOS, the system calendar
   picker shows.

---

## 5. State machine reference

```
        ┌──────┐
        │ home │ ◄────────────────────────┐
        └──┬───┘                          │
           │ pick/shoot                   │
           ▼                              │
        ┌───────┐   extract    ┌────────┐  │
        │preview│ ───────────► │extract.│  │ cancel / error
        └───┬───┘              └───┬────┘  │
            │                     │       │
            │ re-pick             │       │
            └─────────────────────┘       │
                                          │
            ┌────────┐  continue  ┌───────┴──┐
            │ review │ ◄───────── │  review  │
            └───┬────┘  error     │ populated│
                │                 └──────────┘
                │ continue
                ▼
            ┌────────┐  start over  ┌──────┐
            │ export │ ──────────► │ home │
            └────────┘             └──────┘
```

Transitions are driven by `show(name)` (DOM-level) plus the
extraction pipeline (data-level). The only state that persists
across screen changes is `state.*`; the only state that persists
across page reloads is `localStorage["schedule-from-pic:settings:v1"]`.

---

## 6. Settings & localStorage schema

A single key, `schedule-from-pic:settings:v1`, holds all user
preferences as a JSON object:

```json
{
  "gemini": "AIza...",
  "groq": "gsk_...",
  "huggingface": "hf_...",
  "defaultProvider": "gemini",
  "theme": "auto"
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `gemini` | string | `""` | Google AI Studio API key. Starts with `AIza…` |
| `groq` | string | `""` | Groq console API key. Starts with `gsk_…` |
| `huggingface` | string | `""` | HF access token. Starts with `hf_…` |
| `defaultProvider` | `"gemini" \| "groq" \| "huggingface"` | `"gemini"` | First one tried by the failover helper |
| `theme` | `"auto" \| "light" \| "dark"` | `"auto"` | `auto` follows `prefers-color-scheme` |

A missing or malformed entry falls back to the default via the
`||` chain in `getSettings()`. The `"clear all data"` button in
the settings drawer deletes the entire key and reloads the page.

---

## 7. Build, deploy, test

### Build

**There is no build step.** Every file is served as-is. To work
on the project locally:

```bash
cd "/Users/kwc/Documents/Vibe Coding/Schedule from pic"
python3 -m http.server 8765
# Open http://localhost:8765/index.html
```

(`npx serve`, `php -S`, `ruby -run -e httpd . -p 8765` all work
too. The Python option is recommended because it ships with macOS.)

A local server is required because the app uses
`<script type="module">` (which browsers refuse to load from
`file://`) and the service worker (which also requires an
`http://` or `https://` origin).

### Deploy

Any static host with HTTPS works. Free options:

- **Netlify Drop** — drag the folder to <https://app.netlify.com/drop>
- **Cloudflare Pages** — drag-drop or Git-integrated
- **Surge.sh** — `npm i -g surge && surge`
- **GitHub Pages** — push to repo, enable Pages

After deploying, open the URL on your phone and tap Share →
"Add to Home Screen" (iOS) or Chrome menu → "Install app"
(Android) to install as a real PWA.

When you change any file, bump `CACHE_VERSION` in `sw.js` and
re-deploy, so installed PWAs pick up the new version.

### Test

```bash
node --test tests/parser.test.mjs tests/export.test.mjs tests/prompt.test.mjs
```

Expected output:

```
ℹ tests 41
ℹ pass  41
ℹ fail  0
```

To smoke-test the full flow without API keys, use Chrome /
Safari DevTools → Network → "Offline" and then pick a photo →
Extract. The Tesseract fallback path should kick in and produce
a (lower-accuracy) event.

---

## 8. Design notes & conventions

### Why vanilla, no framework

The project's three siblings in the "Vibe Coding" folder
(`Imposter`, `Scientific calculator`, `Share investment`) all use
the same hand-rolled vanilla-HTML/CSS/JS structure. Consistency
across the projects makes them easier to read, easier to
maintain, and easier to deploy (no `npm install` step).

### Why ES modules

ES `import` / `export` lets the JS files be split into focused
single-responsibility modules without a bundler. The browser
handles the dependency graph at runtime. Each file is also easy
to test in isolation in Node, because Node 18+ supports ES
modules natively.

### Why hand-written `.ics` and not a library

`ics` (npm) is 200+ lines of dependencies for what is
fundamentally a text format with ~15 rules. Writing the
generator by hand keeps the project dependency-free and gives
us full control over the edge cases (line folding, escaping,
all-day event handling). The 13 tests in `export.test.mjs` lock
down the format.

### Why hand-written Google URL builder

Same reason. The Google Calendar template URL is a stable,
public, well-documented scheme. No need for an SDK.

### Why Tesseract.js is lazy-loaded

Tesseract.js plus its WASM blob is ~10 MB. Online users never
need it — the LLM path is strictly better. Injecting the
`<script>` only when `navigator.onLine` is `false` saves online
users the entire download. The service worker deliberately
doesn't pre-cache it (the `cdn.jsdelivr.net` skip-list in
`sw.js` makes sure of that) so the browser's HTTP cache is the
sole source of truth, and version updates are picked up
automatically.

### Why "no image leaves your device" really means it

The image bytes are sent directly from the browser to the
provider you select — your device makes a `fetch` call to
`generativelanguage.googleapis.com` (or similar) with the
base64 image in the body. The PWA does not run a backend. There
is no proxy. The provider's privacy policy is the only thing
governing what happens to the image after it leaves your device.

### Why the home screen has a privacy badge

The badge ("🔒 Image leaves device only when you tap Extract")
is a deliberate trust signal. Flyers often contain personal
information (names, addresses, phone numbers) and the user
should feel confident about exactly when their data crosses
the network boundary.

### Color & typography tokens

Every color in `styles.css` is a CSS custom property defined
in `:root` or `:root[data-theme="…"]`. There are no hard-coded
hex values outside the token block (the `app-title` etc. are
all `var(--…)`). Switching the theme is a one-attribute change
on `<html>`. The fonts use the system font stack, which is
fast, free, and adapts to the user's OS preferences (SF Pro on
macOS / iOS, Segoe UI on Windows, Roboto on Android).

### Why a mesh gradient background

The animated, two-layer, blurred radial-gradient background is
the project's most distinctive visual element. It gives the app
a "living" feel that static backgrounds can't match, and
respects `prefers-reduced-motion` for users who don't want
animation.

### Single delegated click listener

Rather than wiring every button with its own `addEventListener`,
`app.js` installs **one** click listener on `document` that
reads `data-action` and dispatches. Adding a new button is
just `data-action="my-action"` + one new `case` in the switch.
The HTML stays declarative and the JS stays small.

### AbortController for cancellation

When the user taps **Cancel** on the extracting screen,
`cancelExtraction()` aborts the in-flight `AbortController`.
The provider adapters receive the signal and throw
`AbortError`, which `extractWithFailover` re-throws. `app.js`
catches it specifically and returns the user to the preview
screen without showing an error toast — the cancel was
intentional.

---

*Last updated to match the codebase as of the home-screen
redesign pass (title full-width, gear as labeled link below the
buttons, "From any picture" subtitle copy).*
