// ORACLE Service Worker v2
var CACHE_NAME = 'oracle-v2';
var URLS_TO_CACHE = [
  '/',
  '/app/',
  '/games',
  '/pick',
  '/props',
  '/parlay',
  '/sharp',
  '/record',
  '/share',
  '/player',
  '/manifest.json',
];

// Install — cache critical pages
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Caching critical pages');
      return cache.addAll(URLS_TO_CACHE).catch(function() {
        // Silently fail if some pages can't be cached
        console.log('[SW] Some pages could not be cached');
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback for pages; cache first for static assets
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;
  
  // API calls — always network, never cache
  if (url.pathname.startsWith('/api/')) return;
  
  // Pages — network first, cache fallback
  event.respondWith(
    fetch(event.request).then(function(response) {
      // Cache successful page loads
      if (response.ok && response.type === 'basic') {
        var responseClone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, responseClone);
        });
      }
      return response;
    }).catch(function() {
      // Network failed — try cache
      return caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        // If no cache, show offline page
        if (event.request.mode === 'navigate') {
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>ORACLE — Offline</title><style>body{background:#060a14;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}h1{font-size:24px;margin-bottom:8px}p{color:#94a3b8;font-size:14px}.btn{display:inline-block;margin-top:16px;padding:10px 24px;background:#38bdf8;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold}</style></head><body><div><h1>⟁ ORACLE</h1><p>You\'re offline. Connect to the internet to see live picks.</p><a href="/" class="btn" onclick="location.reload()">Retry</a></div></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        }
      });
    })
  );
});

// Push notifications
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'ORACLE', body: event.data ? event.data.text() : 'New pick available!' }; }
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'ORACLE Pick Alert', {
      body: data.body || 'Check out today\'s picks!',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'oracle-pick',
      data: { url: data.url || '/app/' },
      actions: [
        { action: 'view', title: 'View Pick' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    })
  );
});

// Notification click
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data ? event.notification.data.url : '/app/';
  if (event.action === 'dismiss') return;
  
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(windowClients) {
      // Focus existing window if open
      for (var i = 0; i < windowClients.length; i++) {
        if (windowClients[i].url.indexOf('oraclepredictapp.com') >= 0) {
          windowClients[i].navigate(url);
          return windowClients[i].focus();
        }
      }
      // Otherwise open new window
      return clients.openWindow(url);
    })
  );
});
