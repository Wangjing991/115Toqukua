'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareRuntime } = require('./prepare-runtime');
prepareRuntime().then(executable => {
  const child = spawn(executable, ['.'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
}).catch(error => { console.error(error.message); process.exitCode = 1; });
