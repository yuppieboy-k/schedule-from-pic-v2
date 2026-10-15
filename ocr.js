/* =========================================================
   Schedule from Pic — Offline OCR (Tesseract.js)
   Lazy-loaded only when the user is offline and we need a
   local-only extraction path. The Tesseract worker + WASM
   blob are pulled from jsDelivr on first use and cached by
   the service worker.
   ========================================================= */

import { parseFromText } from "./parser.js";

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

let _loading = null;

/**
 * Lazily load the Tesseract.js script. Caches the promise so a
 * second call during in-flight load returns the same one.
 */
export function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_loading) return _loading;
  _loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Failed to load Tesseract.js from CDN"));
    document.head.appendChild(s);
  });
  return _loading;
}

/**
 * Run OCR on a data URL and return the parsed event.
 * `onProgress` is optional: receives a number 0..1.
 */
export async function ocrExtract(dataUrl, { onProgress, onStatus } = {}) {
  onStatus?.("Loading Tesseract.js (one-time, ~10 MB)…");
  const Tesseract = await loadTesseract();

  onStatus?.("Reading text on-device…");
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        onProgress?.(m.progress);
      }
    },
  });

  try {
    const { data } = await worker.recognize(dataUrl);
    onStatus?.("Parsing text…");
    const text = (data?.text || "").trim();
    if (!text) throw new Error("OCR returned no text — try a clearer photo");
    return parseFromText(text);
  } finally {
    await worker.terminate().catch(() => {});
  }
}
