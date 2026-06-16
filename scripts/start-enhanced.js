'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

loadDotEnv(path.join(process.cwd(), '.env.local'));
loadDotEnv(path.join(process.cwd(), '.env'));

const port = process.env.API_ENHANCED_PORT || '3000';
const isWin = process.platform === 'win32';
const command = isWin
  ? `set PORT=${port}&& npx @neteasecloudmusicapienhanced/api@latest`
  : `PORT=${port} npx @neteasecloudmusicapienhanced/api@latest`;

console.log(`[start-enhanced] ${command}`);
const child = spawn(command, { stdio: 'inherit', shell: true, env: process.env });
child.on('exit', code => process.exit(code ?? 0));

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
