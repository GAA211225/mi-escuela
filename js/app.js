/* Interfaz de Mi Escuela. Pensada para Chrome en Android (y el mismo Chrome en escritorio). */
(function () {
  'use strict';

  var E = self.Escuela;
  var estado = null;
  var registro = null;          // ServiceWorkerRegistration
  var filtroTareas = 'pendientes';
  var vozPendiente = null;      // texto que quedó esperando un toque del usuario

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ------------------------------------------------------------------- arranque */

  document.addEventListener('DOMContentLoaded', function () {
    E.loadState().then(function (s) {
      estado = s;
      conectarUI();
      pintarTodo();
      aplicarAjustesEnFormulario();
      registrarServiceWorker();
      abrirVistaDeHash();
      revisarAlertas();
      if (estado.ajustes.vozAlAbrir) hablar(resumenHablado());
      setInterval(function () { pintarHoy(); revisarAlertas(); }, 30000);
    });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && estado) { pintarTodo(); revisarAlertas(); sincronizar(true); }
  });

  window.addEventListener('online', function () { pintarRed(); sincronizar(true); });
  window.addEventListener('offline', pintarRed);

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      registro = reg;
      pedirAvisosPeriodicos(reg);
    }).catch(function (e) { console.warn('SW no registrado', e); });
  }

  /** Chrome/Android puede despertar la app cada cierto tiempo para revisar avisos. */
  function pedirAvisosPeriodicos(reg) {
    if (!('periodicSync' in reg)) return;
    navigator.permissions.query({ name: 'periodic-background-sync' }).then(function (p) {
      if (p.state !== 'granted') return;
      reg.periodicSync.register('revisar-alertas', { minInterval: 15 * 60 * 1000 })
        .catch(function () { /* el navegador decide; no es crítico */ });
    }).catch(function () {});
  }

  /* -------------------------------------------------------------------- guardar */

  function guardar(entidad, op, datos) {
    E.encolar(estado, entidad, op, datos);
    return E.saveState(estado).then(function () {
      pintarTodo();
      sincronizar(true);
    });
  }

  function sincronizar(silencioso) {
    return E.sincronizar().then(function (r) {
      return E.loadState().then(function (s) {
        estado.outbox = s.outbox;
        estado.ajustes.ultimaSync = s.ajustes.ultimaSync;
        pintarEstadoSync(r);
        if (r.estado === 'sin-conexion' || r.estado === 'error') pedirReenvio();
        if (!silencioso) {
          if (r.estado === 'enviado') aviso('Sincronizado');
          else if (r.estado === 'sin-endpoint') aviso('No hay servidor configurado: todo se guarda en el teléfono');
          else if (r.estado === 'sin-conexion') aviso('Sin conexión: se enviará al volver el internet');
          else if (r.estado === 'error') aviso('No se pudo sincronizar: ' + r.error);
          else aviso('Todo al día');
        }
        return r;
      });
    });
  }

  /** Le pide a Chrome que reintente el envío en cuanto vuelva el internet. */
  function pedirReenvio() {
    if (!registro || !('sync' in registro)) return;
    registro.sync.register('enviar-cambios').catch(function () {});
  }

  /* -------------------------------------------------------------------- pintado */

  function pintarTodo() {
    pintarHoy();
    pintarHorario();
    pintarTareas();
    pintarRed();
    pintarPermiso();
    llenarSelectMaterias();
  }

  function pintarRed() {
    var chip = $('#estado-red');
    var pend = estado ? estado.outbox.length : 0;
    if (!navigator.onLine) {
      chip.textContent = pend ? 'Sin conexión · ' + pend + ' por enviar' : 'Sin conexión';
      chip.classList.add('offline');
    } else {
      chip.textContent = pend ? pend + ' por enviar' : 'En línea';
      chip.classList.remove('offline');
    }
  }

  function pintarHoy() {
    if (!estado) return;
    var ahora = new Date();
    $('#fecha-hoy').textContent = E.DIAS[ahora.getDay()] + ' ' + ahora.getDate() + '/' + (ahora.getMonth() + 1);

    // Tarjeta grande: clase en curso o la que sigue
    var enCurso = E.claseEnCurso(estado, ahora);
    var prox = E.proximasClases(estado, ahora, 1)[0];
    var caja = $('#tarjeta-siguiente');
    if (enCurso) {
      caja.innerHTML = tarjetaGrande('Clase en curso', enCurso,
        'Termina a las ' + enCurso.fin);
    } else if (prox) {
      caja.innerHTML = tarjetaGrande('Sigue', prox.clase, faltanTexto(prox.inicio - ahora) + ' · ' + E.formatoFecha(prox.inicio));
    } else {
      caja.innerHTML = '<div class="etiqueta">Sin clases</div>' +
        '<div class="materia">Agrega tu horario</div>' +
        '<div class="detalle">Ve a la pestaña Horario y toca «+ Clase».</div>';
    }

    // Clases de hoy
    var hoy = estado.clases
      .filter(function (c) { return Number(c.dia) === ahora.getDay(); })
      .sort(function (a, b) { return E.minutesOf(a.inicio) - E.minutesOf(b.inicio); });
    var min = ahora.getHours() * 60 + ahora.getMinutes();
    $('#lista-hoy').innerHTML = hoy.length ? hoy.map(function (c) {
      var estadoClase = min >= E.minutesOf(c.fin) ? 'pasada' : (min >= E.minutesOf(c.inicio) ? 'ahora' : '');
      return '<button class="item ' + estadoClase + '" data-clase="' + c.id + '">' +
        '<span class="hora">' + esc(c.inicio) + '</span>' +
        '<span class="cuerpo"><span class="titulo">' + esc(c.materia) + '</span>' +
        '<span class="sub">' + esc(detalleClase(c)) + '</span></span></button>';
    }).join('') : '<div class="vacio">Hoy no tienes clases registradas.</div>';

    // Próximas entregas (14 días)
    var limite = new Date(ahora.getTime() + 14 * 86400000);
    var entregas = E.tareasPendientes(estado).filter(function (t) {
      var d = new Date(t.entrega);
      return !isNaN(d) && d <= limite;
    });
    $('#lista-entregas').innerHTML = entregas.length
      ? entregas.map(itemTarea).join('')
      : '<div class="vacio">Sin entregas en los próximos 14 días.</div>';
  }

  function tarjetaGrande(etiqueta, c, extra) {
    var liga = c.url ? '<div class="cuenta"><a href="' + esc(c.url) + '" target="_blank" rel="noopener">Abrir ' + esc(c.plataforma || 'la clase') + ' →</a></div>' : '';
    return '<div class="etiqueta">' + esc(etiqueta) + '</div>' +
      '<div class="materia">' + esc(c.materia) + '</div>' +
      '<div class="detalle">' + esc(detalleClase(c)) + '</div>' +
      '<div class="cuenta">' + esc(extra) + '</div>' + liga;
  }

  function detalleClase(c) {
    var p = [];
    var donde = E.lugar(c);
    if (donde) p.push(donde);
    if (c.plataforma) p.push(c.plataforma);
    if (c.profesor) p.push(c.profesor);
    p.push(c.inicio + '–' + c.fin);
    return p.join(' · ');
  }

  function faltanTexto(ms) {
    var min = Math.round(ms / 60000);
    if (min < 1) return 'Empieza ya';
    if (min < 60) return 'En ' + min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return 'En ' + h + ' h' + (m ? ' ' + m + ' min' : '');

    var dias = Math.round(h / 24);
    return 'En ' + dias + (dias === 1 ? ' día' : ' días');
  }

  function pintarHorario() {
    var porDia = {};
    estado.clases.forEach(function (c) { (porDia[c.dia] = porDia[c.dia] || []).push(c); });
    var orden = [1, 2, 3, 4, 5, 6, 0];
    var html = orden.filter(function (d) { return porDia[d]; }).map(function (d) {
      var clases = porDia[d].sort(function (a, b) { return E.minutesOf(a.inicio) - E.minutesOf(b.inicio); });
      return '<h2>' + E.DIAS[d] + '</h2><div class="lista">' + clases.map(function (c) {
        return '<button class="item" data-clase="' + c.id + '">' +
          '<span class="hora">' + esc(c.inicio) + '</span>' +
          '<span class="cuerpo"><span class="titulo">' + esc(c.materia) + '</span>' +
          '<span class="sub">' + esc(detalleClase(c)) + '</span></span></button>';
      }).join('') + '</div>';
    }).join('');
    $('#lista-horario').innerHTML = html || '<div class="vacio">Todavía no hay clases. Toca «+ Clase».</div>';
  }

  function pintarTareas() {
    var lista = estado.tareas.slice().sort(function (a, b) { return new Date(a.entrega) - new Date(b.entrega); });
    if (filtroTareas === 'pendientes') lista = lista.filter(function (t) { return !t.hecha; });
    if (filtroTareas === 'hechas') lista = lista.filter(function (t) { return t.hecha; });
    $('#lista-tareas').innerHTML = lista.length
      ? lista.map(itemTarea).join('')
      : '<div class="vacio">Nada por aquí.</div>';
  }

  function itemTarea(t) {
    var d = new Date(t.entrega);
    var restan = d - new Date();
    var urgente = !t.hecha && restan < 24 * 3600000;
    var cuando = isNaN(d) ? 'Sin fecha'
      : (restan < 0 ? 'Venció ' + E.formatoFecha(d) : E.formatoFecha(d) + ' · ' + faltanTexto(restan));
    var sub = [E.nombreMateria(estado, t), t.plataforma, cuando].filter(Boolean).join(' · ');
    return '<div class="item ' + (t.hecha ? 'hecha' : '') + ' ' + (urgente ? 'urgente' : '') + '">' +
      '<button class="marca" data-marcar="' + t.id + '" aria-pressed="' + (t.hecha ? 'true' : 'false') +
      '" aria-label="Marcar como entregada">' + (t.hecha ? '✓' : '') + '</button>' +
      '<span class="cuerpo" data-tarea="' + t.id + '" role="button" tabindex="0">' +
      '<span class="titulo">' + esc(t.titulo) + '</span>' +
      '<span class="sub">' + esc(sub) + '</span></span></div>';
  }

  function llenarSelectMaterias() {
    var sel = $('#select-materia');
    var actual = sel.value;
    sel.innerHTML = '<option value="">— Sin materia —</option>' +
      estado.clases
        .filter(function (c, i, arr) { return arr.findIndex(function (x) { return x.materia === c.materia; }) === i; })
        .map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.materia) + '</option>'; })
        .join('');
    sel.value = actual;
  }

  function pintarEstadoSync(r) {
    var t = 'Todo se guarda en este dispositivo.';
    if (estado.outbox.length) t = estado.outbox.length + ' cambio(s) esperando conexión.';
    if (estado.ajustes.ultimaSync) t += ' Última sincronización: ' + E.formatoFecha(new Date(estado.ajustes.ultimaSync)) + '.';
    if (r && r.estado === 'error') t += ' Último error: ' + r.error;
    $('#estado-sync').textContent = t;
    pintarRed();
  }

  function pintarPermiso() {
    var p = ('Notification' in window) ? Notification.permission : 'unsupported';
    var txt = {
      granted: 'Notificaciones activadas.',
      denied: 'Están bloqueadas. Actívalas en Chrome: candado ⋮ → Permisos → Notificaciones.',
      default: 'Aún no están activadas.',
      unsupported: 'Este navegador no soporta notificaciones.'
    }[p];
    $('#estado-permiso').textContent = txt;
    $('#btn-permiso').hidden = (p === 'granted' || p === 'unsupported');
  }

  /* ------------------------------------------------------------------- alertas */

  function revisarAlertas() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!registro && navigator.serviceWorker) {
      return navigator.serviceWorker.ready.then(function (reg) { registro = reg; return disparar(reg); });
    }
    if (registro) return disparar(registro);
  }

  function disparar(reg) {
    return E.dispararAlertas(reg, new Date()).then(function (n) {
      if (n) return E.loadState().then(function (s) { estado.avisados = s.avisados; });
    }).catch(function (e) { console.warn('alertas', e); });
  }

  /* ----------------------------------------------------------------------- voz */

  function resumenHablado() {
    var ahora = new Date();
    var partes = [];
    var enCurso = E.claseEnCurso(estado, ahora);
    var prox = E.proximasClases(estado, ahora, 1)[0];

    if (enCurso) {
      partes.push('Ahora tienes ' + enCurso.materia + dondeHablado(enCurso) +
        ', hasta las ' + enHoras(enCurso.fin) + '.');
    } else if (prox) {
      var mismoDia = prox.inicio.toDateString() === ahora.toDateString();
      partes.push('Tu siguiente clase es ' + prox.clase.materia +
        (mismoDia ? ' hoy' : ' el ' + E.DIAS[prox.inicio.getDay()]) +
        ' a las ' + enHoras(prox.clase.inicio) +
        dondeHablado(prox.clase) +
        (prox.clase.plataforma ? ', por ' + prox.clase.plataforma : '') + '.');
    } else {
      partes.push('No tienes clases registradas.');
    }

    var pendientes = E.tareasPendientes(estado).filter(function (t) { return !isNaN(new Date(t.entrega)); });
    var vencidas = pendientes.filter(function (t) { return new Date(t.entrega) < ahora; });
    var limite = new Date(ahora.getTime() + 7 * 86400000);
    var semana = pendientes.filter(function (t) {
      var d = new Date(t.entrega);
      return d >= ahora && d <= limite;
    });

    if (vencidas.length) {
      partes.push('Tienes ' + vencidas.length + ' tarea' + (vencidas.length > 1 ? 's vencidas' : ' vencida') + '.');
    }
    if (!semana.length) {
      partes.push(vencidas.length ? 'Nada más para esta semana.' : 'No tienes entregas en los próximos siete días.');
    } else {
      partes.push('Tienes ' + semana.length + ' entrega' + (semana.length > 1 ? 's' : '') + ' esta semana.');
      semana.slice(0, 3).forEach(function (t) {
        var d = new Date(t.entrega);
        var materia = E.nombreMateria(estado, t);
        partes.push(t.titulo + (materia ? ' de ' + materia : '') +
          ', ' + cuandoHablado(d, ahora) + ' a las ' + enHoras(pad(d.getHours()) + ':' + pad(d.getMinutes())) +
          (t.plataforma ? ', por ' + t.plataforma : '') + '.');
      });
      if (semana.length > 3) partes.push('Y ' + (semana.length - 3) + ' más en la lista.');
    }
    return partes.join(' ');
  }

  function dondeHablado(c) {
    if (!c.salon) return c.edificio ? ', en el edificio ' + c.edificio : '';
    return ', en el salón ' + c.salon + (c.edificio ? ' del edificio ' + c.edificio : '');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function cuandoHablado(d, ahora) {
    var hoy = new Date(ahora); hoy.setHours(0, 0, 0, 0);
    var dias = Math.round((new Date(d).setHours(0, 0, 0, 0) - hoy) / 86400000);
    if (dias === 0) return 'hoy';
    if (dias === 1) return 'mañana';
    return 'el ' + E.DIAS[d.getDay()];
  }

  /** «07:05» se lee mejor como «7 horas con 5 minutos» que como «7:05». */
  function enHoras(hhmm) {
    var p = String(hhmm).split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10) || 0;
    if (!m) return h + ' en punto';
    if (m === 30) return h + ' y media';
    if (m === 15) return h + ' y cuarto';
    return h + ' con ' + (m === 1 ? 'un minuto' : m + ' minutos');
  }

  function hablar(texto) {
    if (!('speechSynthesis' in window) || !texto) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(texto);
      u.lang = 'es-MX';
      u.rate = Number(estado.ajustes.vozVelocidad) || 1;
      var voz = elegirVoz();
      if (voz) u.voice = voz;
      u.onerror = function () { vozPendiente = texto; };
      speechSynthesis.speak(u);
      // Chrome ignora speak() hasta que el usuario interactúa con la página.
      setTimeout(function () {
        if (!speechSynthesis.speaking && !speechSynthesis.pending) vozPendiente = texto;
      }, 400);
    } catch (e) { vozPendiente = texto; }
  }

  function elegirVoz() {
    var voces = speechSynthesis.getVoices() || [];
    var guardada = estado.ajustes.vozNombre;
    if (guardada) {
      var v = voces.filter(function (x) { return x.name === guardada; })[0];
      if (v) return v;
    }
    return voces.filter(function (x) { return /^es/i.test(x.lang); })[0] || null;
  }

  function llenarVoces() {
    if (!('speechSynthesis' in window)) return;
    var sel = $('#voz-elegida');
    var voces = (speechSynthesis.getVoices() || []).filter(function (v) { return /^es/i.test(v.lang); });
    sel.innerHTML = '<option value="">Predeterminada del sistema</option>' +
      voces.map(function (v) { return '<option value="' + esc(v.name) + '">' + esc(v.name + ' (' + v.lang + ')') + '</option>'; }).join('');
    sel.value = estado.ajustes.vozNombre || '';
  }

  // Si Chrome bloqueó la voz por falta de interacción, la soltamos con el primer toque.
  document.addEventListener('pointerdown', function () {
    if (vozPendiente) { var t = vozPendiente; vozPendiente = null; hablar(t); }
  }, { capture: true });

  /* ------------------------------------------------------------------ eventos */

  function conectarUI() {
    // Navegación
    $$('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.tab').forEach(function (x) { x.classList.remove('activa'); });
        $$('.vista').forEach(function (x) { x.classList.remove('activa'); });
        b.classList.add('activa');
        $('#vista-' + b.dataset.vista).classList.add('activa');
        window.scrollTo(0, 0);
      });
    });

    $$('.filtro').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.filtro').forEach(function (x) { x.classList.remove('activo'); });
        b.classList.add('activo');
        filtroTareas = b.dataset.filtro;
        pintarTareas();
      });
    });

    // Abrir formularios
    $$('[data-nueva-clase]').forEach(function (b) { b.addEventListener('click', function () { abrirClase(null); }); });
    $$('[data-nueva-tarea]').forEach(function (b) { b.addEventListener('click', function () { abrirTarea(null); }); });

    document.addEventListener('click', function (ev) {
      var elClase = ev.target.closest('[data-clase]');
      if (elClase) return abrirClase(elClase.dataset.clase);
      var marcar = ev.target.closest('[data-marcar]');
      if (marcar) return alternarTarea(marcar.dataset.marcar);
      var elTarea = ev.target.closest('[data-tarea]');
      if (elTarea) return abrirTarea(elTarea.dataset.tarea);
    });

    $('#form-clase').addEventListener('submit', function (ev) { guardarClase(ev.submitter && ev.submitter.value); });
    $('#form-tarea').addEventListener('submit', function (ev) { guardarTarea(ev.submitter && ev.submitter.value); });
    $('#borrar-clase').addEventListener('click', borrarClase);
    $('#borrar-tarea').addEventListener('click', borrarTarea);

    // Ajustes
    $('#btn-permiso').addEventListener('click', function () {
      Notification.requestPermission().then(function () { pintarPermiso(); revisarAlertas(); });
    });
    $('#btn-probar').addEventListener('click', function () {
      if (Notification.permission !== 'granted') return aviso('Primero activa las notificaciones');
      navigator.serviceWorker.ready.then(function (reg) {
        reg.showNotification('Así se verán tus avisos', {
          body: 'Clase, salón y plataforma; y las entregas antes de que se venzan.',
          icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'prueba'
        });
      });
    });
    $('#aviso-clase').addEventListener('change', function (e) {
      estado.ajustes.avisoClaseMin = Number(e.target.value);
      E.saveState(estado).then(function () { aviso('Guardado'); });
    });
    $('#aviso-tareas').addEventListener('change', function (e) {
      estado.ajustes.avisosTareaMin = e.target.value.split(',').map(Number);
      E.saveState(estado).then(function () { aviso('Guardado'); });
    });

    $('#voz-al-abrir').addEventListener('change', function (e) {
      estado.ajustes.vozAlAbrir = e.target.checked;
      E.saveState(estado);
      if (e.target.checked) hablar(resumenHablado());
    });
    $('#voz-velocidad').addEventListener('change', function (e) {
      estado.ajustes.vozVelocidad = Number(e.target.value);
      E.saveState(estado);
    });
    $('#voz-elegida').addEventListener('change', function (e) {
      estado.ajustes.vozNombre = e.target.value;
      E.saveState(estado);
    });
    $('#btn-leer').addEventListener('click', function () { hablar(resumenHablado()); });
    $('#btn-voz').addEventListener('click', function () {
      if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
      hablar(resumenHablado());
    });

    $('#sync-url').addEventListener('change', function (e) {
      estado.ajustes.syncUrl = e.target.value.trim();
      E.saveState(estado).then(function () { pintarEstadoSync(); aviso('Servidor guardado'); });
    });
    $('#btn-sync').addEventListener('click', function () { sincronizar(false); });

    $('#btn-exportar').addEventListener('click', exportar);
    $('#btn-importar').addEventListener('click', function () { $('#archivo-importar').click(); });
    $('#archivo-importar').addEventListener('change', importar);
    $('#btn-horario-escuela').addEventListener('click', cargarHorario);

    if ('speechSynthesis' in window) {
      llenarVoces();
      speechSynthesis.onvoiceschanged = llenarVoces;
    }
    $('#pie-version').textContent = 'Mi Escuela · funciona sin internet';
  }

  /** Los accesos directos del ícono (#tareas, #horario) abren esa pestaña. */
  function abrirVistaDeHash() {
    var vista = (location.hash || '').replace('#', '');
    var tab = document.querySelector('.tab[data-vista="' + vista + '"]');
    if (tab) tab.click();
  }

  function aplicarAjustesEnFormulario() {
    $('#aviso-clase').value = String(estado.ajustes.avisoClaseMin);
    var v = (estado.ajustes.avisosTareaMin || []).join(',');
    var sel = $('#aviso-tareas');
    if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) {
      sel.insertAdjacentHTML('beforeend', '<option value="' + esc(v) + '">Personalizado</option>');
    }
    sel.value = v;
    $('#voz-al-abrir').checked = !!estado.ajustes.vozAlAbrir;
    $('#voz-velocidad').value = estado.ajustes.vozVelocidad || 1;
    $('#sync-url').value = estado.ajustes.syncUrl || '';
    pintarEstadoSync();
  }

  /* ------------------------------------------------------------------- clases */

  function abrirClase(id) {
    var f = $('#form-clase');
    var c = id ? estado.clases.filter(function (x) { return x.id === id; })[0] : null;
    f.reset();
    $('#titulo-clase').textContent = c ? 'Editar clase' : 'Nueva clase';
    $('#borrar-clase').hidden = !c;
    f.id.value = c ? c.id : '';
    if (c) {
      ['materia', 'clave', 'grupo', 'profesor', 'edificio', 'salon', 'plataforma', 'url', 'inicio', 'fin']
        .forEach(function (k) { f[k].value = c[k] || ''; });
      f.dia.value = String(c.dia);
    } else {
      f.dia.value = String(new Date().getDay() || 1);
    }
    $('#dialogo-clase').showModal();
  }

  function guardarClase(accion) {
    if (accion !== 'guardar') return;
    var f = $('#form-clase');
    var datos = {
      id: f.id.value || E.uid(),
      materia: f.materia.value.trim(),
      clave: f.clave.value.trim(),
      grupo: f.grupo.value.trim(),
      profesor: f.profesor.value.trim(),
      edificio: f.edificio.value.trim(),
      salon: f.salon.value.trim(),
      plataforma: f.plataforma.value.trim(),
      url: f.url.value.trim(),
      dia: Number(f.dia.value),
      inicio: f.inicio.value,
      fin: f.fin.value
    };
    if (E.minutesOf(datos.fin) <= E.minutesOf(datos.inicio)) {
      aviso('La hora de fin debe ser después del inicio');
      return abrirClase(f.id.value || null);
    }
    var i = estado.clases.findIndex(function (x) { return x.id === datos.id; });
    if (i >= 0) estado.clases[i] = datos; else estado.clases.push(datos);
    guardar('clase', i >= 0 ? 'editar' : 'crear', datos).then(function () { aviso('Clase guardada'); });
  }

  function borrarClase() {
    var id = $('#form-clase').id.value;
    if (!id || !confirm('¿Borrar esta clase del horario?')) return;
    estado.clases = estado.clases.filter(function (x) { return x.id !== id; });
    $('#dialogo-clase').close();
    guardar('clase', 'borrar', { id: id }).then(function () { aviso('Clase borrada'); });
  }

  /* ------------------------------------------------------------------- tareas */

  function abrirTarea(id) {
    llenarSelectMaterias();
    var f = $('#form-tarea');
    var t = id ? estado.tareas.filter(function (x) { return x.id === id; })[0] : null;
    f.reset();
    $('#titulo-tarea').textContent = t ? 'Editar tarea' : 'Nueva tarea';
    $('#borrar-tarea').hidden = !t;
    f.id.value = t ? t.id : '';
    if (t) {
      f.titulo.value = t.titulo || '';
      f.claseId.value = t.claseId || '';
      f.entrega.value = paraInput(t.entrega);
      f.plataforma.value = t.plataforma || '';
      f.url.value = t.url || '';
      f.notas.value = t.notas || '';
    } else {
      var d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(23, 59, 0, 0);
      f.entrega.value = paraInput(d);
    }
    $('#dialogo-tarea').showModal();
  }

  function guardarTarea(accion) {
    if (accion !== 'guardar') return;
    var f = $('#form-tarea');
    var previa = estado.tareas.filter(function (x) { return x.id === f.id.value; })[0];
    var datos = {
      id: f.id.value || E.uid(),
      titulo: f.titulo.value.trim(),
      claseId: f.claseId.value,
      materia: f.claseId.value ? '' : (previa ? previa.materia : ''),
      entrega: new Date(f.entrega.value).toISOString(),
      plataforma: f.plataforma.value.trim(),
      url: f.url.value.trim(),
      notas: f.notas.value.trim(),
      hecha: previa ? !!previa.hecha : false
    };
    var i = estado.tareas.findIndex(function (x) { return x.id === datos.id; });
    if (i >= 0) estado.tareas[i] = datos; else estado.tareas.push(datos);
    guardar('tarea', i >= 0 ? 'editar' : 'crear', datos).then(function () { aviso('Tarea guardada'); });
  }

  function alternarTarea(id) {
    var t = estado.tareas.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    t.hecha = !t.hecha;
    guardar('tarea', 'editar', t).then(function () { aviso(t.hecha ? 'Marcada como entregada' : 'Marcada como pendiente'); });
  }

  function borrarTarea() {
    var id = $('#form-tarea').id.value;
    if (!id || !confirm('¿Borrar esta tarea?')) return;
    estado.tareas = estado.tareas.filter(function (x) { return x.id !== id; });
    $('#dialogo-tarea').close();
    guardar('tarea', 'borrar', { id: id }).then(function () { aviso('Tarea borrada'); });
  }

  function paraInput(valor) {
    var d = new Date(valor);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------------------------------------------------------------- respaldos */

  function exportar() {
    var datos = JSON.stringify({ clases: estado.clases, tareas: estado.tareas, ajustes: estado.ajustes }, null, 2);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([datos], { type: 'application/json' }));
    a.download = 'mi-escuela-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function importar(ev) {
    var file = ev.target.files[0];
    if (!file) return;
    file.text().then(function (txt) {
      var d = JSON.parse(txt);
      if (!confirm('Esto reemplaza tus clases y tareas actuales. ¿Continuar?')) return;
      estado.clases = d.clases || [];
      estado.tareas = d.tareas || [];
      if (d.ajustes) estado.ajustes = Object.assign(estado.ajustes, d.ajustes);
      guardar('todo', 'importar', { clases: estado.clases.length, tareas: estado.tareas.length })
        .then(function () { aplicarAjustesEnFormulario(); aviso('Datos importados'); });
    }).catch(function () { aviso('El archivo no es válido'); });
    ev.target.value = '';
  }

  /** Carga el horario transcrito de la escuela (datos/horario.json). */
  function cargarHorario() {
    if (estado.clases.length && !confirm('Esto reemplaza las clases que ya tienes. ¿Continuar?')) return;
    fetch('datos/horario.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      estado.clases = [];
      (d.clases || []).forEach(function (m) {
        (m.sesiones || []).forEach(function (ses) {
          estado.clases.push({
            id: E.uid(),
            materia: m.materia,
            clave: m.clave || '',
            grupo: m.grupo || '',
            profesor: m.profesor || '',
            edificio: ses.edificio || m.edificio || '',
            salon: ses.salon || m.salon || '',
            plataforma: m.plataforma || '',
            url: m.url || '',
            dia: Number(ses.dia),
            inicio: ses.inicio,
            fin: ses.fin
          });
        });
      });
      return guardar('todo', 'importar-horario', { clases: estado.clases.length });
    }).then(function () {
      aviso('Horario cargado');
    }).catch(function (e) {
      aviso('No se pudo cargar el horario: ' + e.message);
    });
  }

  /* ------------------------------------------------------------------ utilidad */

  var timerAviso = null;
  function aviso(texto) {
    var el = $('#aviso');
    el.textContent = texto;
    el.hidden = false;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
