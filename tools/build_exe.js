/**
 * Сборка ozvuchka.exe: приложение в одном файле.
 *
 *  1. встраивает страницу и каталог голосов внутрь бандла;
 *  2. бандлит сервер в один JS;
 *  3. собирает blob Node SEA;
 *  4. копирует node.exe, ставит иконку и реквизиты (rcedit);
 *  5. вшивает blob (postject).
 *
 * Запуск: node tools/build_exe.js   (только Windows)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(ROOT, 'ozvuchka.exe');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
const VERSION = require(path.join(ROOT, 'package.json')).version;

function run(cmd, args, cwd) {
  console.log('> ' + path.basename(cmd) + ' ' + args.map((a) => (a.length > 70 ? a.slice(0, 70) + '…' : a)).join(' '));
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function rceditPath() {
  const base = path.join(ROOT, 'node_modules', 'rcedit', 'bin');
  for (const name of ['rcedit-x64.exe', 'rcedit.exe']) {
    const p = path.join(base, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  if (process.platform !== 'win32') {
    console.error('exe собирается только на Windows (нужен node.exe).');
    process.exit(1);
  }

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // 1. сервер + встроенные ассеты
  fs.copyFileSync(path.join(SRC, 'server.js'), path.join(BUILD, 'server.js'));

  const html = fs.readFileSync(path.join(SRC, 'public', 'index.html'));
  const voices = fs.readFileSync(path.join(SRC, 'voices.json'));
  const assetsJs = `const path = require('path');
const HTML = Buffer.from("${html.toString('base64')}", 'base64');
const VOICES_B64 = "${voices.toString('base64')}";
function resolveBase() {
  try { if (require('node:sea').isSea()) return path.dirname(process.execPath); } catch (_) {}
  return __dirname;
}
module.exports = {
  isExe: true,
  baseDir: resolveBase(),
  html() { return HTML; },
  voices() { return JSON.parse(Buffer.from(VOICES_B64, 'base64').toString('utf8')); },
};
`;
  fs.writeFileSync(path.join(BUILD, 'assets.js'), assetsJs, 'utf8');
  console.log('встроено: html ' + html.length + ' Б, голоса ' + voices.length + ' Б');

  // 2. бандл
  const esbuild = require('esbuild');
  esbuild.buildSync({
    entryPoints: [path.join(BUILD, 'server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['bufferutil', 'utf-8-validate'],
    outfile: path.join(BUILD, 'bundle.js'),
    logLevel: 'warning',
  });
  console.log('bundle.js: ' + Math.round(fs.statSync(path.join(BUILD, 'bundle.js')).size / 1024) + ' КБ');

  // 3. blob для SEA
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
    main: 'bundle.js',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2));
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], BUILD);
  console.log('blob: ' + Math.round(fs.statSync(path.join(BUILD, 'sea-prep.blob')).size / 1024) + ' КБ');

  // 4. node.exe -> ozvuchka.exe + иконка и реквизиты
  fs.copyFileSync(process.execPath, OUT);

  const rc = rceditPath();
  if (rc && fs.existsSync(ICON)) {
    run(rc, [
      OUT,
      '--set-icon', ICON,
      '--set-file-version', VERSION + '.0',
      '--set-product-version', VERSION + '.0',
      '--set-version-string', 'ProductName', 'Озвучка текста',
      '--set-version-string', 'FileDescription', 'Озвучка текста — бесплатная программа',
      '--set-version-string', 'OriginalFilename', 'ozvuchka.exe',
      '--set-version-string', 'CompanyName', 'ozvuchka',
    ], ROOT);
    console.log('иконка и реквизиты установлены (v' + VERSION + ')');
  } else {
    console.log('rcedit или иконка не найдены — собираю без иконки');
  }

  // 5. вшиваем blob
  const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  run(process.execPath, [
    postject,
    OUT,
    'NODE_SEA_BLOB',
    path.join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], ROOT);

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
  console.log('\nГОТОВО: ' + OUT + ' (' + mb + ' МБ, версия ' + VERSION + ')');
}

main();
