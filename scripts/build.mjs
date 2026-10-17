// Builds dist/maxaicli.cjs (single-file bundle) and, with --sea, a standalone executable
// (Node single-executable application) that needs no Node install on the target machine.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const html = fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8');
const bundle = path.join(dist, 'maxaicli.cjs');
await build({
  entryPoints: [path.join(root, 'bin/maxai.js')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  define: { 'import.meta.url': '__importMetaUrl', __MAXAI_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;\nglobalThis.__MAXAI_UI_HTML__ = ${JSON.stringify(html)};` },
  legalComments: 'none',
});
// strip the shebang esbuild keeps from the entry file; the SEA binary / wrapper supplies the interpreter
let src = fs.readFileSync(bundle, 'utf8').replace(/^#!.*\n/, '');
fs.writeFileSync(bundle, '#!/usr/bin/env node\n' + src);
fs.chmodSync(bundle, 0o755);
console.log(`bundle: ${path.relative(root, bundle)} (${(src.length / 1024).toFixed(0)} KiB)`);

if (process.argv.includes('--sea')) {
  const plat = process.platform, arch = process.arch;
  const name = `maxaicli-${plat === 'win32' ? 'windows' : plat}-${arch}${plat === 'win32' ? '.exe' : ''}`;
  const out = path.join(dist, name);
  const cfgPath = path.join(dist, 'sea-config.json');
  const blob = path.join(dist, 'sea-prep.blob');
  const src_ = path.join(dist, 'sea-main.cjs');
  fs.writeFileSync(src_, src);
  fs.writeFileSync(cfgPath, JSON.stringify({ main: src_, output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });
  fs.copyFileSync(process.execPath, out);
  fs.chmodSync(out, 0o755);
  if (plat === 'darwin') try { execFileSync('codesign', ['--remove-signature', out]); } catch {}
  const post = path.join(root, 'node_modules/.bin', plat === 'win32' ? 'postject.cmd' : 'postject');
  const args = [out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (plat === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(post, args, { stdio: 'inherit', shell: plat === 'win32' });
  if (plat === 'darwin') try { execFileSync('codesign', ['--sign', '-', out]); } catch {}
  fs.rmSync(src_); fs.rmSync(blob); fs.rmSync(cfgPath);
  console.log(`standalone executable: ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(0)} MiB)`);
}
