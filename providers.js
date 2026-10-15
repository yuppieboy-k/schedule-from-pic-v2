/* =========================================================
   Schedule from Pic — Provider Adapter
   Primary: Google Gemini Vision
   Fallback: On-device OCR / Groq / HuggingFace
   ========================================================= */

import { extractWithGemini, downscaleImage, splitDataUrl, testGeminiKey, GEMINI_MODELS } from "./gemini.js";
import { ocrExtract } from "./ocr.js";

export { downscaleImage, splitDataUrl, testGeminiKey, extractWithGemini, GEMINI_MODELS };

export const gemini = {
  name: "Google Gemini",
  needs: { apiKey: true },
  async extract(dataUrl, { apiKey, model = "gemini-2.5-flash", onStatus, signal }) {
    const res = await extractWithGemini(dataUrl, { apiKey, model, onStatus, signal });
    return res.event;
  },
};

export const PROVIDERS = {
  gemini,
};

export async function extractWithFailover(providerName, dataUrl, keys, opts = {}) {
  const apiKey = keys?.gemini || keys?.apiKey;
  if (!apiKey) {
    throw new Error("Missing Gemini API key. Please configure your key in Settings.");
  }

  opts.onProviderTry?.("Google Gemini");
  const result = await extractWithGemini(dataUrl, {
    apiKey,
    model: opts.model || "gemini-2.5-flash",
    onStatus: opts.onStatus,
    signal: opts.signal,
  });

  return {
    provider: `Gemini (${result.modelUsed})`,
    event: result.event,
  };
}
