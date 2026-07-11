#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const htmlFile = path.join(root, 'public', 'index.html');
const headerFile = path.join(root, 'deployment', 'nginx', 'security-headers.conf');
const checkOnly = process.argv.includes('--check');
const startMarker = '# BEGIN GENERATED CSP — run: node scripts/update_csp.js';
const endMarker = '# END GENERATED CSP';

function hashesFor(html, tag) {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...html.matchAll(expression)].map((match) => {
    const digest = crypto.createHash('sha256').update(match[1]).digest('base64');
    return `'sha256-${digest}'`;
  });
}

const html = fs.readFileSync(htmlFile, 'utf8');
const scriptHashes = hashesFor(html, 'script');
const styleHashes = hashesFor(html, 'style');
if (!scriptHashes.length || !styleHashes.length) {
  throw new Error('Expected inline script and style blocks in public/index.html');
}

const policy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  `script-src 'self' ${scriptHashes.join(' ')}`,
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  `style-src-elem 'self' https://fonts.googleapis.com ${styleHashes.join(' ')}`,
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "worker-src 'none'",
  'upgrade-insecure-requests',
].join('; ');
const generated = `${startMarker}\nadd_header Content-Security-Policy "${policy}" always;\n${endMarker}`;

const current = fs.readFileSync(headerFile, 'utf8');
const start = current.indexOf(startMarker);
const end = current.indexOf(endMarker, start + startMarker.length);
if (start < 0 || end < 0) throw new Error('Generated CSP markers are missing');
const next = current.slice(0, start) + generated + current.slice(end + endMarker.length);

if (checkOnly) {
  if (next !== current) {
    console.error('CSP is stale. Run: node scripts/update_csp.js');
    process.exitCode = 1;
  } else {
    console.log('CSP matches public/index.html');
  }
} else if (next !== current) {
  fs.writeFileSync(headerFile, next);
  console.log('Updated generated CSP');
} else {
  console.log('CSP already current');
}
