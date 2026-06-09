/* sw.js — DEWA Field Tool Service Worker */
var CACHE = 'dewa-v1';
var CACHE_URLS = [
  './team.html',
  './patch.js',
  './camera-patch.js',
  './progress-patch.js',
  './manifest.json'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(CACHE_URLS); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e){
  // Don't cache Apps Script calls
  if(e.request.url.indexOf('script.google.com')!==-1) return;
  e.respondWith(
    caches.match(e.request).then(function(r){
      return r || fetch(e.request).then(function(resp){
        var clone = resp.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
        return resp;
      });
    }).catch(function(){ return caches.match('./team.html'); })
  );
});
