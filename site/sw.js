// Guarda os arquivos do app para abrir rápido. Os dados sempre vêm do Supabase.
// Ao publicar uma nova versão, aumente o número abaixo.
const CACHE = 'dashboard-control-v3';
const FILES = [
  './',
  './index.html',
  './historico.html',
  './config.js',
  './manifest.webmanifest',
  './css/styles.css',
  './js/dashboard.js',
  './js/historico.js',
  './js/supabase-adapter.js',
  './assets/ascii-walker.png',
  './fonts/PixelifySans.ttf',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return; // Supabase passa direto

  // Tenta a rede primeiro para receber atualizações; sem internet, usa a cópia guardada.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
