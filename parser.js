/* =========================================================
   Schedule from Pic — Offline Rule-Based Parser
   Used as a fallback when all cloud providers are unreachable
   and we have to work from raw Tesseract OCR text.
   Goal: best-effort guess, never silent invention.
   ========================================================= */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

// Time patterns. The main TIME_RE requires either minutes (":MM")
// or an am/pm suffix — otherwise plain integers like "15" (the day)
// would match and produce nonsense. Special-cased noon/midnight too.
// The colon-form also accepts an optional am/pm, because "7:30 PM" is
// the most common flyer format.
const TIME_RE = /(?:\b(\d{1,2}):(\d{2})(?:\s*(a\.?m\.?|p\.?m\.?))?\b|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b)|\bnoon\b|\bmidnight\b/i;
const AT_RE   = /\b(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\b/i;

const MONTH_NAME_RE = new RegExp(
  `\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, "i"
);
const DAY_MONTH_RE = new RegExp(
  `\\b(\\d{1,2})\\s+(${Object.keys(MONTHS).join("|")})(?:\\s+(\\d{4}))?\\b`, "i"
);
const SLASH_RE   = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/;
const ISO_RE     = /\b(\d{4})-(\d{2})-(\d{2})\b/;

const AT_LOC_RE   = /\b(?:at|@)\s+([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,5})/;
const ADDRESS_RE  = /\b(\d+\s+[A-Z][\w'.-]*(?:\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Pl|Place)\.?))/i;

/**
 * Try to find a single most-likely date in the text. Returns a
 * Date (local time, 00:00) or null.
 */
export function findDate(text) {
  if (!text) return null;

  let m;
  if ((m = ISO_RE.exec(text))) {
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  if ((m = MONTH_NAME_RE.exec(text))) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = +m[2];
    const year = m[3] ? +m[3] : new Date().getFullYear();
    return new Date(year, month, day);
  }
  if ((m = DAY_MONTH_RE.exec(text))) {
    const day = +m[1];
    const month = MONTHS[m[2].toLowerCase()];
    const year = m[3] ? +m[3] : new Date().getFullYear();
    return new Date(year, month, day);
  }
  if ((m = SLASH_RE.exec(text))) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (a > 12) { return new Date(y, b - 1, a); } // DD/MM
    return new Date(y, a - 1, b);                  // MM/DD
  }
  return null;
}

/**
 * Try to find a time in the text. Returns { hour, minute } (24h) or null.
 */
export function findTime(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/\bnoon\b/.test(lower))    return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(lower)) return { hour: 0,  minute: 0 };

  // Prefer the "at <time>" form when present
  let m = AT_RE.exec(text);
  if (m) return parseClock(m[1]);

  m = TIME_RE.exec(text);
  if (!m) return null;

  // TIME_RE branches: HH:MM (with optional am/pm in group 3), H ampm
  // (in groups 4+5), noon/midnight are handled before the regex.
  if (m[1] != null && m[2] != null) {
    const ampm = m[3] ? ` ${m[3]}` : "";
    return parseClock(`${m[1]}:${m[2]}${ampm}`);
  }
  if (m[4] != null && m[5] != null) {
    return parseClock(`${m[4]} ${m[5]}`);
  }
  return null;
}

function parseClock(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const ampm = m[3] ? m[3].replace(/\./g, "").toLowerCase() : null;
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

/**
 * Try to find a venue / address in the text. Returns string or "".
 */
export function findLocation(text) {
  if (!text) return "";
  let m = ADDRESS_RE.exec(text);
  if (m) return m[1].trim();
  m = AT_LOC_RE.exec(text);
  if (m) return m[1].trim();
  return "";
}

/**
 * Try to find a title. Heuristic: longest line that doesn't look
 * like a date, time, or address. We prefer lines with many caps.
 */
export function findTitle(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dateLike     = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[\/\-]\d{1,2})/i;
  const timeLike     = /\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)/i;
  const urlLike      = /https?:\/\/|www\./i;
  const addressLike  = /\b(?:st|street|ave|avenue|blvd|road|rd|drive|dr)\b/i;

  const candidates = lines.filter((l) =>
    l.length >= 4 && l.length <= 80 &&
    !dateLike.test(l) && !timeLike.test(l) && !urlLike.test(l) && !addressLike.test(l)
  );
  if (!candidates.length) return "";
  candidates.sort((a, b) => scoreTitle(b) - scoreTitle(a));
  return candidates[0];
}

function scoreTitle(line) {
  const caps = (line.match(/[A-Z]/g) || []).length;
  const words = line.split(/\s+/).length;
  return caps * 2 - words;
}

/**
 * Top-level: parse OCR text into a minimal event object.
 * Confidence is intentionally conservative — we mark fields "low" or
 * "medium" only when we found an unambiguous match.
 */
export function parseFromText(text) {
  const date = findDate(text);
  const time = findTime(text);
  const title = findTitle(text);
  const location = findLocation(text);

  let startDateTime = null;
  if (date) {
    const d = new Date(date);
    d.setHours(time ? time.hour : 9, time ? time.minute : 0, 0, 0);
    startDateTime = d.toISOString();
  }
  const endDateTime = startDateTime
    ? new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString()
    : null;

  return {
    title,
    startDateTime,
    endDateTime,
    location,
    description: text.trim(),
    allDay: false,
    rawText: text,
    confidence: {
      title:         title ? "low" : "low",
      startDateTime: startDateTime ? (date && time ? "medium" : "low") : "low",
      location:      location ? "low" : "low",
    },
  };
}
