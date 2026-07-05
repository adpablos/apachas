#!/usr/bin/env node
// API mínima de fiestas compartidas para A Pachas. Un JSON por fiesta,
// control de revisión optimista y cero dependencias (solo stdlib de Node).
//
//   POST /api/fiestas            {estado}              -> 201 {id, clave, rev}
//   GET  /api/fiestas/:id[?rev=] -> 200 {rev, estado, updatedAt} | 304
//   PUT  /api/fiestas/:id        {clave, rev, estado}  -> 200 {rev, updatedAt}
//                                   | 409 {rev, estado} | 403 | 404
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
const RATE_MAX = 120;                 // peticiones por IP y minuto
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
    const trozos = [];
    req.on('data', (t) => {
      total += t.length;
      if (total > MAX_BODY) {
        reject(new Error('grande'));
        req.destroy();
        return;
      }
      trozos.push(t);
    });
    req.on('end', () => resolve(Buffer.concat(trozos).toString('utf8')));
    req.on('error', reject);
  });
}

// El estado compartido de una fiesta, sin campos locales del cliente y con
// forma mínima verificada. Devuelve null si aquello no parece una fiesta.
function estadoValido(estado) {
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) return null;
  const f = estado.fiesta;
  if (!f || typeof f !== 'object' || typeof f.nombre !== 'string' || !f.nombre.trim()) return null;
  if (!Array.isArray(estado.gente) || estado.gente.length > 100) return null;
  if (!Array.isArray(estado.items) || estado.items.length > 500) return null;
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
  c.n++;
  if (cupos.size > 5000) cupos.clear();
  return c.n <= RATE_MAX;
}

/* ---------- purga de fiestas abandonadas ---------- */

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
  if (borradas) console.log(`purga: ${borradas} fiesta(s) caducada(s)`);
}
purgar();
setInterval(purgar, 12 * 3600 * 1000).unref();

/* ---------- API ---------- */

async function api(req, res, url) {
  if (!pasaCupo(req)) return json(res, 429, { error: 'Frena un poco, máquina.' });

  if (req.method === 'GET' && url.pathname === '/api/salud') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/fiestas') {
    let cuerpo;
    try { cuerpo = JSON.parse(await leerCuerpo(req)); }
    catch (e) { return json(res, 400, { error: 'Cuerpo inválido' }); }
    const estado = estadoValido(cuerpo && cuerpo.estado);
    if (!estado) return json(res, 400, { error: 'Eso no es una fiesta' });
    const id = aleatorio(10);
    const clave = aleatorio(14);
    const doc = { clave, rev: 1, updatedAt: new Date().toISOString(), estado };
    guardarFiesta(id, doc);
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
      catch (e) { return json(res, 400, { error: 'Cuerpo inválido' }); }
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
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - inicio}ms`);
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
