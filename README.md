# Mi Escuela

App de horario y tareas para usar en el navegador y como app en Android (Chrome).
Funciona sin internet: todo se guarda en el teléfono y los cambios hechos offline
se envían solos cuando vuelve la conexión.

## Qué hace

- **Hoy**: la clase que sigue (o la que está en curso) con salón, plataforma y hora,
  las clases del día y las entregas de los próximos 14 días.
- **Horario**: clases por día con materia, profesor, salón, plataforma y liga.
- **Tareas**: qué se entrega, cuándo, en qué plataforma y con qué liga; se marcan como entregadas.
- **Notificaciones**: aviso antes de cada clase (configurable: 0 a 60 min) y avisos de
  entregas (por defecto 1 día y 2 horas antes). Al tocar el aviso se abre la liga de la clase o la tarea.
- **Voz**: al abrir la app te lee el resumen (clase que sigue y tareas pendientes).
  Se activa en Ajustes → Voz, y también con el botón 🔊 de la barra.
- **Copia de seguridad**: exportar/importar un archivo JSON.
- **Tu horario ya cargado**: Ajustes → *Cargar mi horario* mete las 8 materias de
  `datos/horario.json` (materia, clave, grupo, profesor, edificio y salón por sesión).

## Instalarla en el teléfono

1. Abre la dirección de la app en **Chrome** en Android.
2. Menú ⋮ → **Añadir a pantalla de inicio** / **Instalar app**.
3. Ábrela desde el ícono y en Ajustes toca **Activar notificaciones**.

Ya instalada funciona sin internet, incluso al reiniciar el teléfono.

## Cómo llegan los avisos

- Con la app abierta: se revisa cada 30 segundos.
- Con la app cerrada: Chrome despierta al service worker cada cierto tiempo
  (Periodic Background Sync, mínimo 15 minutos) y muestra lo que toque.
  Chrome decide la frecuencia real según qué tanto uses la app y la batería;
  por eso conviene **instalarla** y no solo abrirla en una pestaña.
- Si quieres avisos exactos al minuto aunque no abras la app en días, hace falta
  un servidor con Web Push (VAPID). La app está lista para agregarlo después:
  el service worker ya maneja `notificationclick` y la sincronización.

## Publicarla

Está pensada para archivos estáticos servidos por HTTPS (requisito del service worker).

- **GitHub Pages** (ya configurado): el workflow `.github/workflows/pages.yml` publica
  este repo en cada push a `main`. Hay que activar una vez
  *Settings → Pages → Source: GitHub Actions*.
- **Local para probar**: `npx http-server . -p 8080` y abre `http://localhost:8080`.

La app queda en `https://gaa211225.github.io/mi-escuela/`.

## Sincronizar entre dispositivos (opcional)

Por defecto no hay servidor: los datos viven en el teléfono (IndexedDB) y nada sale de ahí.
Si pones una URL en *Ajustes → Sincronizar*, la app manda un `POST` con este cuerpo cada vez
que hay cambios y hay conexión:

```json
{
  "dispositivo": "id-del-dispositivo",
  "actualizado": 1730000000000,
  "cambios": [{ "id": "...", "ts": 1730000000000, "entidad": "tarea", "op": "crear", "datos": {} }],
  "snapshot": { "clases": [], "tareas": [] }
}
```

Mientras no haya conexión los cambios se acumulan en una cola (se ve en la barra:
«3 por enviar») y se reintentan al volver el internet, incluso con la app cerrada
(Background Sync). El servidor solo necesita responder `200`.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html` | Estructura de las cuatro pestañas y los formularios |
| `css/estilos.css` | Estilos, tema claro/oscuro automático |
| `js/core.js` | Datos (IndexedDB), cálculo de próximas clases, alertas y cola de sincronización. Lo comparten la página y el service worker |
| `js/app.js` | Interfaz, formularios, voz |
| `sw.js` | Caché offline, avisos en segundo plano, reenvío de cambios |
| `datos/horario.json` | El horario transcrito; edítalo cuando cambien materias o salones |
| `manifest.webmanifest` | Para instalarla como app |
