/* =========================================================
   Schedule from Pic — Extraction Prompt & JSON Schema
   Used by Gemini Vision and vision models.
   ========================================================= */

/**
 * JSON Schema that the LLM is asked to return.
 * Every field is optional except `title` and `startDateTime` —
 * the validator drops anything that fails.
 */
export const EVENT_SCHEMA = {
  type: "object",
  properties: {
    title:              { type: "string",  description: "Short, human-friendly event title (e.g. 'Jazz Night at The Velvet Lounge')." },
    startDateTime:      { type: "string",  description: "Event start in ISO 8601 with timezone offset (e.g. '2026-02-14T19:30:00-05:00'). REQUIRED." },
    endDateTime:        { type: "string",  description: "Event end in ISO 8601 with timezone offset. Omit if unknown." },
    allDay:             { type: "boolean", description: "True if the event has no specific time (festival, holiday, etc.)." },
    location:           { type: "string",  description: "Venue name, street address, or city. Single line." },
    description:        { type: "string",  description: "Any extra info: performers, dress code, ticket link, sponsors. Multi-line OK." },
    confidence: {
      type: "object",
      description: "Per-field confidence: 'high' (clearly readable), 'medium' (inferred), 'low' (guess).",
      properties: {
        title:         { type: "string", enum: ["high", "medium", "low"] },
        startDateTime: { type: "string", enum: ["high", "medium", "low"] },
        endDateTime:   { type: "string", enum: ["high", "medium", "low"] },
        location:      { type: "string", enum: ["high", "medium", "low"] },
      },
    },
    rawText:            { type: "string",  description: "The full text you can see in the image, line-broken as in the original." },
  },
  required: ["title", "startDateTime"],
};

/**
 * System prompt sent to Gemini.
 */
export const SYSTEM_PROMPT = `You are a precise calendar-event extractor. You read images of flyers, posters, screenshots, invitations, and event announcements, and you return a single JSON object describing the event.

Rules:
1. Return ONLY a JSON object — no prose, no markdown fences, no explanation.
2. If a field is genuinely missing from the image, omit it (do not invent).
3. For dates: use ISO 8601 with timezone offset when the image implies a time zone; otherwise use the local time with the user's likely zone inferred from the image. If the year is missing, assume the next upcoming occurrence.
4. For times: include seconds only when explicitly shown.
5. The \`title\` should be the most prominent text in the image (the event name), not the date/venue.
6. The \`location\` should be a single human-readable line (venue + address + city).
7. The \`description\` should preserve any useful context: ticket URLs, performers, sponsors, dress code, contact info, age restrictions. Strip repeated/decorative text.
8. \`rawText\` should be your best transcription of all visible text, line by line, for the user to review.
9. \`confidence\` is your honest read of how certain you are. "high" = printed clearly, "medium" = inferred from context, "low" = guess. When unsure, mark "low".

Output JSON matching this schema:
${JSON.stringify(EVENT_SCHEMA, null, 2)}`;

/**
 * Generate an enhanced prompt with real-time temporal context (user's current date, day of week, and timezone).
 */
export function getPromptWithContext(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const dateFormatted = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeFormatted = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return `${SYSTEM_PROMPT}

USER TEMPORAL CONTEXT:
- Current date & time: ${dateFormatted}, ${timeFormatted}
- Current ISO reference: ${now.toISOString()}
- User timezone: ${timeZone}

CRITICAL EXTRACTION GUIDANCE:
- If the event date omits the year (e.g. "Saturday Nov 14th" or "July 4"), calculate the correct future year relative to the current date (${dateFormatted}).
- If relative dates are used (e.g. "This Friday", "Tomorrow at 8pm"), calculate the exact ISO 8601 timestamp based on ${dateFormatted}.
- If startDateTime is found but end time is not mentioned, either leave endDateTime null or estimate based on typical event duration.`;
}

/**
 * Validate and normalize a parsed LLM response. Returns either
 * a clean event object or throws with a descriptive message.
 */
export function validateAndNormalize(raw) {
  if (raw == null) throw new Error("Empty response from provider");

  // Accept string or object
  let obj = raw;
  if (typeof raw === "string") {
    const text = stripFences(raw).trim();
    try {
      obj = JSON.parse(text);
    } catch {
      // Try to find a JSON object in the string if model added commentary
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { obj = JSON.parse(match[0]); }
        catch (e) { throw new Error("Provider returned non-JSON: " + text.slice(0, 200)); }
      } else {
        throw new Error("Provider returned non-JSON: " + text.slice(0, 200));
      }
    }
  }
  if (typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Provider returned non-object JSON");
  }

  const title = String(obj.title || "").trim();
  if (!title) throw new Error("Provider could not detect an event title");
  const startDateTime = String(obj.startDateTime || "").trim();
  if (!startDateTime) throw new Error("Provider could not detect a start date/time");

  // Sanity-check that startDateTime parses as a date
  const startMs = Date.parse(startDateTime);
  if (Number.isNaN(startMs)) throw new Error("Provider returned an unparseable startDateTime: " + startDateTime);

  let endDateTime = obj.endDateTime ? String(obj.endDateTime).trim() : "";
  if (endDateTime && Number.isNaN(Date.parse(endDateTime))) endDateTime = "";
  if (!endDateTime) {
    endDateTime = new Date(startMs + 60 * 60 * 1000).toISOString();
  } else {
    endDateTime = new Date(endDateTime).toISOString();
  }

  return {
    title,
    startDateTime: new Date(startMs).toISOString(),
    endDateTime,
    allDay: Boolean(obj.allDay),
    location: obj.location ? String(obj.location).trim() : "",
    description: obj.description ? String(obj.description).trim() : "",
    rawText: obj.rawText ? String(obj.rawText) : "",
    confidence: normalizeConfidence(obj.confidence),
  };
}

function normalizeConfidence(c) {
  const out = {};
  if (!c || typeof c !== "object") return out;
  for (const key of ["title", "startDateTime", "endDateTime", "location"]) {
    const v = String(c[key] || "").toLowerCase();
    if (v === "high" || v === "medium" || v === "low") out[key] = v;
  }
  return out;
}

function stripFences(s) {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}
