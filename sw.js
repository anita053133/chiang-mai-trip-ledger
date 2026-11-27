const CACHE = 'chiang-mai-2026-shell-v2';
const SHELL = ['./index.html', './style.css', './app.js', './config.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(key => key.startsWith('chiang-mai-2026-shell-') && key !== CACHE)
      .map(key => caches.delete(key)))
  ));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const indexURL = new URL('./index.html', self.registration.scope).href;
  const isNavigation = request.mode === 'navigate' &&
    [self.registration.scope, indexURL].includes(new URL(new URL(request.url).pathname, self.location.origin).href);
  const key = isNavigation ? indexURL : request.url;
  if (!SHELL.some(path => new URL(path, self.registration.scope).href === key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
