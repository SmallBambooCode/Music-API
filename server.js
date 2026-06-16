'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadDotEnv(path.join(process.cwd(), '.env.local'));
loadDotEnv(path.join(process.cwd(), '.env'));

const { handle } = require('./lib/app');
const httpClient = require('./lib/enhanced-http-client');

const PORT = httpClient.getAdapterPort();

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'fatal', message: err.message }, null, 2));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Meting Enhanced Adapter v13: http://127.0.0.1:${PORT}/test`);
  console.log(`Admin: http://127.0.0.1:${PORT}/admin`);
  console.log(`Health: http://127.0.0.1:${PORT}/api?action=health`);
  console.log(`Expect api-enhanced at: ${httpClient.getBase()}`);
});
