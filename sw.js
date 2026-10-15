/* =========================================================
   Schedule from Pic — Service Worker
   Cache-first strategy for app shell assets.
   ========================================================= */

const CACHE_VERSION = 'schedule-v8';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './gemini.js',
  './providers.js',
  './prompt.js',
  './export.js',
  './parser.js',
  './ocr.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never cache API calls to Google Gemini or external services
  const url = new URL(request.url);
  if (
    url.host.endsWith('googleapis.com') ||
    url.host.endsWith('google.com') ||
    url.host.endsWith('groq.com') ||
    url.host.endsWith('huggingface.co') ||
    url.host.endsWith('cdn.jsdelivr.net') ||
    url.host.endsWith('unpkg.com')
  ) {
    return; // let network handle it
  }

  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
