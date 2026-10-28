import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { install, PACKAGES, parseArgs } from '../scripts/install.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const BASE = '@deepseek-ai/dsh-base';
const COPY = PACKAGES[2].name;
const PRIVATE = 'synthetic-private-setting-not-for-stdout';
const quiet = () => {};
const originalManifest = () => ({
  name: 'synthetic-profile', private: true,
  dependencies: { 'synthetic-other': 'link:./synthetic-other', 'unrelated-version': '^2.0.0' },
  devDependencies: { 'synthetic-dev': '^1.0.0' },
  custom: { privateSetting: PRIVATE },
  dsh: { arbitrary: { value: PRIVATE }, profile: {
    bundles: [BASE, '@deepseek-ai/dsh-web-app', 'synthetic-other'],
    localOptions: { privateSetting: PRIVATE },
  } },
});
function put(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
function json(file, value) { put(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJSON(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function exists(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function fixture(t, { profile = 'web', manifest = originalManifest(), copyOnly = false } = {}) {
  // Both checkout and home are disposable synthetic data, never real profiles.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-installer-test-')));
  t.after(() => {
    assert.equal(path.dirname(root), realpathSync(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-installer-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  const repoRoot = path.join(root, 'portable checkout');
  const home = path.join(root, 'synthetic home');
  const profilePath = path.join(home, 'profiles', profile);
  const manifestPath = path.join(profilePath, 'package.json');
  mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, path.join(repoRoot, 'scripts', 'install.mjs'));
  for (const entry of copyOnly ? [PACKAGES[2]] : PACKAGES) {
    json(path.join(repoRoot, 'packages', entry.directory, 'package.json'), {
      name: entry.name, private: true, dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    put(path.join(repoRoot, 'packages', entry.directory, 'cordis.patch.yml'), '[]\n');
  }
  json(manifestPath, manifest);
  put(path.join(profilePath, 'cordis.patch.yml'), `# ${PRIVATE}\n[]\n`);
  return { root, repoRoot, home, profile, profilePath, manifestPath,
    options: { repoRoot, home, profile },
    source: (entry) => path.join(repoRoot, 'packages', entry.directory),
    link: (entry) => path.join(profilePath, 'node_modules', ...entry.name.split('/')),
  };
}
function makeLink(file, target) {
  mkdirSync(path.dirname(file), { recursive: true });
  symlinkSync(target, file, 'dir');
}
function snapshot(directory) {
  const result = {};
  function walk(current) {
    const info = lstatSync(current);
    const key = path.relative(directory, current) || '.';
    result[key] = info.isSymbolicLink() ? ['link', readlinkSync(current)] :
      info.isDirectory() ? ['directory', info.mode & 0o777] : ['file', info.mode & 0o777, readFileSync(current, 'base64')];
    if (info.isDirectory()) for (const name of readdirSync(current).sort()) walk(path.join(current, name));
  }
  walk(directory);
  return result;
}
function cli(f, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(f.repoRoot, 'scripts', 'install.mjs'), '--home', f.home, ...args], {
    encoding: 'utf8', cwd: f.root, env: { ...process.env, DSH_HOME: f.home, ...env },
  });
  assert.ifError(result.error);
  return result;
}
function assertRejectedUnchanged(f, options, pattern) {
  const before = snapshot(f.root);
  assert.throws(() => install({ ...f.options, ...options }, quiet), pattern);
  assert.deepEqual(snapshot(f.root), before);
}
function backups(f) {
  const directory = path.join(f.profilePath, '.dsh-plugin-remote-improve-backups');
  return exists(directory) ? readdirSync(directory).map((name) => path.join(directory, name)) : [];
}

test('argument defaults are preview/copy only and respect DSH_HOME', () => {
  assert.deepEqual(parseArgs([], { DSH_HOME: '/synthetic/home' }), {
    home: '/synthetic/home', profile: 'web', apply: false, remove: false, withPerf: false,
  });
  assert.deepEqual(parseArgs(['--home', '/different/home', '--profile', 'custom-1', '--apply', '--with-perf', '--remove'], {}), {
    home: '/different/home', profile: 'custom-1', apply: true, remove: true, withPerf: true,
  });
  assert.equal(parseArgs(['--dry-run'], {}).apply, false);
  assert.equal(parseArgs(['--help'], {}).help, true);
});

test('reject unknown, ambiguous, missing and traversing arguments', () => {
  for (const args of [
    ['--unknown'], ['positional'], ['--apply=true'], ['--home=/tmp'], ['--'],
    ['--home'], ['--profile'], ['--home', '--apply'], ['--profile', ''],
    ['--apply', '--dry-run'], ['--apply', '--apply'], ['--profile', 'web', '--profile', 'other'],
    ['--profile', '../escape'], ['--profile', '..'], ['--profile', '.'], ['--profile', '/absolute'],
    ['--profile', 'a/b'], ['--profile', 'a\\b'], ['--profile', 'a\0b'], ['--profile', 'a b'],
    ['--profile', 'node_modules'],
  ]) assert.throws(() => parseArgs(args, {}), undefined, JSON.stringify(args));
});

test('full dry-run reports only managed packages/paths and changes no bytes', (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const lines = [];
  const result = install({ ...f.options, withPerf: true }, (line) => lines.push(line));
  assert.equal(result.changed, true);
  assert.equal(result.backupPath, null);
  assert.deepEqual(result.changedPackages, PACKAGES.map(({ name }) => name));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.startsWith('dry-run install ')));
  assert.ok(!lines.join('\n').includes(PRIVATE));
  assert.ok(!lines.join('\n').includes('synthetic-other'));
  assert.deepEqual(snapshot(f.root), before);
});

test('safe default installs only copy even without perf sources', (t) => {
  const f = fixture(t, { copyOnly: true });
  const result = install({ ...f.options, apply: true }, quiet);
  assert.deepEqual(result.changedPackages, [COPY]);
  const after = readJSON(f.manifestPath);
  assert.equal(after.dsh.profile.bundles.at(-1), COPY);
  assert.equal(readlinkSync(f.link(PACKAGES[2])), f.source(PACKAGES[2]));
  for (const entry of PACKAGES.slice(0, 2)) {
    assert.ok(!Object.hasOwn(after.dependencies, entry.name));
    assert.ok(!exists(f.link(entry)));
  }
});

test('default copy install preserves existing perf and unrelated scoped link', (t) => {
  const manifest = originalManifest();
  manifest.dependencies[PACKAGES[0].name] = 'link:./existing-perf';
  manifest.dsh.profile.bundles.unshift(PACKAGES[0].name);
  const f = fixture(t, { manifest });
  const external = path.join(f.root, 'synthetic-scope');
  mkdirSync(external);
  makeLink(path.join(f.profilePath, 'node_modules', '@local'), external);
  install({ ...f.options, apply: true }, quiet);
  const after = readJSON(f.manifestPath);
  assert.equal(after.dependencies[PACKAGES[0].name], 'link:./existing-perf');
  assert.deepEqual(after.dsh.profile.bundles, [...manifest.dsh.profile.bundles, COPY]);
  assert.equal(readlinkSync(path.join(f.profilePath, 'node_modules', '@local')), external);
});

test('full install preserves all unrelated data and backs up exact original before writing', (t) => {
  const f = fixture(t);
  chmodSync(f.manifestPath, 0o640);
  const original = readFileSync(f.manifestPath, 'utf8');
  const untouchedManifest = readJSON(f.manifestPath);
  const untouchedPatch = readFileSync(path.join(f.profilePath, 'cordis.patch.yml'), 'utf8');
  const unrelated = path.join(f.root, 'synthetic-other-source');
  mkdirSync(unrelated);
  const otherLink = path.join(f.profilePath, 'node_modules', 'synthetic-other');
  makeLink(otherLink, unrelated);
  const result = install({ ...f.options, withPerf: true, apply: true }, quiet);
  assert.ok(result.backupPath.startsWith(`${f.profilePath}${path.sep}`));
  assert.ok(!result.backupPath.startsWith(`${f.repoRoot}${path.sep}`));
  const backup = readJSON(result.backupPath);
  assert.equal(backup.manifest, original);
  assert.equal(backup.operation, 'install');
  assert.deepEqual(backup.links.map(({ target }) => target), [null, null, null]);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(result.backupPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.dirname(result.backupPath)).mode & 0o777, 0o700);
    assert.equal(lstatSync(f.manifestPath).mode & 0o777, 0o640);
  }
  const after = readJSON(f.manifestPath);
  for (const entry of PACKAGES) {
    assert.equal(after.dependencies[entry.name], `link:${f.source(entry)}`);
    assert.equal(readlinkSync(f.link(entry)), f.source(entry));
  }
  assert.equal(readlinkSync(otherLink), unrelated);
  assert.deepEqual(after.custom, untouchedManifest.custom);
  assert.deepEqual(after.devDependencies, untouchedManifest.devDependencies);
  assert.deepEqual(after.dsh.arbitrary, untouchedManifest.dsh.arbitrary);
  assert.deepEqual(after.dsh.profile.localOptions, untouchedManifest.dsh.profile.localOptions);
  assert.equal(after.dependencies['synthetic-other'], untouchedManifest.dependencies['synthetic-other']);
  assert.equal(after.dependencies['unrelated-version'], untouchedManifest.dependencies['unrelated-version']);
  assert.equal(readFileSync(path.join(f.profilePath, 'cordis.patch.yml'), 'utf8'), untouchedPatch);
  assert.deepEqual(after.dsh.profile.bundles, [PACKAGES[0].name, PACKAGES[1].name,
    ...untouchedManifest.dsh.profile.bundles, COPY]);
});

test('full install deduplicates managed bundles, fixes order, and puts copy after private bundles', (t) => {
  const manifest = originalManifest();
  manifest.dsh.profile.bundles = [COPY, 'synthetic-before', PACKAGES[1].name, BASE,
    'synthetic-middle', PACKAGES[0].name, COPY, 'synthetic-last', PACKAGES[1].name];
  const f = fixture(t, { manifest });
  install({ ...f.options, withPerf: true, apply: true }, quiet);
  assert.deepEqual(readJSON(f.manifestPath).dsh.profile.bundles, ['synthetic-before',
    PACKAGES[0].name, PACKAGES[1].name, BASE, 'synthetic-middle', 'synthetic-last', COPY]);
});

test('apply is byte-idempotent, quiet and creates no redundant backup', (t) => {
  const f = fixture(t);
  install({ ...f.options, withPerf: true, apply: true }, quiet);
  const before = snapshot(f.root);
  const lines = [];
  const result = install({ ...f.options, withPerf: true, apply: true }, (line) => lines.push(line));
  assert.equal(result.changed, false);
  assert.equal(result.backupPath, null);
  assert.deepEqual(lines, []);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(backups(f).length, 1);
});

test('order-only changes report only the affected managed package', (t) => {
  const f = fixture(t);
  install({ ...f.options, withPerf: true, apply: true }, quiet);
  const manifest = readJSON(f.manifestPath);
  manifest.dsh.profile.bundles.push('synthetic-last-private-bundle');
  json(f.manifestPath, manifest);
  const lines = [];
  const result = install({ ...f.options, withPerf: true }, (line) => lines.push(line));
  assert.deepEqual(result.changedPackages, [COPY]);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('synthetic-last-private-bundle'));
  assert.ok(!lines[0].includes(PACKAGES[0].name));
});

test('equivalent relative current-checkout symlinks are not rewritten', (t) => {
  const f = fixture(t);
  install({ ...f.options, withPerf: true, apply: true }, quiet);
  for (const entry of PACKAGES) {
    const link = f.link(entry);
    unlinkSync(link);
    symlinkSync(path.relative(path.dirname(link), f.source(entry)), link, 'dir');
  }
  const before = snapshot(f.root);
  assert.equal(install({ ...f.options, withPerf: true, apply: true }, quiet).changed, false);
  assert.deepEqual(snapshot(f.root), before);
});

test('custom profile and checkout paths containing spaces work through the CLI', (t) => {
  const f = fixture(t, { profile: 'custom-1' });
  const preview = cli(f, ['--profile', f.profile, '--with-perf']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /dry-run install/);
  assert.ok(!exists(f.link(PACKAGES[2])));
  const applied = cli(f, ['--profile', f.profile, '--with-perf', '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /apply install/);
  assert.ok(!applied.stdout.includes(PRIVATE));
  assert.equal(readlinkSync(f.link(PACKAGES[2])), f.source(PACKAGES[2]));
});

for (const kind of ['directory', 'file']) {
  test(`collision with a regular ${kind} rejects the whole plan without writes`, (t) => {
    const f = fixture(t);
    const target = f.link(PACKAGES[2]);
    if (kind === 'directory') mkdirSync(target, { recursive: true });
    else put(target, 'synthetic must survive');
    assertRejectedUnchanged(f, { withPerf: true, apply: true }, /non-symlink/);
    assertRejectedUnchanged(f, { withPerf: true }, /non-symlink/);
    assertRejectedUnchanged(f, { remove: true, apply: true }, /non-symlink/);
  });
}

test('unrelated/dangling foreign links are refused on install and remove', (t) => {
  const f = fixture(t);
  makeLink(f.link(PACKAGES[2]), path.join(f.root, 'other-checkout', 'dsh-copy-file-link'));
  assertRejectedUnchanged(f, { withPerf: true, apply: true }, /foreign symlink/);
  assertRejectedUnchanged(f, { remove: true, apply: true }, /foreign symlink/);
});

test('only exact sibling legacy directories may be retargeted; remove refuses legacy first', (t) => {
  const f = fixture(t);
  const originalTargets = [];
  for (const entry of PACKAGES) {
    const legacy = path.join(path.dirname(f.repoRoot), entry.directory);
    originalTargets.push(legacy);
    // Deliberately dangling: ownership is determined from the exact link path.
    makeLink(f.link(entry), legacy);
  }
  assertRejectedUnchanged(f, { remove: true, apply: true }, /foreign symlink/);
  const before = snapshot(f.root);
  install({ ...f.options, withPerf: true }, quiet);
  assert.deepEqual(snapshot(f.root), before);
  const result = install({ ...f.options, withPerf: true, apply: true }, quiet);
  for (const entry of PACKAGES) assert.equal(readlinkSync(f.link(entry)), f.source(entry));
  assert.deepEqual(readJSON(result.backupPath).links.map(({ target }) => target), originalTargets);
});

test('a similarly prefixed legacy directory is not an allowlist match', (t) => {
  const f = fixture(t);
  makeLink(f.link(PACKAGES[2]), path.join(path.dirname(f.repoRoot), 'dsh-copy-file-link-untrusted'));
  assertRejectedUnchanged(f, { apply: true }, /foreign symlink/);
});

test('remove previews safely, then removes all three owned packages and preserves everything else', (t) => {
  const f = fixture(t);
  const original = readJSON(f.manifestPath);
  install({ ...f.options, withPerf: true, apply: true }, quiet);
  const installed = readFileSync(f.manifestPath, 'utf8');
  const before = snapshot(f.root);
  const lines = [];
  install({ ...f.options, remove: true }, (line) => lines.push(line));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.startsWith('dry-run remove ')));
  assert.deepEqual(snapshot(f.root), before);
  const result = install({ ...f.options, remove: true, apply: true }, quiet);
  assert.equal(readJSON(result.backupPath).manifest, installed);
  assert.equal(readJSON(result.backupPath).operation, 'remove');
  assert.deepEqual(readJSON(f.manifestPath), original);
  for (const entry of PACKAGES) assert.ok(!exists(f.link(entry)));
  const after = snapshot(f.root);
  assert.equal(install({ ...f.options, remove: true, apply: true }, quiet).changed, false);
  assert.deepEqual(snapshot(f.root), after);
});

for (const remove of [false, true]) {
  test(`${remove ? 'remove' : 'install'} rolls back links if the atomic manifest write fails`, (t) => {
    const f = fixture(t);
    if (remove) install({ ...f.options, withPerf: true, apply: true }, quiet);
    else makeLink(f.link(PACKAGES[2]), path.join(path.dirname(f.repoRoot), PACKAGES[2].directory));
    const withoutBackups = (state) => Object.fromEntries(Object.entries(state).filter(([key]) =>
      !key.split(path.sep).includes('.dsh-plugin-remote-improve-backups')));
    const before = withoutBackups(snapshot(f.root));
    // Inject the failure in a child process, never patch other tests' fs APIs.
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.renameSync = () => { throw new Error('synthetic manifest write failure'); };
      syncBuiltinESMExports();
      const { install } = await import(${JSON.stringify(pathToFileURL(path.join(f.repoRoot, 'scripts', 'install.mjs')).href)});
      try {
        install(${JSON.stringify({ home: f.home, withPerf: true, apply: true, remove })}, () => {});
        throw new Error('expected injected failure');
      } catch (error) {
        if (error.message !== 'synthetic manifest write failure') throw error;
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      encoding: 'utf8', cwd: f.root, env: { ...process.env, DSH_HOME: f.home },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(withoutBackups(snapshot(f.root)), before);
    assert.equal(backups(f).length, remove ? 2 : 1);
  });
}

test('remove refuses dependency ownership mismatches even with no symlink', (t) => {
  const manifest = originalManifest();
  manifest.dependencies[COPY] = '^9.0.0';
  manifest.dsh.profile.bundles.push(COPY);
  const f = fixture(t, { manifest });
  assertRejectedUnchanged(f, { remove: true, apply: true }, /dependency not owned/);
});

test('remove tolerates a missing owned link and a broken checkout package', (t) => {
  const f = fixture(t);
  install({ ...f.options, apply: true }, quiet);
  unlinkSync(f.link(PACKAGES[2]));
  unlinkSync(path.join(f.source(PACKAGES[2]), 'package.json'));
  install({ ...f.options, remove: true, apply: true }, quiet);
  assert.ok(!Object.hasOwn(readJSON(f.manifestPath).dependencies, COPY));
});

test('unsafe home paths and programmatic argument types are rejected before writes', (t) => {
  const f = fixture(t);
  for (const home of ['relative/home', '/', '', 'a\0b', `${f.home}\n`]) {
    assertRejectedUnchanged(f, { home, apply: true }, /home|Home|root/);
  }
  for (const key of ['apply', 'remove', 'withPerf']) {
    assertRejectedUnchanged(f, { [key]: 'true' }, /must be a boolean/);
  }
});

for (const segment of ['profiles', 'profile', 'node_modules', 'scope', 'manifest', 'backup']) {
  test(`reject redirected ${segment} paths without touching the destination`, (t) => {
    const f = fixture(t);
    const outside = path.join(f.root, 'synthetic-outside');
    mkdirSync(outside);
    let target;
    if (segment === 'profiles') target = path.join(f.home, 'profiles');
    else if (segment === 'profile') target = f.profilePath;
    else if (segment === 'node_modules') target = path.join(f.profilePath, 'node_modules');
    else if (segment === 'scope') target = path.join(f.profilePath, 'node_modules', '@local');
    else if (segment === 'manifest') target = f.manifestPath;
    else target = path.join(f.profilePath, '.dsh-plugin-remote-improve-backups');
    // Move synthetic data only when required, then replace it with a redirect.
    if (segment === 'manifest') {
      const outsideFile = path.join(outside, 'package.json');
      copyFileSync(target, outsideFile);
      unlinkSync(target);
      makeLink(target, outsideFile);
    } else {
      if (exists(target)) {
        assert.ok(target.startsWith(`${f.root}${path.sep}`));
        rmSync(target, { recursive: true });
      }
      makeLink(target, outside);
    }
    assertRejectedUnchanged(f, { withPerf: true, apply: true }, /real directory|non-symlink/);
  });
}

test('profile backup path may never be inside the repository', (t) => {
  const f = fixture(t);
  const home = path.join(f.repoRoot, 'synthetic home');
  json(path.join(home, 'profiles', 'web', 'package.json'), originalManifest());
  assertRejectedUnchanged(f, { home, apply: true }, /outside the repository/);
});

test('missing profile manifest and invalid package name are explicit no-write failures', (t) => {
  const f = fixture(t);
  const sourceManifest = path.join(f.source(PACKAGES[2]), 'package.json');
  json(sourceManifest, { name: 'not-the-expected-package' });
  assertRejectedUnchanged(f, { apply: true }, /Unexpected package name/);
  unlinkSync(f.manifestPath);
  assertRejectedUnchanged(f, { apply: true }, /regular non-symlink file/);
});

test('symlinked package source and package manifest are rejected', (t) => {
  const f = fixture(t);
  const sourceManifest = path.join(f.source(PACKAGES[2]), 'package.json');
  const external = path.join(f.root, 'synthetic-external.json');
  copyFileSync(sourceManifest, external);
  unlinkSync(sourceManifest);
  makeLink(sourceManifest, external);
  assertRejectedUnchanged(f, { apply: true }, /regular non-symlink file/);
  unlinkSync(sourceManifest);
  const source = f.source(PACKAGES[2]);
  assert.ok(source.startsWith(`${f.root}${path.sep}`));
  rmSync(source, { recursive: true });
  makeLink(source, f.source(PACKAGES[0]));
  assertRejectedUnchanged(f, { apply: true }, /real directory/);
});

test('malformed/private manifest errors never echo original JSON to stdout or stderr', (t) => {
  const f = fixture(t);
  put(f.manifestPath, `{"private":"${PRIVATE}", BROKEN`);
  const before = snapshot(f.root);
  const result = cli(f, ['--apply']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Invalid JSON:/);
  assert.ok(!result.stderr.includes(PRIVATE));
  assert.deepEqual(snapshot(f.root), before);
});

test('manifest shape validation and perf base requirement prevent partial writes', (t) => {
  const f = fixture(t);
  for (const manifest of [[], {}, { ...originalManifest(), dependencies: [] },
    { ...originalManifest(), dsh: { profile: { bundles: [BASE, 42] } } }]) {
    json(f.manifestPath, manifest);
    assertRejectedUnchanged(f, { withPerf: true, apply: true }, /Expected dependencies/);
  }
  for (const bundles of [['synthetic-only'], [BASE, BASE]]) {
    const manifest = originalManifest();
    manifest.dsh.profile.bundles = bundles;
    json(f.manifestPath, manifest);
    assertRejectedUnchanged(f, { withPerf: true, apply: true }, /exactly one/);
  }
});

test('missing dependencies object is supported and default copy needs no base bundle', (t) => {
  const manifest = originalManifest();
  delete manifest.dependencies;
  manifest.dsh.profile.bundles = ['synthetic-custom'];
  const f = fixture(t, { manifest });
  install({ ...f.options, apply: true }, quiet);
  assert.deepEqual(readJSON(f.manifestPath).dsh.profile.bundles, ['synthetic-custom', COPY]);
  assert.equal(readJSON(f.manifestPath).dependencies[COPY], `link:${f.source(PACKAGES[2])}`);
});

test('CLI help and invalid options never access a real profile', (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const help = cli(f, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--with-perf/);
  const invalid = cli(f, ['--apply', '--dry-run']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /mutually exclusive/);
  assert.equal(invalid.stdout, '');
  assert.deepEqual(snapshot(f.root), before);
});
