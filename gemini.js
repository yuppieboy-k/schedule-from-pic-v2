/* =========================================================
   Schedule from Pic — Gemini Vision Client
   - extractWithGemini()  : Sends image to Gemini Vision API with auto-fallback
   - testGeminiKey()      : Validates an API key against Google AI Studio
   - downscaleImage()     : Client-side downscaler to optimize upload speed
   ========================================================= */

import { getPromptWithContext, validateAndNormalize } from "./prompt.js";

export const GEMINI_MODELS = [
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", desc: "Recommended • 15 RPM, 1,500 req/day free" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", desc: "Latest Flash generation" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", desc: "Standard production model" },
  { id: "gemini-1.5-pro",   name: "Gemini 1.5 Pro",   desc: "Deep reasoning for dense/complex posters" },
];

/**
 * Clean up verbose Google API error messages into friendly, clear text.
 */
export function cleanGeminiErrorMessage(rawMsg, model = "") {
  const msg = String(rawMsg || "");
  if (msg.includes("not supported for generateContent") || msg.includes("not found for API version")) {
    return `Model "${model || "selected"}" is not available for generateContent. Please choose Gemini 3.6 Flash or 1.5 Flash in Settings.`;
  }
  if (msg.includes("API key not valid") || msg.includes("API_KEY_INVALID")) {
    return "Invalid Gemini API key. Please check your key in Settings.";
  }
  if (msg.includes("Quota exceeded") || msg.includes("ResourceExhausted") || msg.includes("RATE_LIMIT_EXCEEDED")) {
    return "Gemini API rate limit reached. Please wait a minute and retry.";
  }
  return msg;
}

/**
 * Helper: read a File or Blob and downscale it via Canvas
 * to keep payload snappy and mobile-friendly. Max 1600px, JPEG quality 0.85.
 * Returns a base64 data URL.
 */
export async function downscaleImage(fileOrBlob, maxEdge = 1600, quality = 0.85) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Failed to load image file for preview"));
      im.src = url;
    });

    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Split data URL into mime type and base64 payload.
 */
export function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+_-]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error("Invalid image data URL format");
  return { mime: m[1], b64: m[2] };
}

/**
 * Test an API key against Google AI Studio's Gemini models endpoint.
 */
export async function testGeminiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) {
    return { ok: false, error: "Please enter an API key" };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const modelCount = Array.isArray(data.models) ? data.models.length : 0;
      return {
        ok: true,
        message: `API key verified successfully (${modelCount} models accessible)`,
      };
    }

    const errJson = await res.json().catch(() => null);
    const rawMsg = errJson?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
    return { ok: false, error: cleanGeminiErrorMessage(rawMsg) };
  } catch (err) {
    return { ok: false, error: err.message || "Network error while connecting to Gemini API" };
  }
}

/**
 * Extract calendar event details using Google Gemini Vision.
 * Automatically tries candidate fallback models if the chosen model
 * is not supported or returns 404/400.
 *
 * @param {string} dataUrl - Base64 data URL of the image
 * @param {object} opts
 * @param {string} opts.apiKey - User's Gemini API key
 * @param {string} [opts.model="gemini-3.6-flash"] - Chosen model ID
 * @param {function} [opts.onStatus] - Status update callback
 * @param {AbortSignal} [opts.signal] - Abort controller signal
 * @returns {Promise<{ event: object, modelUsed: string }>}
 */
export async function extractWithGemini(dataUrl, { apiKey, model = "gemini-3.6-flash", onStatus, signal } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("Missing Gemini API key. Please open Settings and enter your free API key.");
  }

  onStatus?.("Preparing image for Gemini Vision…");
  const { mime, b64 } = splitDataUrl(dataUrl);

  const promptText = getPromptWithContext(new Date());

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: promptText },
          {
            inline_data: {
              mime_type: mime || "image/jpeg",
              data: b64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  };

  // Build list of models to try in order: chosen model -> gemini-3.6-flash -> gemini-3.8-flash -> gemini-1.5-flash
  const preferred = (model || "").trim() || "gemini-3.6-flash";
  const candidates = [preferred, "gemini-3.6-flash", "gemini-3.8-flash", "gemini-1.5-flash"];
  const modelsToTry = candidates.filter((m, idx, arr) => m && arr.indexOf(m) === idx);

  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onStatus?.(`Contacting Gemini (${currentModel})…`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(key)}`;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error(`Failed to contact Gemini API: ${err.message}. Check your internet connection.`);
    }

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const rawMsg = errJson?.error?.message || `Gemini API returned error ${res.status}`;
      const lower = rawMsg.toLowerCase();

      // Check if this error indicates an invalid or unsupported model
      const isModelIssue =
        res.status === 404 ||
        lower.includes("not supported for generatecontent") ||
        lower.includes("not found for api version") ||
        lower.includes("is not found");

      if (isModelIssue && i < modelsToTry.length - 1) {
        console.warn(`Model "${currentModel}" failed: ${rawMsg}. Auto-trying fallback model...`);
        onStatus?.(`Model ${currentModel} not available, trying ${modelsToTry[i + 1]}…`);
        lastError = new Error(cleanGeminiErrorMessage(rawMsg, currentModel));
        continue; // Try next candidate model
      }

      throw new Error(cleanGeminiErrorMessage(rawMsg, currentModel));
    }

    onStatus?.("Analyzing extracted event details…");
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      const finishReason = json?.candidates?.[0]?.finishReason;
      if (finishReason === "SAFETY") {
        throw new Error("Gemini blocked the image response due to content safety filters.");
      }
      throw new Error("Gemini completed processing but returned no text content.");
    }

    const event = validateAndNormalize(text);
    return { event, modelUsed: currentModel };
  }

  throw lastError || new Error("Failed to extract details from photo with available Gemini models.");
}
