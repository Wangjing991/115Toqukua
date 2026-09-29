'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { download } = require('../src/download');
test('download follows a redirect, checks exact length, and removes failed partial files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-download-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); res.end(); }
    else { res.end(Buffer.from('hello')); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(root).startsWith('openlist-download-')); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/redirect`, file = path.join(root, 'content.bin');
  await download({ url, file, expectedSize: 5 }); assert.equal((await fs.readFile(file)).toString(), 'hello');
  await assert.rejects(download({ url, file: path.join(root, 'bad'), expectedSize: 8 }), /大小不一致/);
  await assert.rejects(fs.access(path.join(root, 'bad.part')));
  await assert.rejects(download({ url, file: path.join(root, 'oversized'), expectedSize: 2 }), /大小发生变化/);
});
