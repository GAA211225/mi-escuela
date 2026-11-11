/* Service worker: caché para uso sin internet, avisos en segundo plano y
   reenvío de los cambios que se hicieron offline. Chrome / Android. */
importScripts('js/core.js');

var VERSION = 'v7';
var CACHE = 'mi-escuela-' + VERSION;
var SHELL = [
  './',
  'index.html',
  'css/estilos.css',
  'js/core.js',
  'js/app.js',
  'datos/horario.json',
  'datos/pendientes.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png'
];

self.addEventListener('install', function (ev) {
  // cache: 'reload' salta la caché HTTP de GitHub Pages (10 min): así la copia
  // offline siempre es un juego completo de la misma versión.
  ev.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () {
    return self.registration.periodicSync
      ? self.registration.periodicSync.register('revisar-alertas', { minInterval: 15 * 60 * 1000 }).catch(function () {})
      : null;
  }).then(function () { return self.clients.claim(); }));
});

/* Con internet, siempre la versión publicada (revalidando contra el servidor, sin
   la caché HTTP); sin internet, la copia guardada. Servir primero la copia vieja
   podía mezclar archivos de dos versiones y dejar la app sin arrancar. */
self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  ev.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) {
        var copia = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copia); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      });
    })
  );
});

/* Revisión periódica de avisos: Chrome despierta al service worker cada tanto. */
self.addEventListener('periodicsync', function (ev) {
  if (ev.tag === 'revisar-alertas') {
    ev.waitUntil(
      self.Escuela.dispararAlertas(self.registration, new Date())
        .then(function () { return self.Escuela.sincronizar(); })
    );
  }
});

/* Cuando vuelve el internet, Chrome dispara este evento y sube lo pendiente. */
self.addEventListener('sync', function (ev) {
  if (ev.tag === 'enviar-cambios') ev.waitUntil(self.Escuela.sincronizar());
});

self.addEventListener('message', function (ev) {
  if (!ev.data) return;
  if (ev.data.tipo === 'revisar-alertas') {
    ev.waitUntil(self.Escuela.dispararAlertas(self.registration, new Date()));
  }
  if (ev.data.tipo === 'sincronizar') ev.waitUntil(self.Escuela.sincronizar());
});

/* Al tocar el aviso: abre la liga de la clase/tarea o la app. */
self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  var destino = (ev.notification.data && ev.notification.data.url) || './';
  ev.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
    if (destino === './') {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].url.indexOf(self.registration.scope) === 0) return lista[i].focus();
      }
    }
    return clients.openWindow(destino);
  }));
});
