'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function writeChecksums() {
  const output = path.resolve(__dirname, '..', 'release');
  const names = ['OpenListTransfer-1.0.0-x64.exe', 'OpenListTransfer-1.0.0-source.zip'];
  const lines = [];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(output, name)).catch(() => null);
    if (!bytes) continue;
    lines.push(`${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
module.exports = { writeChecksums };
if (require.main === module) writeChecksums().catch(error => { console.error(error.message); process.exitCode = 1; });
