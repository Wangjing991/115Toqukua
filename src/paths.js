'use strict';
const path = require('node:path');
const MOUNTS = Object.freeze({ quark: '/夸克', pan115: '/115' });
function name(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) throw new Error('文件名包含不支持的路径字符');
  return value;
}
function remote(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || /[\x00-\x1f]/.test(value)) throw new Error('网盘路径无效');
  const parts = value.split('/').filter(Boolean);
  parts.forEach(name);
  return '/' + parts.join('/');
}
function within(value, root) {
  const p = remote(value), r = remote(root);
  if (p !== r && !p.startsWith(r + '/')) throw new Error('路径超出所选网盘');
  return p;
}
function join(parent, child) { return remote(parent).replace(/\/$/, '') + '/' + name(child); }
function key(value) { return value.normalize('NFC').toLocaleLowerCase('en-US'); }
function availableName(original, entries) {
  name(original);
  const used = new Set(entries.map(e => key(typeof e === 'string' ? e : e.name)));
  if (!used.has(key(original))) return original;
  const extension = path.posix.extname(original), stem = original.slice(0, original.length - extension.length);
  for (let n = 2; n < 1000000; n++) {
    const suffix = ` (${n})${extension}`;
    const next = Array.from(stem).slice(0, Math.max(1, 240 - Array.from(suffix).length)).join('') + suffix;
    if (!used.has(key(next))) return next;
  }
  throw new Error('无法分配不重复的文件名');
}
function localWithin(root, ...parts) {
  const r = path.resolve(root), result = path.resolve(r, ...parts);
  const rel = path.relative(r, result);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('缓存路径无效');
  return result;
}
function redact(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[网络地址]')
    .replace(/((?:cookie|authorization|access[_ ]?token|refresh[_ ]?token|password)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .slice(0, 1200);
}
module.exports = { MOUNTS, name, remote, within, join, availableName, localWithin, redact };
