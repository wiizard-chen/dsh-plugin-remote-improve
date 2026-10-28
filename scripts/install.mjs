#!/usr/bin/env node
/**
 * Install this checkout's bundles into an EXISTING DSH profile.
 * No package manager, shell, network, credential reads, or server restart.
 * Default: dry-run, copy only. Experimental perf bundles require --with-perf.
 * Backups stay private in the profile, never in this repo. Node >= 18.
 *
 * Do not edit a profile concurrently while applying. Snapshot checks reject
 * detected concurrent edits; this is not an OS sandbox against hostile races.
 */
import {
  constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync,
  unlinkSync, writeFileSync, fsyncSync, fchmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const PACKAGES = Object.freeze([
  Object.freeze({ name: '@local/dsh-perf-patches', directory: 'dsh-perf-patches' }),
  Object.freeze({ name: '@local/dsh-perf-context-floor', directory: 'dsh-perf-context-floor' }),
  Object.freeze({ name: 'dsh-copy-file-link', directory: 'dsh-copy-file-link' }),
]);
const BASE = '@deepseek-ai/dsh-base';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIRECTORY = '.dsh-plugin-remote-improve-backups';
const HELP = `Usage: node scripts/install.mjs [--home <absolute DSH_HOME>] [--profile <name>]
                                [--apply | --dry-run] [--with-perf] [--remove]

Default: dry-run, copy only, profile web, home $DSH_HOME or ~/.dsh.
The profile must already exist. Copy is placed last.
--with-perf Explicitly opt into both experimental, version-sensitive perf
            bundles, ordered perf, floor, base. Existing other entries stay.
--apply     Write changes, after backing up in the profile directory.
--dry-run   Validate and print changed packages and paths only (no writes).
--remove    Remove all THREE packages owned by this checkout, including perf.
--help      Show this help.

Install may retarget links at the three exact legacy package directories beside
this checkout. Remove never unlinks another checkout or a legacy link.
No package manager is invoked and no running server is restarted.
`;

function fail(message) { throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function plainDirectory(directory, { optional = false } = {}) {
  const info = stat(directory);
  if (!info && optional) return false;
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail(`Expected a real directory: ${directory}`);
  return true;
}
function plainFile(file) {
  const info = stat(file);
  if (!info || !info.isFile() || info.isSymbolicLink()) fail(`Expected a regular non-symlink file: ${file}`);
  return info;
}
function readJSON(text, file) {
  // JSON.parse errors can echo private values. Never forward those messages.
  try { return JSON.parse(text); }
  catch { fail(`Invalid JSON: ${file}`); }
}
function readPlainFile(file) {
  plainFile(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function validateProfile(profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) || profile === 'node_modules') {
    fail('Invalid profile name: use a single alphanumeric, dot, underscore or hyphen name');
  }
}
function normalizeHome(home) {
  if (typeof home !== 'string' || !home || /[\0\r\n]/.test(home)) fail('Invalid home path');
  if (home === '~') home = homedir();
  else if (home.startsWith('~/')) home = path.join(homedir(), home.slice(2));
  if (!path.isAbsolute(home)) fail('Home must be an absolute path (or ~/...)');
  // Canonicalize the explicitly chosen home; reject symlinks below that root.
  const resolved = realpathSync(home);
  plainDirectory(resolved);
  if (resolved === path.parse(resolved).root) fail('Refusing to use the filesystem root as DSH home');
  return resolved;
}

export function parseArgs(args, env = process.env) {
  const options = { home: env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'), profile: 'web', apply: false, remove: false, withPerf: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--home', '--profile', '--apply', '--dry-run', '--with-perf', '--remove', '--help'].includes(flag)) fail(`Unknown argument: ${flag}`);
    if (seen.has(flag)) fail(`Repeated argument: ${flag}`);
    seen.add(flag);
    if (flag === '--home' || flag === '--profile') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else if (flag === '--apply') options.apply = true;
    else if (flag === '--remove') options.remove = true;
    else if (flag === '--with-perf') options.withPerf = true;
    else if (flag === '--help') options.help = true;
  }
  if (seen.has('--apply') && seen.has('--dry-run')) fail('--apply and --dry-run are mutually exclusive');
  validateProfile(options.profile);
  return options;
}

function linkState(file) {
  const info = stat(file);
  if (!info) return null;
  if (!info.isSymbolicLink()) fail(`Refusing to overwrite a non-symlink: ${file}`);
  const raw = readlinkSync(file);
  return { raw, resolved: path.resolve(path.dirname(file), raw) };
}
function sameLink(a, b) { return a?.raw === b?.raw; }
function ownedDependency(value, source, profilePath) {
  if (typeof value !== 'string' || !/^(link:|file:)/.test(value)) return false;
  return path.resolve(profilePath, value.replace(/^(link:|file:)/, '')) === source;
}
function validateManifest(manifest, manifestPath) {
  if (!object(manifest) || (manifest.dependencies !== undefined && !object(manifest.dependencies)) ||
      !object(manifest.dsh) || !object(manifest.dsh.profile) ||
      !Array.isArray(manifest.dsh.profile.bundles) ||
      !manifest.dsh.profile.bundles.every((name) => typeof name === 'string')) {
    fail(`Expected dependencies object and dsh.profile.bundles string array: ${manifestPath}`);
  }
}

function plan(options) {
  const { profile = 'web', remove = false, withPerf = false } = options;
  validateProfile(profile);
  for (const key of ['apply', 'remove', 'withPerf']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') fail(`${key} must be a boolean`);
  }
  const repoRoot = realpathSync(options.repoRoot ?? REPO_ROOT);
  const home = normalizeHome(options.home ?? (process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')));
  const profilesPath = path.join(home, 'profiles');
  const profilePath = path.join(profilesPath, profile);
  // Backups must not accidentally be created inside the checkout.
  if (inside(repoRoot, profilePath)) fail('The profile (and its backups) must be outside the repository');
  plainDirectory(profilesPath);
  plainDirectory(profilePath);
  const manifestPath = path.join(profilePath, 'package.json');
  const manifestStat = plainFile(manifestPath);
  const original = readPlainFile(manifestPath);
  const manifest = readJSON(original, manifestPath);
  validateManifest(manifest, manifestPath);
  const activePackages = remove || withPerf ? PACKAGES : [PACKAGES[2]];
  const nodeModules = path.join(profilePath, 'node_modules');
  plainDirectory(nodeModules, { optional: true });
  if (activePackages.some(({ name }) => name.startsWith('@local/'))) {
    plainDirectory(path.join(nodeModules, '@local'), { optional: true });
  }
  const dependencies = { ...manifest.dependencies };
  const bundles = manifest.dsh.profile.bundles;
  const names = new Set(activePackages.map(({ name }) => name));
  const nextBundles = bundles.filter((name) => !names.has(name));
  if (!remove) {
    if (withPerf) {
      if (nextBundles.filter((name) => name === BASE).length !== 1) fail(`Perf install requires exactly one ${BASE} bundle: ${manifestPath}`);
      nextBundles.splice(nextBundles.indexOf(BASE), 0, PACKAGES[0].name, PACKAGES[1].name);
    }
    nextBundles.push(PACKAGES[2].name);
  }
  const bundleOrderChanged = JSON.stringify(bundles) !== JSON.stringify(nextBundles);
  const entries = activePackages.map(({ name, directory }) => {
    const source = path.join(repoRoot, 'packages', directory);
    if (!remove) {
      plainDirectory(path.join(repoRoot, 'packages'));
      plainDirectory(source);
      const sourceManifestPath = path.join(source, 'package.json');
      const sourceManifest = readJSON(readPlainFile(sourceManifestPath), sourceManifestPath);
      if (!object(sourceManifest) || sourceManifest.name !== name) fail(`Unexpected package name: ${sourceManifestPath}`);
    }
    const link = path.join(nodeModules, ...name.split('/'));
    const previousLink = linkState(link);
    const legacy = path.join(path.dirname(repoRoot), directory);
    if (previousLink && previousLink.resolved !== source && (remove || previousLink.resolved !== legacy)) {
      fail(`Refusing ${remove ? 'to remove' : 'to retarget'} a foreign symlink: ${link}`);
    }
    const dependencyPresent = Object.hasOwn(dependencies, name);
    if (remove && dependencyPresent && !ownedDependency(dependencies[name], source, profilePath)) {
      fail(`Refusing to remove a dependency not owned by this checkout: ${name} in ${manifestPath}`);
    }
    const dependencyChanged = remove ? dependencyPresent : dependencies[name] !== `link:${source}`;
    if (remove) delete dependencies[name];
    else dependencies[name] = `link:${source}`;
    const linkChanged = remove ? previousLink !== null : previousLink?.resolved !== source;
    // List managed names only; never echo unrelated bundle names or values.
    const positions = (list) => list.flatMap((value, index) => value === name ? [index] : []);
    const bundleChanged = JSON.stringify(positions(bundles)) !== JSON.stringify(positions(nextBundles));
    return { name, source, link, previousLink, dependencyChanged, bundleChanged, linkChanged };
  });
  const manifestChanged = bundleOrderChanged || entries.some((entry) => entry.dependencyChanged);
  const next = {
    ...manifest,
    ...(manifest.dependencies !== undefined || !remove ? { dependencies } : {}),
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: nextBundles } },
  };
  return {
    repoRoot, profilesPath, profilePath, nodeModules, manifestPath, manifestStat,
    original, next: `${JSON.stringify(next, null, 2)}\n`, remove,
    manifestChanged, entries, changed: manifestChanged || entries.some((entry) => entry.linkChanged),
    backupDirectory: path.join(profilePath, BACKUP_DIRECTORY),
  };
}

function assertSnapshot(p) {
  plainDirectory(p.profilesPath);
  plainDirectory(p.profilePath);
  plainDirectory(p.nodeModules, { optional: true });
  if (p.entries.some(({ name }) => name.startsWith('@local/'))) {
    plainDirectory(path.join(p.nodeModules, '@local'), { optional: true });
  }
  if (readPlainFile(p.manifestPath) !== p.original) fail(`Profile changed during planning: ${p.manifestPath}`);
  for (const entry of p.entries) {
    if (!sameLink(linkState(entry.link), entry.previousLink)) fail(`Link changed during planning: ${entry.link}`);
  }
}
function writeExclusive(file, contents, mode) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    // open's mode is filtered by umask; atomic manifest replacement must keep
    // the original permissions, while backup files are always exactly 0600.
    fchmodSync(fd, mode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function makeBackup(p) {
  plainDirectory(p.backupDirectory, { optional: true });
  if (!stat(p.backupDirectory)) mkdirSync(p.backupDirectory, { mode: 0o700 });
  const backup = path.join(p.backupDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  writeExclusive(backup, `${JSON.stringify({
    version: 1, operation: p.remove ? 'remove' : 'install', repository: p.repoRoot,
    manifestPath: p.manifestPath, manifestMode: p.manifestStat.mode & 0o777,
    manifest: p.original,
    links: p.entries.map(({ name, link, previousLink }) => ({ name, path: link, target: previousLink?.raw ?? null })),
  }, null, 2)}\n`, 0o600);
  return backup;
}
function apply(p) {
  assertSnapshot(p);
  // Refuse a redirected backup directory before changing anything.
  plainDirectory(p.backupDirectory, { optional: true });
  const backup = makeBackup(p);
  const modified = [];
  const createdDirectories = [];
  let temporaryManifest;
  try {
    assertSnapshot(p);
    for (const entry of p.entries.filter(({ linkChanged }) => linkChanged)) {
      if (!p.remove) {
        for (const directory of [p.nodeModules, ...(entry.name.startsWith('@') ? [path.dirname(entry.link)] : [])]) {
          if (!plainDirectory(directory, { optional: true })) {
            mkdirSync(directory);
            createdDirectories.push(directory);
          }
        }
      }
      if (!sameLink(linkState(entry.link), entry.previousLink)) fail(`Link changed before write: ${entry.link}`);
      if (entry.previousLink) unlinkSync(entry.link);
      // Record before symlink creation so a failure restores a legacy link too.
      modified.push(entry);
      if (!p.remove) symlinkSync(entry.source, entry.link, 'dir');
    }
    if (p.manifestChanged) {
      if (readPlainFile(p.manifestPath) !== p.original) fail(`Profile changed before write: ${p.manifestPath}`);
      temporaryManifest = path.join(p.profilePath, `.install-${randomUUID()}.tmp`);
      writeExclusive(temporaryManifest, p.next, p.manifestStat.mode & 0o777);
      renameSync(temporaryManifest, p.manifestPath);
      temporaryManifest = undefined;
    }
  } catch (error) {
    const rollbackErrors = [];
    if (temporaryManifest && stat(temporaryManifest)) {
      try { unlinkSync(temporaryManifest); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const entry of modified.reverse()) {
      try {
        const current = linkState(entry.link);
        if (current && current.resolved !== entry.source) fail(`Refusing rollback over changed link: ${entry.link}`);
        if (current) unlinkSync(entry.link);
        if (entry.previousLink) symlinkSync(entry.previousLink.raw, entry.link, 'dir');
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const directory of createdDirectories.reverse()) {
      try { rmdirSync(directory); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) fail(`Apply failed; manual recovery may be needed using backup: ${backup}`);
    throw error;
  }
  return backup;
}

/** Programmatic entry point; repoRoot supports isolated fixture checkouts. */
export function install(options = {}, log = (line) => process.stdout.write(`${line}\n`)) {
  const p = plan(options);
  const backupPath = p.changed && options.apply === true ? apply(p) : null;
  const changedPackages = [];
  for (const entry of p.entries) {
    if (!entry.linkChanged && !entry.dependencyChanged && !entry.bundleChanged) continue;
    changedPackages.push(entry.name);
    const locations = [];
    if (entry.dependencyChanged || entry.bundleChanged) locations.push(JSON.stringify(p.manifestPath));
    if (entry.linkChanged) locations.push(p.remove ? JSON.stringify(entry.link) : `${JSON.stringify(entry.link)} -> ${JSON.stringify(entry.source)}`);
    log(`${options.apply === true ? 'apply' : 'dry-run'} ${p.remove ? 'remove' : 'install'} ${entry.name}: ${locations.join('; ')}`);
  }
  if (backupPath) log(`backup: ${JSON.stringify(backupPath)}`);
  return { changed: p.changed, changedPackages, profilePath: p.profilePath, manifestPath: p.manifestPath, backupPath };
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) process.stdout.write(HELP);
    else install(options);
    return 0;
  } catch (error) {
    // Avoid printing JSON.parse excerpts, a manifest, or a full error stack.
    process.stderr.write(`install: ${error.message}\n`);
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
