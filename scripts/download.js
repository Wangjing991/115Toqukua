'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Small retryable ranges survive intermittent resets on large official release assets.
async function download(url, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const first = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(180000) });
  if (!first.ok) throw new Error(`Download failed (${first.status}): ${url}`);
  const range = first.headers.get('content-range');
  if (first.status !== 206 || !range) {
    const bytes = Buffer.from(await first.arrayBuffer());
    await fs.writeFile(destination, bytes);
    return bytes;
  }
  await first.body.cancel();
  const resolvedUrl = first.url;
  const length = Number(range.split('/')[1]);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid release asset length.');
  const size = 1024 * 1024;
  const count = Math.ceil(length / size);
  const partsDir = path.join(__dirname, '..', '.cache', 'download-parts', crypto.createHash('sha256').update(url).digest('hex'));
  await fs.mkdir(partsDir, { recursive: true });
  let next = 0, complete = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, count) }, async () => {
    while (next < count) {
      const index = next++;
      const start = index * size, end = Math.min(length - 1, start + size - 1);
      const part = path.join(partsDir, String(index));
      const prior = await fs.stat(part).catch(() => null);
      if (!prior || prior.size !== end - start + 1) {
        let bytes;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const response = await fetch(resolvedUrl, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(90000) });
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${length}`) throw new Error('Incorrect release asset range response.');
            bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length !== end - start + 1) throw new Error('Incomplete release asset range.');
            break;
          } catch (error) { if (attempt === 3) throw error; }
        }
        await fs.writeFile(part, bytes);
      }
      complete++;
      if (count > 8 && (complete % 8 === 0 || complete === count)) console.log(`Download ${path.basename(destination)}: ${complete}/${count} parts`);
    }
  }));
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(await fs.readFile(path.join(partsDir, String(i))));
  const bytes = Buffer.concat(parts);
  await fs.writeFile(destination, bytes);
  return bytes;
}
module.exports = { download };
if (require.main === module) download(process.argv[2], path.resolve(process.argv[3])).then(bytes => console.log(`Downloaded ${bytes.length} bytes`)).catch(error => { console.error(error.message); process.exitCode = 1; });
