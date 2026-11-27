/**
 * Переключает exe в режим GUI: консольное окно больше не появляется.
 *
 * В PE-заголовке правится одно поле — Subsystem в Optional Header:
 *   3 = CONSOLE (чёрное окно), 2 = WINDOWS_GUI (без окна).
 * Работает для PE32 и PE32+ — поле стоит на одном и том же месте.
 */
const fs = require('fs');

const SUBSYSTEM_OFFSET = 68; // от начала Optional Header

function patch(exePath) {
  const buf = fs.readFileSync(exePath);

  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('не MZ-файл');

  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOffset, peOffset + 2) !== 'PE') throw new Error('не PE-файл');

  const optional = peOffset + 4 + 20; // после COFF-заголовка
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('неизвестный формат PE: 0x' + magic.toString(16));

  const at = optional + SUBSYSTEM_OFFSET;
  const before = buf.readUInt16LE(at);
  if (before === 2) return { changed: false, subsystem: 2 };

  buf.writeUInt16LE(2, at);
  fs.writeFileSync(exePath, buf);
  return { changed: true, before, subsystem: buf.readUInt16LE(at) };
}

function read(exePath) {
  const buf = fs.readFileSync(exePath);
  const peOffset = buf.readUInt32LE(0x3c);
  return buf.readUInt16LE(peOffset + 4 + 20 + SUBSYSTEM_OFFSET);
}

module.exports = { patch, read };

if (require.main === module) {
  const p = process.argv[2];
  if (!p) {
    console.error('укажи путь к exe');
    process.exit(1);
  }
  console.log('до: subsystem =', read(p));
  console.log('patch:', patch(p));
  console.log('после: subsystem =', read(p), '(2 = без консольного окна)');
}
