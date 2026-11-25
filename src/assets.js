/**
 * Ассеты приложения. В обычном режиме читаются с диска,
 * в собранном .exe этот файл заменяется версией со встроенными данными.
 */
const fs = require('fs');
const path = require('path');

module.exports = {
  isExe: false,
  baseDir: __dirname,
  html() {
    return fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
  },
  voices() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'voices.json'), 'utf8'));
  },
};
