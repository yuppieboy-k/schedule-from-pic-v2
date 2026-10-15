/* =========================================================
   Schedule from Pic — Gemini Vision Client
   - extractWithGemini()  : Sends image to Gemini Vision API
   - testGeminiKey()      : Validates an API key against Google AI Studio
   - downscaleImage()     : Client-side downscaler to optimize upload speed
   ========================================================= */

import { getPromptWithContext, validateAndNormalize } from "./prompt.js";

export const GEMINI_MODELS = [
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", desc: "Recommended • Fastest & highest accuracy" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", desc: "High speed • Proven vision capabilities" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", desc: "Next-gen ultra fast response" },
  { id: "gemini-1.5-pro",   name: "Gemini 1.5 Pro",   desc: "Deep reasoning for dense/complex posters" },
];

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
    const msg = errJson?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
    return { ok: false, error: msg };
  } catch (err) {
    return { ok: false, error: err.message || "Network error while connecting to Gemini API" };
  }
}

/**
 * Extract calendar event details using Google Gemini Vision.
 *
 * @param {string} dataUrl - Base64 data URL of the image
 * @param {object} opts
 * @param {string} opts.apiKey - User's Gemini API key
 * @param {string} [opts.model="gemini-2.5-flash"] - Chosen model ID
 * @param {function} [opts.onStatus] - Status update callback
 * @param {AbortSignal} [opts.signal] - Abort controller signal
 * @returns {Promise<{ event: object, modelUsed: string }>}
 */
export async function extractWithGemini(dataUrl, { apiKey, model = "gemini-2.5-flash", onStatus, signal } = {}) {
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

  const selectedModel = model || "gemini-2.5-flash";
  onStatus?.(`Sending photo to Gemini (${selectedModel})…`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(key)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`Failed to contact Gemini API: ${err.message}. Check your internet connection.`);
  }

  if (!res.ok) {
    // If the chosen model is 404, attempt fallback to gemini-1.5-flash if different
    if (res.status === 404 && selectedModel !== "gemini-1.5-flash") {
      onStatus?.("Model unavailable, trying Gemini 1.5 Flash fallback…");
      return extractWithGemini(dataUrl, { apiKey, model: "gemini-1.5-flash", onStatus, signal });
    }

    const errJson = await res.json().catch(() => null);
    const errMsg = errJson?.error?.message || `Gemini API returned error ${res.status}`;
    throw new Error(errMsg);
  }

  onStatus?.("Analyzing extracted event details…");
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const finishReason = json?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY") {
      throw new Error("Gemini blocked the image response due to safety filters.");
    }
    throw new Error("Gemini completed processing but returned no text content.");
  }

  const event = validateAndNormalize(text);
  return { event, modelUsed: selectedModel };
}
