#!/usr/bin/env node
// API mínima de fiestas compartidas para A Pachas. Un JSON por fiesta,
// control de revisión optimista y cero dependencias (solo stdlib de Node).
//
//   POST /api/fiestas            {estado}              -> 201 {id, clave, rev}
//   GET  /api/fiestas/:id[?rev=] -> 200 {rev, estado, updatedAt} | 204 (sin cambios)
//   PUT  /api/fiestas/:id        {clave, rev, estado}  -> 200 {rev, updatedAt}
//                                   | 409 {rev, estado} | 403 | 404 | 413
//   GET  /api/salud              -> 200
//
// En local (`node server/api.js`) sirve también public/ para probar la app
// entera en http://localhost:8010; en producción nginx sirve lo estático y
// solo pasa /api/ aquí. Ver docs/despliegue.md.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUERTO = Number(process.env.PUERTO || 8010);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'public');

const MAX_BODY = 256 * 1024;          // una fiesta grande son ~30 KB; esto sobra
const CADUCIDAD_MS = 240 * 24 * 3600 * 1000; // fiestas sin tocar 8 meses se purgan
// Cupo en puntos por IP y minuto: leer vale 1, escribir 5. Toda la peña suele
// compartir la IP del WiFi del pueblo, así que tiene que dar para ~30 móviles
// sondeando cada 12 s (~150 puntos/min) con margen de sobra.
const RATE_MAX = 600;
const MAX_FIESTAS = 5000;             // freno a bots minando fiestas en disco
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789'; // sin i/l/o/0/1
const ID_RE = new RegExp(`^[${ALFABETO}]{10}$`);

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- utilidades ---------- */

function aleatorio(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return s;
}

function fichero(id) {
  return path.join(DATA_DIR, id + '.json');
}

function leerFiesta(id) {
  try {
    return JSON.parse(fs.readFileSync(fichero(id), 'utf8'));
  } catch (e) {
    return null;
  }
}

function guardarFiesta(id, doc) {
  const tmp = fichero(id) + '.tmp-' + aleatorio(6);
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, fichero(id));
}

function json(res, codigo, cuerpo) {
  const s = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let pasado = false;
    const trozos = [];
    req.on('data', (t) => {
      total += t.length;
      // se sigue drenando sin guardar: destruir el socket dejaría al
      // cliente con un reset en vez del 413
      if (total > MAX_BODY) {
        pasado = true;
        trozos.length = 0;
        return;
      }
      trozos.push(t);
    });
    req.on('end', () => {
      if (pasado) reject(new Error('grande'));
      else resolve(Buffer.concat(trozos).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// El estado compartido de una fiesta, sin campos locales del cliente y con
// la forma verificada a fondo. Devuelve null si aquello no parece una fiesta.
// Los ids se validan estrictos porque el cliente los interpola en atributos
// del DOM: un id con comillas sería una inyección servida a toda la peña.
const ID_ENT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const idValido = (x) => typeof x === 'string' && ID_ENT_RE.test(x);
const numOpc = (x) => x == null || (typeof x === 'number' && isFinite(x));
const idOpc = (x) => x == null || idValido(x);
const ESTADOS_ITEM = ['pendiente', 'pillada', 'comprada'];

function estadoValido(estado) {
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) return null;
  const f = estado.fiesta;
  if (!f || typeof f !== 'object' || typeof f.nombre !== 'string' ||
      !f.nombre.trim() || f.nombre.length > 80) return null;
  // la fecha se interpola en un value="..." del cliente: AAAA-MM-DD o nada
  if (f.fecha != null && f.fecha !== '' &&
      !(typeof f.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.fecha))) return null;
  if (!numOpc(f.mod)) return null;

  if (!Array.isArray(estado.gente) || estado.gente.length > 100) return null;
  for (const p of estado.gente) {
    if (!p || typeof p !== 'object' || !idValido(p.id)) return null;
    if (typeof p.nombre !== 'string' || !p.nombre.trim() || p.nombre.length > 40) return null;
    if (!numOpc(p.mod)) return null;
  }

  if (!Array.isArray(estado.items) || estado.items.length > 500) return null;
  for (const it of estado.items) {
    if (!it || typeof it !== 'object' || !idValido(it.id)) return null;
    if (typeof it.nombre !== 'string' || !it.nombre.trim() || it.nombre.length > 80) return null;
    if (!ESTADOS_ITEM.includes(it.estado)) return null;
    if (it.precio != null &&
        !(Number.isInteger(it.precio) && it.precio >= 0 && it.precio <= 100000000)) return null;
    if (!idOpc(it.compradorId) || !idOpc(it.pilladorId) ||
        !idOpc(it.creadoPor) || !idOpc(it.modPor)) return null;
    if (it.consumen != null && (!Array.isArray(it.consumen) ||
        it.consumen.length > 100 || !it.consumen.every(idValido))) return null;
    if (!numOpc(it.mod) || !numOpc(it.creadoEn)) return null;
  }

  if (estado.saldados != null) {
    if (typeof estado.saldados !== 'object' || Array.isArray(estado.saldados)) return null;
    const claves = Object.keys(estado.saldados);
    if (claves.length > 500) return null;
    for (const k of claves) {
      const partes = k.split('>');
      if (partes.length !== 2 || !idValido(partes[0]) || !idValido(partes[1])) return null;
      const v = estado.saldados[k];
      if (v !== true && !(v && typeof v === 'object' && !Array.isArray(v) &&
          idOpc(v.por) && numOpc(v.t))) return null;
    }
  }

  if (estado.papelera != null) {
    if (!Array.isArray(estado.papelera) || estado.papelera.length > 500) return null;
    for (const l of estado.papelera) {
      if (!l || typeof l !== 'object' || !idValido(l.id) || !numOpc(l.t)) return null;
    }
  }

  const limpio = { ...estado };
  delete limpio.yo;
  delete limpio.tab;
  delete limpio.remota;
  return limpio;
}

/* ---------- rate limit por IP, best effort ---------- */

const cupos = new Map();
function pasaCupo(req) {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    req.socket.remoteAddress || '?';
  const ahora = Date.now();
  let c = cupos.get(ip);
  if (!c || ahora > c.hasta) {
    c = { n: 0, hasta: ahora + 60000 };
    cupos.set(ip, c);
  }
  c.n += (req.method === 'GET' || req.method === 'HEAD') ? 1 : 5;
  if (cupos.size > 5000) {
    // primero fuera lo caducado; solo si sigue desbordado se vacía todo
    for (const [k, v] of cupos) if (ahora > v.hasta) cupos.delete(k);
    if (cupos.size > 5000) cupos.clear();
  }
  return c.n <= RATE_MAX;
}

/* ---------- purga de fiestas abandonadas ---------- */

// cuántas fiestas hay en disco, contadas perezosamente (la purga y los POST
// mantienen la cifra; MAX_FIESTAS la usa para frenar a bots)
let fiestasCache = null;
function numFiestas() {
  if (fiestasCache === null) {
    try {
      fiestasCache = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).length;
    } catch (e) { fiestasCache = 0; }
  }
  return fiestasCache;
}

function purgar() {
  let borradas = 0;
  try {
    const limite = Date.now() - CADUCIDAD_MS;
    for (const f of fs.readdirSync(DATA_DIR)) {
      const ruta = path.join(DATA_DIR, f);
      try {
        const st = fs.statSync(ruta);
        // los .tmp huérfanos de más de un día también sobran
        const esTmp = f.includes('.tmp-');
        if ((f.endsWith('.json') && st.mtimeMs < limite) ||
            (esTmp && st.mtimeMs < Date.now() - 24 * 3600 * 1000)) {
          fs.unlinkSync(ruta);
          borradas++;
        }
      } catch (e) { /* carrera con otra purga: da igual */ }
    }
  } catch (e) { /* sin data dir aún */ }
  fiestasCache = null; // recontar a la próxima
  if (borradas) console.log(`purga: ${borradas} fiesta(s) caducada(s)`);
}
// la primera purga espera a que el server esté sirviendo: con muchos ficheros
// un barrido síncrono antes de listen() retrasaría el arranque
setTimeout(purgar, 5000).unref();
setInterval(purgar, 12 * 3600 * 1000).unref();

/* ---------- API ---------- */

async function api(req, res, url) {
  if (!pasaCupo(req)) return json(res, 429, { error: 'Frena un poco, máquina.' });

  if (req.method === 'GET' && url.pathname === '/api/salud') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/fiestas') {
    if (numFiestas() >= MAX_FIESTAS) {
      return json(res, 503, { error: 'El servidor está hasta arriba de fiestas' });
    }
    let cuerpo;
    try { cuerpo = JSON.parse(await leerCuerpo(req)); }
    catch (e) {
      if (e.message === 'grande') throw e; // el catch de fuera responde 413
      return json(res, 400, { error: 'Cuerpo inválido' });
    }
    const estado = estadoValido(cuerpo && cuerpo.estado);
    if (!estado) return json(res, 400, { error: 'Eso no es una fiesta' });
    const id = aleatorio(10);
    const clave = aleatorio(14);
    const doc = { clave, rev: 1, updatedAt: new Date().toISOString(), estado };
    guardarFiesta(id, doc);
    fiestasCache = fiestasCache === null ? null : fiestasCache + 1;
    return json(res, 201, { id, clave, rev: 1 });
  }

  const m = url.pathname.match(/^\/api\/fiestas\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return json(res, 404, { error: 'No hay tal fiesta' });

    if (req.method === 'GET') {
      const doc = leerFiesta(id);
      if (!doc) return json(res, 404, { error: 'No hay tal fiesta' });
      // 204 y no 304: fetch trata mejor un "no hay cambios" explícito
      if (url.searchParams.get('rev') === String(doc.rev)) return json(res, 204);
      return json(res, 200, { rev: doc.rev, estado: doc.estado, updatedAt: doc.updatedAt });
    }

    if (req.method === 'PUT') {
      let cuerpo;
      try { cuerpo = JSON.parse(await leerCuerpo(req)); }
      catch (e) {
        if (e.message === 'grande') throw e; // el catch de fuera responde 413
        return json(res, 400, { error: 'Cuerpo inválido' });
      }
      const doc = leerFiesta(id);
      if (!doc) return json(res, 404, { error: 'No hay tal fiesta' });
      if (!cuerpo || cuerpo.clave !== doc.clave) return json(res, 403, { error: 'Ese enlace no puede editar' });
      const estado = estadoValido(cuerpo.estado);
      if (!estado) return json(res, 400, { error: 'Eso no es una fiesta' });
      if (Number(cuerpo.rev) !== doc.rev) {
        return json(res, 409, { rev: doc.rev, estado: doc.estado });
      }
      doc.rev++;
      doc.updatedAt = new Date().toISOString();
      doc.estado = estado;
      guardarFiesta(id, doc);
      return json(res, 200, { rev: doc.rev, updatedAt: doc.updatedAt });
    }
  }

  return json(res, 404, { error: 'No hay nada por aquí' });
}

/* ---------- estático (solo desarrollo local) ---------- */

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function estatico(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'Solo lectura por aquí' });
  }
  let ruta = decodeURIComponent(url.pathname);
  if (ruta === '/' || ruta === '') ruta = '/index.html';
  const destino = path.resolve(STATIC_DIR, '.' + ruta);
  if (!destino.startsWith(path.resolve(STATIC_DIR) + path.sep) &&
      destino !== path.resolve(STATIC_DIR)) {
    return json(res, 404, { error: 'No' });
  }
  let datos;
  try { datos = fs.readFileSync(destino); }
  catch (e) { return json(res, 404, { error: 'No existe' }); }
  res.writeHead(200, {
    'Content-Type': TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : datos);
}

/* ---------- servidor ---------- */

const hayEstatico = fs.existsSync(path.join(STATIC_DIR, 'index.html'));

const servidor = http.createServer(async (req, res) => {
  const inicio = Date.now();
  const url = new URL(req.url, 'http://local');
  res.on('finish', () => {
    // el id de fiesta no se loguea: con él solo ya se puede leer la fiesta
    const ruta = url.pathname.replace(/^(\/api\/fiestas\/)[^/]+/, '$1***');
    console.log(`${req.method} ${ruta} ${res.statusCode} ${Date.now() - inicio}ms`);
  });
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await api(req, res, url);
    } else if (hayEstatico) {
      estatico(req, res, url);
    } else {
      json(res, 404, { error: 'No hay nada por aquí' });
    }
  } catch (e) {
    if (!res.headersSent) json(res, e.message === 'grande' ? 413 : 500, { error: 'Se ha torcido algo' });
  }
});

servidor.listen(PUERTO, () => {
  console.log(`A Pachas API en http://localhost:${PUERTO} (datos en ${DATA_DIR}${hayEstatico ? `, estático desde ${STATIC_DIR}` : ''})`);
});
