/* sw.js — DEWA Field Tool Service Worker
   Strategy: NETWORK FIRST — always loads live from server.
   Cache only used as fallback when there is no internet connection. */

var CACHE = 'dewa-v1';
var CACHE_URLS = [
  './team.html',
  './patch.js',
  './camera-patch.js',
  './progress-patch.js',
  './manifest.json'
];

/* Pre-cache files on first install */
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(CACHE_URLS); })
  );
  self.skipWaiting();
});

/* Clean up old caches */
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

/* NETWORK FIRST — always fetch live, cache only as offline fallback */
self.addEventListener('fetch', function(e){
  /* Never intercept Apps Script calls — always go direct to server */
  if(e.request.url.indexOf('script.google.com') !== -1) return;
  if(e.request.url.indexOf('googleapis.com') !== -1) return;

  e.respondWith(
    fetch(e.request)
      .then(function(resp){
        /* Got live response — update the cache silently */
        if(resp && resp.status === 200){
          var clone = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
        }
        return resp;
      })
      .catch(function(){
        /* No internet — serve from cache so app still opens */
        return caches.match(e.request)
          .then(function(cached){
            return cached || new Response(
              '<h2 style="font-family:sans-serif;padding:20px">No internet connection.<br>Please connect and refresh.</h2>',
              { headers: {'Content-Type':'text/html'} }
            );
          });
      })
  );
});
