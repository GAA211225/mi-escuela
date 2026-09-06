/* Núcleo compartido entre la página y el service worker.
   Se carga con <script src="js/core.js"> y con importScripts() desde sw.js,
   por eso no usa módulos ES: se cuelga de globalThis. */
(function (global) {
  'use strict';

  var DB_NAME = 'escuela';
  var DB_VERSION = 1;
  var STORE = 'kv';

  /* ---------------------------------------------------------------- IndexedDB */

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idb(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var out = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(out && out.result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function kvGet(key) { return idb('readonly', function (s) { return s.get(key); }); }
  function kvSet(key, value) { return idb('readwrite', function (s) { return s.put(value, key); }); }

  /* -------------------------------------------------------------------- Estado */

  var DEFAULT_SETTINGS = {
    avisoClaseMin: 10,          // minutos antes de que empiece la clase
    avisosTareaMin: [1440, 120], // 1 día y 2 horas antes de la entrega
    syncUrl: '',                // endpoint opcional para respaldar/sincronizar
    tema: 'auto'
  };

  function emptyState() {
    return {
      clases: [],
      tareas: [],
      ajustes: Object.assign({}, DEFAULT_SETTINGS),
      outbox: [],
      avisados: {},   // claveDeAlerta -> timestamp en que se notificó
      actualizado: 0,
      dispositivo: uid()
    };
  }

  function normalize(state) {
    var s = Object.assign(emptyState(), state || {});
    s.ajustes = Object.assign({}, DEFAULT_SETTINGS, s.ajustes || {});
    s.clases = Array.isArray(s.clases) ? s.clases : [];
    s.tareas = Array.isArray(s.tareas) ? s.tareas : [];
    s.outbox = Array.isArray(s.outbox) ? s.outbox : [];
    s.avisados = s.avisados && typeof s.avisados === 'object' ? s.avisados : {};
    return s;
  }

  function loadState() {
    return kvGet('state').then(normalize).catch(function () { return emptyState(); });
  }

  function saveState(state) {
    state.actualizado = Date.now();
    return kvSet('state', state).then(function () { return state; });
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* --------------------------------------------------------------- Fechas/horas */

  var DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  var DIAS_CORTO = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  function minutesOf(hhmm) {
    var p = String(hhmm || '').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function hhmm(minutes) {
    var m = ((minutes % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  /** Fecha del día `dia` (0=domingo) en la semana de `desde`, a la hora hh:mm. */
  function fechaDeClase(desde, dia, horaInicio, semanasAdelante) {
    var d = new Date(desde);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((dia - d.getDay() + 7) % 7) + 7 * (semanasAdelante || 0));
    d.setMinutes(minutesOf(horaInicio));
    return d;
  }

  /** Las próximas `limite` ocurrencias de clases a partir de `ahora`. */
  function proximasClases(state, ahora, limite) {
    var out = [];
    for (var semana = 0; semana < 2; semana++) {
      state.clases.forEach(function (c) {
        var inicio = fechaDeClase(ahora, Number(c.dia), c.inicio, semana);
        var fin = new Date(inicio.getTime() + Math.max(1, minutesOf(c.fin) - minutesOf(c.inicio)) * 60000);
        if (fin > ahora) out.push({ clase: c, inicio: inicio, fin: fin });
      });
    }
    out.sort(function (a, b) { return a.inicio - b.inicio; });
    return out.slice(0, limite || out.length);
  }

  function claseEnCurso(state, ahora) {
    var hoy = ahora.getDay();
    var min = ahora.getHours() * 60 + ahora.getMinutes();
    var found = null;
    state.clases.forEach(function (c) {
      if (Number(c.dia) !== hoy) return;
      if (min >= minutesOf(c.inicio) && min < minutesOf(c.fin)) found = c;
    });
    return found;
  }

  function tareasPendientes(state) {
    return state.tareas
      .filter(function (t) { return !t.hecha; })
      .sort(function (a, b) { return new Date(a.entrega) - new Date(b.entrega); });
  }

  /** «Edif. A1 · Salón 122», omitiendo lo que falte. */
  function lugar(c) {
    var p = [];
    if (c.edificio) p.push('Edif. ' + c.edificio);
    if (c.salon) p.push('Salón ' + c.salon);
    return p.join(' · ');
  }

  function nombreMateria(state, tarea) {
    if (tarea.claseId) {
      var c = state.clases.filter(function (x) { return x.id === tarea.claseId; })[0];
      if (c) return c.materia;
    }
    return tarea.materia || '';
  }

  /* ------------------------------------------------------------------- Alertas */

  /** Alertas que ya deberían haberse mostrado y siguen vigentes (ventana de 1 h). */
  function alertasPendientes(state, ahora) {
    var alertas = [];
    var VENTANA = 60 * 60000; // no mostramos avisos con más de una hora de retraso
    var avisoClase = Number(state.ajustes.avisoClaseMin) || 0;

    proximasClases(state, ahora, 12).forEach(function (o) {
      var momento = new Date(o.inicio.getTime() - avisoClase * 60000);
      var clave = 'clase:' + o.clase.id + ':' + o.inicio.getTime();
      if (momento <= ahora && ahora - momento < VENTANA && !state.avisados[clave]) {
        var partes = [];
        var donde = lugar(o.clase);
        if (donde) partes.push(donde);
        if (o.clase.plataforma) partes.push(o.clase.plataforma);
        partes.push(hhmm(minutesOf(o.clase.inicio)) + '–' + hhmm(minutesOf(o.clase.fin)));
        alertas.push({
          clave: clave,
          etiqueta: 'clase-' + o.clase.id,
          titulo: (avisoClase > 0 ? 'En ' + avisoClase + ' min: ' : 'Ahora: ') + o.clase.materia,
          cuerpo: partes.join(' · '),
          url: o.clase.url || ''
        });
      }
    });

    (state.ajustes.avisosTareaMin || []).forEach(function (lead) {
      tareasPendientes(state).forEach(function (t) {
        var entrega = new Date(t.entrega);
        if (isNaN(entrega)) return;
        var momento = new Date(entrega.getTime() - lead * 60000);
        var clave = 'tarea:' + t.id + ':' + lead;
        if (momento <= ahora && ahora - momento < VENTANA && !state.avisados[clave] && entrega > ahora) {
          var restante = lead >= 1440 ? (lead / 1440) + ' día(s)' : (lead >= 60 ? (lead / 60) + ' h' : lead + ' min');
          var det = [nombreMateria(state, t), t.plataforma].filter(Boolean).join(' · ');
          alertas.push({
            clave: clave,
            etiqueta: 'tarea-' + t.id + '-' + lead,
            titulo: 'Entrega en ' + restante + ': ' + t.titulo,
            cuerpo: (det ? det + ' · ' : '') + 'Vence ' + formatoFecha(entrega),
            url: t.url || ''
          });
        }
      });
    });

    return alertas;
  }

  function formatoFecha(d) {
    return DIAS_CORTO[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1) + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /** Muestra las alertas pendientes y las marca como avisadas. Devuelve cuántas mostró. */
  function dispararAlertas(registration, ahora) {
    return loadState().then(function (state) {
      var alertas = alertasPendientes(state, ahora || new Date());
      if (!alertas.length) return 0;
      return Promise.all(alertas.map(function (a) {
        state.avisados[a.clave] = Date.now();
        return registration.showNotification(a.titulo, {
          body: a.cuerpo,
          tag: a.etiqueta,
          icon: 'icons/icon-192.png',
          badge: 'icons/icon-192.png',
          renotify: true,
          data: { url: a.url }
        });
      })).then(function () {
        limpiarAvisados(state);
        return saveState(state);
      }).then(function () { return alertas.length; });
    });
  }

  function limpiarAvisados(state) {
    var corte = Date.now() - 30 * 24 * 3600 * 1000;
    Object.keys(state.avisados).forEach(function (k) {
      if (state.avisados[k] < corte) delete state.avisados[k];
    });
  }

  /* ----------------------------------------------------------------- Outbox/sync */

  function encolar(state, entidad, op, datos) {
    state.outbox.push({
      id: uid(),
      ts: Date.now(),
      dispositivo: state.dispositivo,
      entidad: entidad,
      op: op,
      datos: datos
    });
    return state;
  }

  /** Envía la cola pendiente al endpoint configurado. Si no hay endpoint, no hace nada. */
  function sincronizar() {
    return loadState().then(function (state) {
      var url = (state.ajustes.syncUrl || '').trim();
      if (!url) return { estado: 'sin-endpoint', pendientes: state.outbox.length };
      if (!state.outbox.length) return { estado: 'al-dia', pendientes: 0 };
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { estado: 'sin-conexion', pendientes: state.outbox.length };
      }
      var lote = state.outbox.slice();
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dispositivo: state.dispositivo,
          actualizado: state.actualizado,
          cambios: lote,
          snapshot: { clases: state.clases, tareas: state.tareas }
        })
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return loadState();
      }).then(function (fresco) {
        var enviados = {};
        lote.forEach(function (c) { enviados[c.id] = true; });
        fresco.outbox = fresco.outbox.filter(function (c) { return !enviados[c.id]; });
        fresco.ajustes.ultimaSync = Date.now();
        return saveState(fresco);
      }).then(function (s) {
        return { estado: 'enviado', pendientes: s.outbox.length };
      }).catch(function (e) {
        return { estado: 'error', error: String(e && e.message || e), pendientes: state.outbox.length };
      });
    });
  }

  global.Escuela = {
    DIAS: DIAS,
    DIAS_CORTO: DIAS_CORTO,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    uid: uid,
    loadState: loadState,
    saveState: saveState,
    emptyState: emptyState,
    minutesOf: minutesOf,
    hhmm: hhmm,
    fechaDeClase: fechaDeClase,
    proximasClases: proximasClases,
    claseEnCurso: claseEnCurso,
    tareasPendientes: tareasPendientes,
    lugar: lugar,
    nombreMateria: nombreMateria,
    alertasPendientes: alertasPendientes,
    dispararAlertas: dispararAlertas,
    formatoFecha: formatoFecha,
    encolar: encolar,
    sincronizar: sincronizar
  };
})(typeof self !== 'undefined' ? self : this);
