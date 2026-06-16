'use strict';

const fs = require('node:fs');
const path = require('node:path');

loadDotEnv(path.join(process.cwd(), '.env.local'));
loadDotEnv(path.join(process.cwd(), '.env'));

const provider = require('../lib/provider');
const httpClient = require('../lib/enhanced-http-client');

(async () => {
  console.log('PROVIDER_MODE selected =', provider.providerName());
  console.log('ADAPTER_PORT =', httpClient.getAdapterPort());
  console.log('API_ENHANCED_PORT =', httpClient.getEnhancedPort());
  console.log('NCM_API_BASE =', httpClient.getBase());
  console.log('health =', JSON.stringify(await provider.health(), null, 2));
  const id = process.argv[2] || '174944';
  console.log('probe =', JSON.stringify(await provider.probe(id), null, 2));
  console.log('songUrl =', JSON.stringify(await provider.songUrl(id), null, 2));
})().catch(err => {
  console.error(err);
  process.exit(1);
});

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
