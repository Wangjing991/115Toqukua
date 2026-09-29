'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
function response(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('下载重定向次数过多'));
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('下载地址协议无效'));
    const req = (u.protocol === 'https:' ? https : http).get(u, { signal, headers: { 'Accept-Encoding': 'identity' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); resolve(response(new URL(res.headers.location, u).href, signal, redirects + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`读取原文件失败（HTTP ${res.statusCode}）`)); return; }
      resolve(res);
    });
    req.setTimeout(120000, () => req.destroy(new Error('读取原文件超过两分钟没有响应')));
    req.on('error', reject);
  });
}
async function download({ url, file, expectedSize, signal, onProgress = () => {} }) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const partial = file + '.part';
  let bytes = 0;
  try {
    const res = await response(url, signal);
    const counter = new Transform({ transform(chunk, enc, callback) {
      bytes += chunk.length;
      if (bytes > expectedSize) { callback(new Error('源文件大小发生变化，已停止本次复制')); return; }
      onProgress(bytes); callback(null, chunk);
    } });
    await pipeline(res, counter, fs.createWriteStream(partial, { flags: 'w', mode: 0o600 }), { signal });
    if (bytes !== expectedSize) throw new Error(`下载大小不一致：预计 ${expectedSize} 字节，实际 ${bytes} 字节`);
    await fs.promises.rename(partial, file);
  } catch (e) { await fs.promises.rm(partial, { force: true }).catch(() => {}); throw e; }
  return bytes;
}
module.exports = { download };
