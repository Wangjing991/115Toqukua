'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { download } = require('./download');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').devDependencies.electron;
const quote = value => "'" + value.replace(/'/g, "''") + "'";

async function prepareRuntime() {
  const archiveName = `electron-v${version}-win32-x64.zip`;
  const checksum = require('../node_modules/electron/checksums.json')[archiveName];
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Official Electron SHA256 is missing.');
  const archive = path.join(root, '.cache', 'electron', archiveName);
  let bytes;
  try { bytes = await fs.readFile(archive); } catch { bytes = await download(`https://github.com/electron/electron/releases/download/v${version}/${archiveName}`, archive); }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== checksum) throw new Error(`Electron SHA256 mismatch: ${actual}`);
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  const installedVersion = await fs.readFile(path.join(dist, 'version'), 'utf8').catch(() => '');
  if (installedVersion.trim().replace(/^v/, '') !== version) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(dist)} -Force`], { windowsHide: true, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Electron extraction failed.');
  }
  await fs.writeFile(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe');
  await fs.mkdir(path.join(root, 'vendor', 'licenses'), { recursive: true });
  await fs.copyFile(path.join(dist, 'LICENSE'), path.join(root, 'vendor', 'licenses', 'Electron-LICENSE.txt'));
  await fs.copyFile(path.join(dist, 'LICENSES.chromium.html'), path.join(root, 'vendor', 'licenses', 'LICENSES.chromium.html'));
  console.log(`Verified Electron ${version} SHA256 ${actual}`);
  return path.join(dist, 'electron.exe');
}
module.exports = { prepareRuntime };
if (require.main === module) prepareRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
