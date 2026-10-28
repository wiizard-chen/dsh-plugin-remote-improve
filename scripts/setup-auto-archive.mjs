#!/usr/bin/env node
/** Pinned third-party integration. Default preview; never restarts DSH or scans sessions. */
import {
  existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync,
  renameSync, rmSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { installAutoArchive } from './install.mjs';
import { patchHost, patchClient } from '../integrations/auto-archive/patch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION = path.join(ROOT, 'integrations', 'auto-archive');
export const PIN = JSON.parse(readFileSync(path.join(INTEGRATION, 'upstream.json'), 'utf8'));
const LOCK = readFileSync(path.join(INTEGRATION, 'package-lock.json'), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
function realDirectory(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`Expected a real directory: ${directory}`);
}
function plainRead(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Expected a regular file: ${file}`);
  return readFileSync(file, 'utf8');
}
function parseJSON(text, file) {
  try { return JSON.parse(text); } catch { fail(`Invalid JSON: ${file}`); }
}
function ensureDirectories(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) ensureDirectories(parent);
  if (existsSync(directory)) { realDirectory(directory); return; }
  // A dangling symlink is not an invitation to replace it.
  try { lstatSync(directory); fail(`Refusing redirected path: ${directory}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (parent === directory) fail(`Cannot create directory: ${directory}`);
  mkdirSync(directory, { mode: 0o700 });
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 180000, shell: false });
  if (result.error || result.status !== 0) fail(`${command} failed${result.status === null ? '' : ` (${result.status})`}; profile was not registered`);
}

/** SHA validation intentionally does not execute any upstream script. */
export function verifyUpstream(source, pin = PIN) {
  realDirectory(source);
  const files = {};
  for (const [relative, expected] of Object.entries(pin.files)) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) fail('Invalid upstream file allowlist');
    const file = path.join(source, relative);
    realDirectory(path.dirname(file));
    const text = plainRead(file);
    if (sha256(text) !== expected) fail(`Pinned upstream checksum mismatch: ${relative}`);
    files[relative] = text;
  }
  return files;
}

export function deriveFiles(source, { pin = PIN, lock = LOCK, hostPatch = patchHost, clientPatch = patchClient } = {}) {
  const files = verifyUpstream(source, pin);
  const manifest = parseJSON(files['package.json'], 'upstream package.json');
  if (manifest.name !== pin.name || manifest.version !== pin.upstreamVersion || manifest.license !== pin.license) fail('Unexpected upstream manifest');
  // Keep the original author, license and dependencies. Never run its lifecycle scripts.
  manifest.version = pin.derivedVersion;
  manifest.dshRemoteImprove = { upstreamCommit: pin.commit, compatibilityVersion: pin.derivedVersion };
  files['package.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  files['lib/index.js'] = hostPatch(files['lib/index.js']);
  files['lib/client.js'] = clientPatch(files['lib/client.js']);
  files['README.md'] += '\n\n## Remote Improve integration\n\nThis is a pinned derived build, not an unmodified upstream release. Remote path/authentication and lifecycle compatibility patches are maintained at https://github.com/wiizard-chen/dsh-plugin-remote-improve/blob/main/docs/AUTO-ARCHIVE.md . Original authorship and MIT license are retained.\n';
  files['package-lock.json'] = lock;
  files['UPSTREAM.json'] = `${JSON.stringify({ ...pin, generatedFiles: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(value)])) }, null, 2)}\n`;
  return files;
}

/** Build atomically outside the repository; an existing different build is never overwritten. */
export function prepareArtifact(source, target, { command = run, ...deriveOptions } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || /[\0\r\n]/.test(target) || inside(ROOT, path.resolve(target))) fail('Artifact target must be an absolute path outside the repository');
  const files = deriveFiles(source, deriveOptions);
  const parent = path.dirname(target);
  ensureDirectories(parent);
  const lock = parseJSON(files['package-lock.json'], 'runtime lock');
  const dependenciesReady = (directory) => Object.entries(lock.packages ?? {}).every(([relative, meta]) => {
    if (!relative) return true;
    try { return parseJSON(plainRead(path.join(directory, relative, 'package.json')), relative).version === meta.version; }
    catch { return false; }
  });
  if (existsSync(target)) {
    realDirectory(target);
    for (const [relative, text] of Object.entries(files)) {
      realDirectory(path.dirname(path.join(target, relative)));
      if (plainRead(path.join(target, relative)) !== text) fail(`Existing derived build differs; refuse overwrite: ${relative}`);
    }
    if (!dependenciesReady(target)) fail('Existing derived build has missing/different dependencies; choose a new build directory rather than modifying a possibly running plugin');
    return target;
  }
  const stage = mkdtempSync(path.join(parent, '.auto-archive-build-'));
  try {
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(stage, relative);
      ensureDirectories(path.dirname(file));
      writeFileSync(file, text, { flag: 'wx', mode: 0o644 });
    }
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    if (process.platform === 'win32') {
      if (!process.env.npm_execpath) fail('On Windows, invoke this setup through npm run setup:auto-archive');
      command(process.execPath, [process.env.npm_execpath, ...npmArgs], stage);
    } else command('npm', npmArgs, stage);
    if (!dependenciesReady(stage)) fail('Runtime dependency versions do not match the committed lock');
    command(process.execPath, ['--check', path.join(stage, 'lib/index.js')], stage);
    command(process.execPath, ['--check', path.join(stage, 'lib/client.js')], stage);
    if (path.dirname(realpathSync(stage)) !== realpathSync(parent) || !path.basename(stage).startsWith('.auto-archive-build-')) fail('Unsafe artifact staging path');
    if (existsSync(target)) fail('Build destination appeared concurrently');
    renameSync(stage, target);
  } catch (error) {
    // Only remove this exact freshly-created staging directory, never a computed arbitrary target.
    if (existsSync(stage)) {
      realDirectory(stage);
      if (path.dirname(realpathSync(stage)) !== realpathSync(parent) || !path.basename(stage).startsWith('.auto-archive-build-')) fail('Unsafe staging cleanup path');
      rmSync(stage, { recursive: true, force: true });
    }
    throw error;
  }
  return target;
}

export function previewConfig(home, apply = false) {
  realDirectory(home);
  const store = path.join(home, 'storages', 'auto-archive');
  const file = path.join(store, 'config.json');
  // Existing parent redirects are refused even during preview.
  for (const parent of [path.join(home, 'storages'), store]) if (existsSync(parent)) {
    realDirectory(parent);
    if (realpathSync(parent) !== parent) fail(`Redirected config parent: ${parent}`);
  }
  if (existsSync(file)) {
    const value = parseJSON(plainRead(file), 'auto-archive config.json');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid auto-archive config object');
    if (value.dryRun === false) fail('Existing auto-archive config is in REAL mode. Refusing unattended setup; switch it back to dry run first');
    return { created: false, dryRun: true };
  }
  if (apply) {
    ensureDirectories(store);
    writeFileSync(file, `${JSON.stringify(PIN.previewDefaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return { created: apply, dryRun: true };
}

export function parseSetupArgs(args, env = process.env) {
  const options = { home: env.DSH_HOME || path.join(homedir(), '.dsh'), profile: 'web', apply: false, remove: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--home', '--profile', '--source', '--apply', '--dry-run', '--remove', '--help'].includes(flag) || seen.has(flag)) fail(`Unknown or repeated argument: ${flag}`);
    seen.add(flag);
    if (['--home', '--profile', '--source'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else if (flag === '--apply') options.apply = true;
    else if (flag === '--remove') options.remove = true;
    else if (flag === '--help') options.help = true;
  }
  if (seen.has('--apply') && seen.has('--dry-run')) fail('--apply and --dry-run are mutually exclusive');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.profile) || options.profile === 'node_modules') fail('Invalid profile name');
  for (const key of ['home', 'source']) if (options[key] !== undefined && (!path.isAbsolute(options[key]) || /[\0\r\n]/.test(options[key]))) fail(`${key} must be an absolute path`);
  return options;
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseSetupArgs(args);
    if (options.help) {
      console.log('Usage: node scripts/setup-auto-archive.mjs [--home ABSOLUTE_DSH_HOME] [--profile web] [--source ABSOLUTE_PINNED_CHECKOUT] [--apply|--dry-run] [--remove]\nDefault: preview only. Apply downloads a pinned public upstream if needed, builds a patched derived package, installs locked runtime dependencies with scripts disabled, seeds dry-run config, and registers its bundle. No server restart or real scan.');
      return 0;
    }
    const home = realpathSync(options.home);
    realDirectory(home);
    if (home === path.parse(home).root || inside(ROOT, home)) fail('DSH home must be outside the repository and not the filesystem root');
    const profilePath = path.join(home, 'profiles', options.profile);
    realDirectory(path.join(home, 'profiles'));
    realDirectory(profilePath);
    const manifest = parseJSON(plainRead(path.join(profilePath, 'package.json')), 'profile package.json');
    if (!Array.isArray(manifest?.dsh?.profile?.bundles)) fail('Existing DSH profile bundle array required');
    const target = path.join(home, 'third-party', 'packages', `${PIN.name}-${PIN.derivedVersion}`);
    const source = options.source ?? path.join(home, 'third-party', 'sources', `${PIN.name}-${PIN.commit.slice(0, 12)}`);
    if (inside(ROOT, source) || inside(source, ROOT) || inside(profilePath, source) || inside(source, profilePath)) fail('Upstream source must be separate from the repository and profile');
    if (options.remove) {
      const result = installAutoArchive({ home, profile: options.profile, apply: options.apply, remove: true }, target);
      console.log(result.changed ? 'Only bundle registration is removed; private config/history and source are retained.' : 'No owned archive bundle changes needed.');
      return 0;
    }
    previewConfig(home);
    if (!options.apply) {
      if (existsSync(source)) verifyUpstream(source);
      console.log(`dry-run: ${PIN.name} ${PIN.derivedVersion}, upstream ${PIN.commit}\nsource: ${source}\nartifact: ${target}\nprofile: ${profilePath}\nFirst install stays in dry-run mode (14 idle days); no network, config writes, scan or restart. Re-run with --apply.`);
      return 0;
    }
    if (!existsSync(source)) {
      if (options.source) fail('Explicit upstream source does not exist');
      ensureDirectories(path.dirname(source));
      const stage = mkdtempSync(path.join(path.dirname(source), '.archive-source-'));
      run('git', ['clone', '--no-checkout', PIN.repository, stage], path.dirname(source));
      run('git', ['checkout', '--detach', PIN.commit], stage);
      verifyUpstream(stage);
      if (path.dirname(realpathSync(stage)) !== realpathSync(path.dirname(source)) || !path.basename(stage).startsWith('.archive-source-')) fail('Unsafe source staging path');
      if (existsSync(source)) fail('Source destination appeared concurrently');
      renameSync(stage, source);
    }
    prepareArtifact(source, target);
    run(process.execPath, [path.join(ROOT, 'scripts/smoke-auto-archive.mjs'), target], ROOT);
    installAutoArchive({ home, profile: options.profile, apply: false }, target, () => {});
    previewConfig(home, true);
    const result = installAutoArchive({ home, profile: options.profile, apply: true }, target);
    console.log(result.changed ? 'Archive plugin registered in preview mode. Reload safely after current tasks finish, then refresh the browser.' : 'Archive registration already matches; existing preview configuration preserved.');
    return 0;
  } catch (error) {
    console.error(`auto-archive setup: ${error.message}`);
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
