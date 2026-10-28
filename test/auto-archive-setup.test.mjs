import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveFiles, verifyUpstream, prepareArtifact, previewConfig, parseSetupArgs, PIN } from '../scripts/setup-auto-archive.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/setup-auto-archive.mjs', import.meta.url));
const hash = (text) => createHash('sha256').update(text).digest('hex');
function put(file, value) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-archive-setup-test-')));
  t.after(() => {
    assert.equal(path.dirname(root), realpathSync(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-archive-setup-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'synthetic-source');
  const home = path.join(root, 'synthetic-home');
  const target = path.join(home, 'third-party', 'packages', 'synthetic-derived');
  const data = {
    'package.json': JSON.stringify({ name: PIN.name, version: PIN.upstreamVersion, type: 'module', author: 'synthetic-author', license: 'MIT', dependencies: { 'synthetic-dependency': '1.2.3' } }),
    'lib/index.js': 'export const synthetic = true;\n',
    'lib/client.js': 'globalThis.syntheticClient = true;\n',
    'README.md': '# Synthetic upstream\n',
    'LICENSE': 'Synthetic MIT license fixture\n',
    'cordis.patch.yml': '[]\n',
  };
  for (const [relative, text] of Object.entries(data)) put(path.join(source, relative), text);
  put(path.join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: {}, custom: 'synthetic-private-do-not-echo', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  const pin = { ...PIN, files: Object.fromEntries(Object.entries(data).map(([relative, text]) => [relative, hash(text)])) };
  const lock = JSON.stringify({ name: PIN.name, version: PIN.derivedVersion, packages: { '': {}, 'node_modules/synthetic-dependency': { version: '1.2.3' } } });
  const options = { pin, lock, hostPatch: (text) => `// synthetic host patch\n${text}`, clientPatch: (text) => `// synthetic client patch\n${text}` };
  const commands = [];
  const command = (name, args, cwd) => {
    commands.push({ name, args, cwd });
    if (args.includes('ci')) {
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(args.includes('--omit=dev'));
      put(path.join(cwd, 'node_modules/synthetic-dependency/package.json'), JSON.stringify({ version: '1.2.3' }));
    } else assert.ok(args.includes('--check'));
  };
  return { root, source, home, target, data, pin, options, command, commands };
}

test('setup arguments default to preview and reject unsafe or ambiguous options', () => {
  assert.deepEqual(parseSetupArgs([], { DSH_HOME: '/synthetic/dsh' }), { home: '/synthetic/dsh', profile: 'web', apply: false, remove: false });
  for (const args of [ ['--apply', '--dry-run'], ['--apply', '--apply'], ['--unknown'], ['--home'], ['--source', 'relative'], ['--profile', '../escape'], ['--profile', '.'], ['--profile', 'node_modules'], ['--home', '/synthetic\nhome'] ]) {
    assert.throws(() => parseSetupArgs(args, {}));
  }
});

test('derivation checks source hashes, retains authorship, and records exact provenance', (t) => {
  const f = fixture(t);
  const files = deriveFiles(f.source, f.options);
  const manifest = JSON.parse(files['package.json']);
  assert.equal(manifest.name, PIN.name);
  assert.equal(manifest.version, PIN.derivedVersion);
  assert.equal(manifest.author, 'synthetic-author');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.dependencies, { 'synthetic-dependency': '1.2.3' });
  assert.equal(manifest.dshRemoteImprove.upstreamCommit, PIN.commit);
  assert.equal(files.LICENSE, f.data.LICENSE);
  assert.match(files['lib/index.js'], /synthetic host patch/);
  assert.match(files['lib/client.js'], /synthetic client patch/);
  const marker = JSON.parse(files['UPSTREAM.json']);
  assert.equal(marker.generatedFiles['lib/index.js'], hash(files['lib/index.js']));
  assert.equal(readFileSync(path.join(f.source, 'lib/index.js'), 'utf8'), f.data['lib/index.js']);
});

test('modified, missing or redirected source files fail before building', (t) => {
  const f = fixture(t);
  put(path.join(f.source, 'lib/index.js'), 'synthetic-private-invalid-source');
  assert.throws(() => verifyUpstream(f.source, f.pin), /checksum mismatch: lib\/index.js/);
  assert.throws(() => prepareArtifact(f.source, f.target, { ...f.options, command: f.command }), /checksum mismatch/);
  assert.ok(!existsSync(f.target));
  put(path.join(f.source, 'lib/index.js'), f.data['lib/index.js']);
  const client = path.join(f.source, 'lib/client.js');
  assert.ok(realpathSync(client).startsWith(`${f.root}${path.sep}`));
  assert.equal(path.dirname(realpathSync(client)), path.join(f.source, 'lib'));
  rmSync(client);
  symlinkSync(path.join(f.source, 'lib/index.js'), client);
  assert.throws(() => verifyUpstream(f.source, f.pin), /regular file/);
});

test('artifact target must be explicit, absolute and outside this repository', (t) => {
  const f = fixture(t);
  const repository = fileURLToPath(new URL('..', import.meta.url));
  for (const target of ['relative-build', `${f.root}\ninvalid`, path.join(repository, 'forbidden-derived')]) {
    assert.throws(() => prepareArtifact(f.source, target, { ...f.options, command: f.command }), /absolute path outside/);
  }
  assert.equal(f.commands.length, 0);
});

test('artifact builds with locked dependencies and becomes a byte-idempotent immutable directory', (t) => {
  const f = fixture(t);
  prepareArtifact(f.source, f.target, { ...f.options, command: f.command });
  assert.equal(f.commands.length, 3);
  assert.ok(existsSync(path.join(f.target, 'UPSTREAM.json')));
  prepareArtifact(f.source, f.target, { ...f.options, command: () => assert.fail('existing build must not reinstall dependencies') });
  put(path.join(f.target, 'lib/client.js'), 'modified local build');
  assert.throws(() => prepareArtifact(f.source, f.target, { ...f.options, command: f.command }), /differs; refuse overwrite/);
});

test('dependency mismatch in an existing artifact is refused, not repaired under a running plugin', (t) => {
  const f = fixture(t);
  prepareArtifact(f.source, f.target, { ...f.options, command: f.command });
  put(path.join(f.target, 'node_modules/synthetic-dependency/package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.throws(() => prepareArtifact(f.source, f.target, { ...f.options, command: f.command }), /missing\/different dependencies/);
});

test('failed build removes only its fresh staging directory and leaves no registered profile changes', (t) => {
  const f = fixture(t);
  const profile = path.join(f.home, 'profiles/web/package.json');
  const before = readFileSync(profile, 'utf8');
  assert.throws(() => prepareArtifact(f.source, f.target, { ...f.options, command: () => { throw new Error('synthetic install failure'); } }), /synthetic install failure/);
  assert.ok(!existsSync(f.target));
  assert.deepEqual(readdirSync(path.dirname(f.target)), []);
  assert.equal(readFileSync(profile, 'utf8'), before);
});

test('build refuses redirected parent directories', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.home, 'third-party'));
  assert.throws(() => prepareArtifact(f.source, f.target, { ...f.options, command: f.command }), /real directory/);
  assert.deepEqual(readdirSync(outside), []);
});

test('preview creates no config; apply seeds private safe defaults exactly once', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'storages/auto-archive/config.json');
  assert.deepEqual(previewConfig(f.home), { created: false, dryRun: true });
  assert.ok(!existsSync(file));
  assert.deepEqual(previewConfig(f.home, true), { created: true, dryRun: true });
  const value = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(value.dryRun, true);
  assert.equal(value.keepPinned, true);
  assert.equal(value.includeSubagents, false);
  assert.equal(value.idleDays, 14);
  if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o600);
  value.idleDays = 23;
  put(file, JSON.stringify(value));
  const before = readFileSync(file, 'utf8');
  assert.equal(previewConfig(f.home, true).created, false);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('existing REAL mode and malformed private config refuse unattended setup without echoing contents', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, 'storages/auto-archive/config.json');
  put(file, JSON.stringify({ dryRun: false, idleDays: 17 }));
  const before = readFileSync(file, 'utf8');
  assert.throws(() => previewConfig(f.home, true), /REAL mode/);
  assert.equal(readFileSync(file, 'utf8'), before);
  put(file, '{"synthetic-private-secret": BROKEN');
  assert.throws(() => previewConfig(f.home, true), (error) => /Invalid JSON/.test(error.message) && !error.message.includes('synthetic-private-secret'));
});

test('CLI default preview neither downloads upstream nor mutates a synthetic profile', (t) => {
  const f = fixture(t);
  const profile = path.join(f.home, 'profiles/web/package.json');
  const before = readFileSync(profile, 'utf8');
  const result = spawnSync(process.execPath, [SCRIPT, '--home', f.home], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run:/);
  assert.ok(!result.stdout.includes('synthetic-private-do-not-echo'));
  assert.equal(readFileSync(profile, 'utf8'), before);
  assert.ok(!existsSync(path.join(f.home, 'third-party')));
  assert.ok(!existsSync(path.join(f.home, 'storages')));
});
