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
    avisosTarjetaMin: [4320, 1440], // 3 días y 1 día antes del corte/pago
    syncUrl: '',                // endpoint opcional para respaldar/sincronizar
    tema: 'auto',
    vozAlAbrir: true,           // leer el resumen en voz alta al abrir la app
    vozAutoMigrada: true        // instalaciones nuevas ya nacen con la voz activa
  };

  function emptyState() {
    return {
      clases: [],
      tareas: [],
      tarjetas: [],
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
    s.tarjetas = Array.isArray(s.tarjetas) ? s.tarjetas : [];
    s.outbox = Array.isArray(s.outbox) ? s.outbox : [];
    s.avisados = s.avisados && typeof s.avisados === 'object' ? s.avisados : {};
    return s;
  }

  function loadState() {
    return kvGet('state').then(function (raw) {
      var s = normalize(raw);
      var yaMigrada = !!(raw && raw.ajustes && raw.ajustes.vozAutoMigrada);
      if (!yaMigrada) {
        // Instalaciones de antes de esta versión guardaban la voz apagada por
        // defecto; la encendemos una vez y respetamos lo que el usuario decida después.
        s.ajustes.vozAlAbrir = true;
        s.ajustes.vozAutoMigrada = true;
        return saveState(s);
      }
      return s;
    }).catch(function () { return emptyState(); });
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

  /* ------------------------------------------------------------------ Tarjetas */

  function ultimoDiaDelMes(anio, mesIdx) {
    return new Date(anio, mesIdx + 1, 0).getDate();
  }

  /** Próxima ocurrencia de un día fijo del mes (corte/pago), a las `hora`.
   * Si el mes no tiene ese día (p. ej. 31 en febrero), usa el último día. */
  function proximoDiaDelMes(desde, diaMes, hora) {
    var d = new Date(desde);
    d.setHours(hora == null ? 9 : hora, 0, 0, 0);
    d.setDate(Math.min(diaMes, ultimoDiaDelMes(d.getFullYear(), d.getMonth())));
    if (d <= desde) {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(diaMes, ultimoDiaDelMes(d.getFullYear(), d.getMonth())));
    }
    return d;
  }

  /** Para cada tarjeta, sus próximas fechas de corte y de pago. */
  function proximosCortesYPagos(state, ahora) {
    return (state.tarjetas || []).map(function (t) {
      return {
        tarjeta: t,
        corte: proximoDiaDelMes(ahora, Number(t.diaCorte)),
        pago: proximoDiaDelMes(ahora, Number(t.diaPago))
      };
    });
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

    (state.ajustes.avisosTarjetaMin || []).forEach(function (lead) {
      proximosCortesYPagos(state, ahora).forEach(function (o) {
        [{ tipo: 'corte', fecha: o.corte, texto: 'Corte' }, { tipo: 'pago', fecha: o.pago, texto: 'Fecha límite de pago' }]
          .forEach(function (ev) {
            var momento = new Date(ev.fecha.getTime() - lead * 60000);
            // El timestamp de la ocurrencia va en la clave: es mensual, así el
            // aviso de este mes no bloquea el mismo aviso el mes que sigue.
            var clave = 'tarjeta:' + o.tarjeta.id + ':' + ev.tipo + ':' + ev.fecha.getTime() + ':' + lead;
            if (momento <= ahora && ahora - momento < VENTANA && !state.avisados[clave] && ev.fecha > ahora) {
              var restante = lead >= 1440 ? (lead / 1440) + ' día(s)' : (lead >= 60 ? (lead / 60) + ' h' : lead + ' min');
              var det = [o.tarjeta.nombre, o.tarjeta.monto ? ('$' + o.tarjeta.monto) : ''].filter(Boolean).join(' · ');
              alertas.push({
                clave: clave,
                etiqueta: 'tarjeta-' + o.tarjeta.id + '-' + ev.tipo,
                titulo: ev.texto + ' en ' + restante + ': ' + o.tarjeta.nombre,
                cuerpo: (det ? det + ' · ' : '') + formatoFecha(ev.fecha),
                url: ''
              });
            }
          });
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

  /* ---------------------------------------------------------------- Dictado */

  var DIAS_SEM = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var PLATAFORMAS_DICTADO = {
    'google classroom': 'Google Classroom', classroom: 'Google Classroom',
    'microsoft teams': 'Microsoft Teams', teams: 'Microsoft Teams',
    zoom: 'Zoom', moodle: 'Moodle', blackboard: 'Blackboard', canvas: 'Canvas',
    presencial: 'Presencial', correo: 'Correo', 'correo electronico': 'Correo',
    email: 'Correo', whatsapp: 'WhatsApp'
  };
  var MAPA_ACENTOS = { a: '[aá]', e: '[eé]', i: '[íi]', o: '[oó]', u: '[uúü]', n: '[nñ]' };

  function escaparRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Convierte «manana» en un patrón que también acepta «mañana», sin tocar
   * el texto original: así el título dictado conserva sus acentos. */
  function regexTolerante(palabra) {
    return escaparRegex(palabra.toLowerCase()).replace(/[aeioun]/g, function (v) { return MAPA_ACENTOS[v]; });
  }

  function algunaCoincide(texto, palabras) {
    var re = new RegExp('\\b(' + palabras.map(regexTolerante).join('|') + ')\\b');
    return re.test(texto) ? re : null;
  }

  /**
   * Interpreta una frase dictada ("tarea de mecánica, entregar el problemario,
   * para mañana a las 8 de la noche, por classroom") y saca título, materia
   * (contra las clases que ya existen), plataforma y fecha/hora de entrega.
   * No usa IA: son patrones de texto, así que frases fuera de lo común caen
   * a valores por defecto (mañana 23:59) que el usuario puede corregir. El
   * texto nunca pierde acentos ni mayúsculas de origen, para que el título
   * quede tal como se dictó.
   */
  function interpretarDictado(textoOriginal, opciones) {
    opciones = opciones || {};
    var ahora = opciones.ahora || new Date();
    var materiasDisponibles = opciones.materias || []; // [{id, materia}]
    var texto = ' ' + String(textoOriginal || '').replace(/[.,;:!?¿¡]/g, ' ') + ' ';
    var textoMin = texto.toLowerCase();
    var quitar = function (re) { texto = texto.replace(re, ' '); textoMin = texto.toLowerCase(); };

    // Verbo inicial ("agrega", "anota", "recuérdame"...) y luego, si la hay,
    // la palabra "tarea/pendiente/actividad" con su conector.
    var reVerbo = new RegExp('^\\s*(' +
      ['agregar', 'agrega', 'anota', 'anotar', 'registra', 'registrar', 'pon',
        'crea', 'crear', 'recuerdame', 'recuerda'].map(regexTolerante).join('|') +
      ')\\b(\\s+que)?(\\s+(el|la|los|las))?\\s*');
    quitar(reVerbo);
    quitar(new RegExp('^\\s*(' + ['nueva', 'nuevo'].map(regexTolerante).join('|') + ')\\s*'));
    quitar(new RegExp('^\\s*(' + ['tarea', 'pendiente', 'actividad'].map(regexTolerante).join('|') +
      ')\\s*(de|para)?\\s*'));

    // Plataforma
    var plataforma = '';
    Object.keys(PLATAFORMAS_DICTADO).sort(function (a, b) { return b.length - a.length; }).some(function (clave) {
      var pat = regexTolerante(clave);
      var re = new RegExp('\\b(por|en)\\s+' + pat + '\\b|\\b' + pat + '\\b');
      var m = textoMin.match(re);
      if (m) { plataforma = PLATAFORMAS_DICTADO[clave]; quitar(new RegExp(escaparRegex(m[0]))); return true; }
      return false;
    });

    // Materia: contra las clases reales del usuario, por nombre completo o por
    // una palabra distintiva (5+ letras) de la materia.
    var claseId = '', materiaNombre = '';
    materiasDisponibles.slice()
      .sort(function (a, b) { return b.materia.length - a.materia.length; })
      .some(function (c) {
        var reCompleta = new RegExp('\\b(de|del|para)?\\s*' + regexTolerante(c.materia) + '\\b');
        var m = textoMin.match(reCompleta);
        if (m) { claseId = c.id; materiaNombre = c.materia; quitar(new RegExp(escaparRegex(m[0]))); return true; }
        var palabra = c.materia.split(/\s+/).filter(function (p) { return p.length >= 5; })
          .find(function (p) { return new RegExp('\\b' + regexTolerante(p) + '\\b').test(textoMin); });
        if (palabra) {
          claseId = c.id; materiaNombre = c.materia;
          var mp = textoMin.match(new RegExp('\\b' + regexTolerante(palabra) + '\\b'));
          quitar(new RegExp(escaparRegex(mp[0])));
          return true;
        }
        return false;
      });

    // Hora (antes que la fecha: si no, "de la mañana" en "a las 9 de la mañana"
    // se confunde con la palabra "mañana" de "día siguiente").
    var fecha = new Date(ahora);
    var horaEncontrada = false;
    var mHora = textoMin.match(new RegExp('\\ba\\s*las?\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(de\\s+la\\s+(' +
        regexTolerante('manana') + '|tarde|noche)|am|pm)?\\b')) ||
      textoMin.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
    if (mHora) {
      var h = parseInt(mHora[1], 10);
      var min = mHora[2] ? parseInt(mHora[2], 10) : 0;
      var periodo = (mHora[3] || mHora[4] || '').toLowerCase();
      if (/tarde|noche|pm/.test(periodo) && h < 12) h += 12;
      if (/pm/.test(periodo) === false && /ma[nñ]ana|am/.test(periodo) && h === 12) h = 0;
      fecha.setHours(h, min, 0, 0);
      horaEncontrada = true;
      quitar(new RegExp(escaparRegex(mHora[0])));
    }

    // Fecha
    var fechaEncontrada = false;
    if (algunaCoincide(textoMin, ['pasado manana'])) {
      fecha.setDate(ahora.getDate() + 2); fechaEncontrada = true;
      quitar(algunaCoincide(textoMin, ['pasado manana']));
    } else if (algunaCoincide(textoMin, ['manana'])) {
      fecha.setDate(ahora.getDate() + 1); fechaEncontrada = true;
      quitar(algunaCoincide(textoMin, ['manana']));
    } else if (algunaCoincide(textoMin, ['hoy'])) {
      fechaEncontrada = true;
      quitar(algunaCoincide(textoMin, ['hoy']));
    } else {
      var mDias = textoMin.match(/\ben\s+(\d+)\s+dias?\b/);
      if (mDias) {
        fecha.setDate(ahora.getDate() + parseInt(mDias[1], 10)); fechaEncontrada = true;
        quitar(new RegExp(escaparRegex(mDias[0])));
      } else {
        var diaSemHallado = null;
        DIAS_SEM.some(function (d, idx) {
          var re = new RegExp('\\b(el\\s+)?(este\\s+|' + regexTolerante('proximo') + '\\s+)?' + regexTolerante(d) + '\\b');
          var m = textoMin.match(re);
          if (m) { diaSemHallado = { idx: idx, proximo: /pr[oó]ximo/.test(m[0]) }; quitar(new RegExp(escaparRegex(m[0]))); return true; }
          return false;
        });
        if (diaSemHallado) {
          var delta = (diaSemHallado.idx - ahora.getDay() + 7) % 7;
          if (delta === 0 && diaSemHallado.proximo) delta = 7;
          fecha.setDate(ahora.getDate() + delta);
          fechaEncontrada = true;
        } else {
          var mFechaMes = null, mesIdx = -1;
          MESES.some(function (mes, idx) {
            var re = new RegExp('\\b(\\d{1,2})\\s+de\\s+' + regexTolerante(mes) + '\\b');
            var m = textoMin.match(re);
            if (m) { mFechaMes = m; mesIdx = idx; return true; }
            return false;
          });
          if (mFechaMes) {
            fecha.setMonth(mesIdx); fecha.setDate(parseInt(mFechaMes[1], 10));
            if (fecha < ahora) fecha.setFullYear(fecha.getFullYear() + 1);
            fechaEncontrada = true;
            quitar(new RegExp(escaparRegex(mFechaMes[0])));
          } else {
            var mNum = textoMin.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
            if (mNum) {
              fecha.setMonth(parseInt(mNum[2], 10) - 1);
              fecha.setDate(parseInt(mNum[1], 10));
              if (mNum[3]) fecha.setFullYear(mNum[3].length === 2 ? 2000 + parseInt(mNum[3], 10) : parseInt(mNum[3], 10));
              else if (fecha < ahora) fecha.setFullYear(fecha.getFullYear() + 1);
              fechaEncontrada = true;
              quitar(new RegExp(escaparRegex(mNum[0])));
            }
          }
        }
      }
    }
    if (!fechaEncontrada) fecha.setDate(ahora.getDate() + 1);
    if (!horaEncontrada) fecha.setHours(23, 59, 0, 0);

    // Lo que sobra, limpio de conectores sueltos, es el título (con sus acentos intactos).
    texto = texto.replace(/\s+/g, ' ').trim();
    var conectores = ['para', 'de', 'del', 'el', 'la', 'los', 'las', 'por', 'en', 'que'];
    for (var i = 0; i < 3; i++) {
      texto = texto
        .replace(new RegExp('^(' + conectores.map(regexTolerante).join('|') + ')\\s+', 'i'), '')
        .replace(new RegExp('\\s+(' + conectores.map(regexTolerante).join('|') + ')$', 'i'), '')
        .trim();
    }
    var titulo = texto
      ? texto.charAt(0).toUpperCase() + texto.slice(1)
      : (materiaNombre ? 'Tarea de ' + materiaNombre : 'Nueva tarea');

    return {
      titulo: titulo,
      claseId: claseId,
      materiaNombre: materiaNombre,
      plataforma: plataforma,
      entrega: fecha,
      fechaSupuesta: !fechaEncontrada,
      horaSupuesta: !horaEncontrada
    };
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
    proximoDiaDelMes: proximoDiaDelMes,
    proximosCortesYPagos: proximosCortesYPagos,
    alertasPendientes: alertasPendientes,
    dispararAlertas: dispararAlertas,
    formatoFecha: formatoFecha,
    encolar: encolar,
    sincronizar: sincronizar,
    interpretarDictado: interpretarDictado
  };
})(typeof self !== 'undefined' ? self : this);
