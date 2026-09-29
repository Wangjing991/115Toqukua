'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'win32') throw new Error('Build this Windows release on Windows.');
process.env.ELECTRON_CACHE = path.join(root, '.cache', 'electron');
process.env.ELECTRON_BUILDER_CACHE = path.join(root, '.cache', 'electron-builder');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
fs.mkdirSync(process.env.ELECTRON_CACHE, { recursive: true });
fs.mkdirSync(process.env.ELECTRON_BUILDER_CACHE, { recursive: true });
const crypto = require('node:crypto');
const manifest = require('../vendor/manifest.json');
const engine = path.join(root, 'vendor', 'openlist.exe');
if (!fs.existsSync(engine)) throw new Error('Run npm run prepare:engine before building.');
if (!manifest.binarySha256 || crypto.createHash('sha256').update(fs.readFileSync(engine)).digest('hex') !== manifest.binarySha256) {
  throw new Error('The embedded engine does not match vendor/manifest.json. Run npm run prepare:engine.');
}
require('./prepare-runtime').prepareRuntime().then(async () => {
  const builder = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  const result = spawnSync(process.execPath, [builder, '--win', 'portable', '--x64', '--publish', 'never'], {
    cwd: root, env: process.env, windowsHide: true, stdio: 'inherit'
  });
  process.exitCode = result.status ?? 1;
  if (result.status === 0) await require('./write-checksums').writeChecksums();
}).catch(error => { console.error(error.message); process.exitCode = 1; });
