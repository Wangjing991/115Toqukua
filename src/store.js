'use strict';
const fs = require('node:fs');
const path = require('node:path');
class Store {
  constructor(file, defaults) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = structuredClone(defaults);
    if (fs.existsSync(file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
      catch { throw new Error('任务记录无法读取。请先备份数据目录并检查 tasks.json，程序没有覆盖原记录。'); }
    }
  }
  save() {
    const temporary = this.file + '.writing';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }
}
module.exports = { Store };
