'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const quote = value => "'" + value.replace(/'/g, "''") + "'";

async function main() {
  await fs.mkdir(path.join(root, '.cache'), { recursive: true });
  const stage = await fs.mkdtemp(path.join(root, '.cache', 'source-stage-'));
  // Explicit allowlist: never walk user data, credentials, caches, dependencies or builds.
  const entries = ['package.json', 'package-lock.json', '.gitignore', 'README.md', 'LICENSE',
    'THIRD_PARTY_NOTICES.md', 'scripts', 'src', 'tests', 'docs', 'vendor/manifest.json', 'vendor/licenses', 'vendor/source'];
  for (const item of entries) {
    const from = path.join(root, item);
    if (!await fs.stat(from).catch(() => null)) continue;
    const to = path.join(stage, 'OpenListTransfer-1.0.0-source', item);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true, filter: source => !/\.(db|log|writing)$/.test(source) && !/[\\/](credentials[^\\/]*|tasks\.json|settings\.json|qa-preview\.png)$/i.test(source) });
  }
  const output = path.join(root, 'release', 'OpenListTransfer-1.0.0-source.zip');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const command = `Compress-Archive -LiteralPath ${quote(path.join(stage, 'OpenListTransfer-1.0.0-source'))} -DestinationPath ${quote(output)} -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Source archive creation failed.');
  const bytes = await fs.readFile(output);
  console.log(`${output}\n${bytes.length} bytes\nSHA256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
  await require('./write-checksums').writeChecksums();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
