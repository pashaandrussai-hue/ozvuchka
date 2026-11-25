/**
 * Сборка ozvuchka.exe: встраивает страницу и каталог голосов, бандлит в один файл
 * и упаковывает Node в один exe (SEA + postject).
 *
 * Запуск: node tools/build_exe.js
 * Работает и на Windows, и на Linux-раннере (тогда exe не собрать — нужен windows-latest).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(ROOT, 'ozvuchka.exe');

function run(cmd, args, cwd) {
  console.log('> ' + path.basename(cmd) + ' ' + args.join(' '));
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function main() {
  if (process.platform !== 'win32') {
    console.error('exe собирается только на Windows (нужен node.exe).');
    process.exit(1);
  }

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // 1. исходник сервера
  fs.copyFileSync(path.join(SRC, 'server.js'), path.join(BUILD, 'server.js'));

  // 2. встроенные ассеты вместо чтения с диска
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

  // 3. бандл
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
  const bundleSize = fs.statSync(path.join(BUILD, 'bundle.js')).size;
  console.log('bundle.js: ' + Math.round(bundleSize / 1024) + ' КБ');

  // 4. blob для SEA
  const seaConfig = {
    main: 'bundle.js',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], BUILD);
  console.log('blob: ' + Math.round(fs.statSync(path.join(BUILD, 'sea-prep.blob')).size / 1024) + ' КБ');

  // 5. копия node.exe + внедрение blob
  fs.copyFileSync(process.execPath, OUT);
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
  console.log('\nГОТОВО: ' + OUT + ' (' + mb + ' МБ)');
}

main();
