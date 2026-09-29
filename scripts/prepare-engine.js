'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../vendor/manifest.json');
const { download } = require('./download');
const quote = value => "'" + value.replace(/'/g, "''") + "'";

async function main() {
  if (process.platform !== 'win32') throw new Error('This preparation script requires Windows.');
  const archive = path.join(root, '.cache', 'downloads', 'openlist-v4.2.6-windows-amd64.zip');
  let bytes;
  try { bytes = await fs.readFile(archive); } catch { bytes = await download(manifest.archiveUrl, archive); }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.archiveSha256) throw new Error(`OpenList archive SHA256 mismatch: ${actual}`);
  const extract = path.join(root, '.cache', 'openlist-v4.2.6');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extract)} -Force`],
    { windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Could not extract the verified OpenList archive.');
  const exe = path.join(extract, 'openlist.exe');
  await fs.copyFile(exe, path.join(root, 'vendor', 'openlist.exe'));
  const binarySha256 = crypto.createHash('sha256').update(await fs.readFile(exe)).digest('hex');
  if (manifest.binarySha256 && manifest.binarySha256 !== binarySha256) throw new Error('Unexpected extracted OpenList binary.');
  await fs.writeFile(path.join(root, 'vendor', 'manifest.json'), JSON.stringify({ ...manifest, binarySha256 }, null, 2) + '\n');
  const sourceArchive = path.join(root, 'vendor', 'source', 'OpenList-v4.2.6.tar.gz');
  try { await fs.access(sourceArchive); } catch { await download(manifest.sourceUrl, sourceArchive); }
  const sourceSha256 = crypto.createHash('sha256').update(await fs.readFile(sourceArchive)).digest('hex');
  if (manifest.sourceSha256 && manifest.sourceSha256 !== sourceSha256) throw new Error('Source archive SHA256 mismatch.');
  const licenseResult = spawnSync('tar.exe', ['-xOf', sourceArchive, 'OpenList-4.2.6/LICENSE'], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (licenseResult.status !== 0 || !licenseResult.stdout.includes(Buffer.from('GNU AFFERO GENERAL PUBLIC LICENSE'))) throw new Error('Could not extract upstream license from source archive.');
  await fs.mkdir(path.join(root, 'vendor', 'licenses'), { recursive: true });
  await fs.writeFile(path.join(root, 'vendor', 'licenses', 'OpenList-LICENSE.txt'), licenseResult.stdout);
  await fs.writeFile(path.join(root, 'LICENSE'), licenseResult.stdout);
  const frontendArchive = path.join(root, 'vendor', 'source', 'OpenList-Frontend-v4.2.6.tar.gz');
  try { await fs.access(frontendArchive); } catch { await download(manifest.frontendSourceUrl, frontendArchive); }
  const frontendSourceSha256 = crypto.createHash('sha256').update(await fs.readFile(frontendArchive)).digest('hex');
  if (manifest.frontendSourceSha256 && manifest.frontendSourceSha256 !== frontendSourceSha256) throw new Error('Frontend source archive SHA256 mismatch.');
  const frontendLicense = spawnSync('tar.exe', ['-xOf', frontendArchive, 'OpenList-Frontend-4.2.6/LICENSE'], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (frontendLicense.status !== 0) throw new Error('Could not extract frontend license.');
  await fs.writeFile(path.join(root, 'vendor', 'licenses', 'OpenList-Frontend-LICENSE.txt'), frontendLicense.stdout);
  await fs.writeFile(path.join(root, 'vendor', 'manifest.json'), JSON.stringify({ ...manifest, binarySha256, sourceSha256, frontendSourceSha256, sourceDigestType: 'Locally computed after download from the tagged official source URL; not an upstream-published source digest.' }, null, 2) + '\n');
  console.log(`Verified OpenList v4.2.6 archive SHA256 ${actual}`);
  console.log(`OpenList binary: ${path.join(root, 'vendor', 'openlist.exe')}`);
  console.log(`Binary SHA256 ${binarySha256}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
