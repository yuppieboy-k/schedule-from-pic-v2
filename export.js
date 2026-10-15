/* =========================================================
   Schedule from Pic — Calendar Export
   - generateICS()              : RFC 5545 .ics string
   - downloadICS()              : triggers a file download
   - googleCalendarURL()        : Google Calendar event URL (pre-filled, manual save)
   - outlookCalendarURL()       : Outlook Web event URL (pre-filled, manual save)
   - openInDefaultCalendar()    : Uses Web Share API or .ics to launch default calendar app for review & manual save
   ========================================================= */

/**
 * Format a Date as iCalendar UTC: YYYYMMDDTHHMMSSZ
 * https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.5
 */
function toICalUTC(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/**
 * Escape per RFC 5545 §3.3.11.
 * Order matters: backslash first, then commas/semicolons/newlines.
 */
function escapeText(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Fold long lines at 75 octets per RFC 5545 §3.1.
 * Uses CRLF as the line terminator (mandatory for .ics).
 */
function fold(line) {
  if (line.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    const slice = line.slice(i, i + (i === 0 ? 75 : 74));
    out.push((i === 0 ? "" : " ") + slice);
    i += i === 0 ? 75 : 74;
  }
  return out.join("\r\n");
}

/**
 * Generate a stable UID (RFC 5545 §3.8.4.7).
 * Format: <timestamp>-<rand>@schedulefrompic
 */
function makeUID() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}-${r}@schedulefrompic`;
}

/**
 * Build a valid .ics file body (with CRLF line endings) from an event.
 *
 * @param {object} event  { title, startDateTime, endDateTime, location, description, allDay }
 * @param {object} [opts] { prodId, url }   - optional overrides
 * @returns {string}  The complete VCALENDAR contents, ready to save as a .ics file.
 */
export function generateICS(event, opts = {}) {
  if (!event || !event.title) throw new Error("Event must have a title");
  if (!event.startDateTime) throw new Error("Event must have a startDateTime");

  const start = new Date(event.startDateTime);
  const end   = new Date(event.endDateTime || new Date(start.getTime() + 60 * 60 * 1000));
  if (Number.isNaN(start.getTime())) throw new Error("Invalid startDateTime");
  if (Number.isNaN(end.getTime()))   throw new Error("Invalid endDateTime");

  const now = toICalUTC(new Date());
  const uid = makeUID();
  const prodId = opts.prodId || "-//Schedule from Pic//EN";
  const url    = opts.url || "https://github.com/";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
  ];

  if (event.allDay) {
    const pad = (n) => String(n).padStart(2, "0");
    const ymdStart = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
    const endPlus = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    const ymdEnd = `${endPlus.getFullYear()}${pad(endPlus.getMonth() + 1)}${pad(endPlus.getDate())}`;
    lines.push(`DTSTART;VALUE=DATE:${ymdStart}`);
    lines.push(`DTEND;VALUE=DATE:${ymdEnd}`);
  } else {
    lines.push(`DTSTART:${toICalUTC(start)}`);
    lines.push(`DTEND:${toICalUTC(end)}`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location)    lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  lines.push(`URL:${url}`);
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // Fold + CRLF
  return lines.map(fold).join("\r\n") + "\r\n";
}

/**
 * Trigger a browser download of the .ics file. The filename is
 * derived from the event title (sanitized) and start date.
 */
export function downloadICS(event) {
  const body = generateICS(event);
  const blob = new Blob([body], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${makeFilename(event)}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function makeFilename(event) {
  const date = new Date(event.startDateTime || Date.now());
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const slug = String(event.title || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "event";
  return `${ymd}-${slug}`;
}

/**
 * Open event in the default system calendar application.
 * Uses Web Share API with a .ics file on iOS / Android to trigger
 * the native calendar event preview sheet (where the user manually reviews and saves).
 * On desktop or unsupported platforms, downloads the .ics file which launches
 * the system calendar (Calendar.app on macOS, Outlook/Calendar on Windows)
 * in preview mode.
 */
export async function openInDefaultCalendar(event) {
  const icsBody = generateICS(event);
  const filename = `${makeFilename(event)}.ics`;
  const blob = new Blob([icsBody], { type: "text/calendar;charset=utf-8" });

  if (typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof File !== "undefined") {
    try {
      const file = new File([blob], filename, { type: "text/calendar" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: event.title,
          text: `Event: ${event.title}`,
          files: [file],
        });
        return { method: "share", success: true };
      }
    } catch (err) {
      if (err.name === "AbortError") {
        return { method: "share", success: false, aborted: true };
      }
      console.warn("navigator.share failed, falling back to .ics download:", err);
    }
  }

  // Fallback to downloading .ics
  downloadICS(event);
  return { method: "download", success: true };
}

/**
 * Build a Google Calendar "create event" URL.
 * Google opens the event review page (action=TEMPLATE) with fields pre-filled,
 * allowing the user to review and manually click "Save".
 */
export function googleCalendarURL(event) {
  if (!event || !event.title) throw new Error("Event must have a title");
  const start = new Date(event.startDateTime);
  const end   = new Date(event.endDateTime || new Date(start.getTime() + 60 * 60 * 1000));

  const fmt = (d) =>
    d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0") +
    "T" +
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    "00Z";

  let dates;
  if (event.allDay) {
    const ymd = (d) =>
      d.getUTCFullYear() +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      String(d.getUTCDate()).padStart(2, "0");
    const endPlus = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    dates = `${ymd(start)}/${ymd(endPlus)}`;
  } else {
    dates = `${fmt(start)}/${fmt(end)}`;
  }

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
    details: event.description || "",
    location: event.location || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Build an Outlook Live "create event" deeplink URL.
 * Opens Outlook in compose mode so the user can review and manually save.
 */
export function outlookCalendarURL(event) {
  if (!event || !event.title) throw new Error("Event must have a title");
  const start = new Date(event.startDateTime);
  const end   = new Date(event.endDateTime || new Date(start.getTime() + 60 * 60 * 1000));

  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    location: event.location || "",
    body: event.description || "",
    allday: event.allDay ? "true" : "false",
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
