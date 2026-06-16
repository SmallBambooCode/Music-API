'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

loadDotEnv(path.join(process.cwd(), '.env.local'));
loadDotEnv(path.join(process.cwd(), '.env'));

const enhancedPort = process.env.API_ENHANCED_PORT || '3000';
const adapterPort = process.env.ADAPTER_PORT || '3017';
const isWin = process.platform === 'win32';

function run(name, command, env = {}) {
  console.log(`[both] ${name}: ${command}`);
  const child = spawn(command, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  child.on('exit', code => console.log(`[${name}] exited with code ${code}`));
  return child;
}

const enhancedCmd = isWin
  ? `set PORT=${enhancedPort}&& npx @neteasecloudmusicapienhanced/api@latest`
  : `PORT=${enhancedPort} npx @neteasecloudmusicapienhanced/api@latest`;

console.log(`[both] api-enhanced PORT=${enhancedPort}`);
console.log(`[both] adapter ADAPTER_PORT=${adapterPort}`);
console.log(`[both] open http://127.0.0.1:${adapterPort}/test`);
console.log(`[both] admin http://127.0.0.1:${adapterPort}/admin`);

run('api-enhanced', enhancedCmd);

setTimeout(() => {
  run('adapter', `${process.execPath} server.js`, {
    ADAPTER_PORT: adapterPort,
    API_ENHANCED_PORT: enhancedPort,
    NCM_API_BASE: process.env.NCM_API_BASE || `http://127.0.0.1:${enhancedPort}`,
    PROVIDER_MODE: 'http',
  });
}, 7000);

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
