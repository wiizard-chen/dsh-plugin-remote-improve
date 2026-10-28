#!/usr/bin/env node
/** Optional/full-build smoke: real derived code and deps, fake services, disposable DSH home. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const artifact = process.argv[2];
assert.ok(artifact && path.isAbsolute(artifact), 'Provide an absolute derived package directory');
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-archive-runtime-smoke-')));
const oldHome = process.env.DSH_HOME;
const disposers = [];
process.env.DSH_HOME = home;
try {
  const plugin = await import(pathToFileURL(path.join(artifact, 'lib/index.js')).href);
  const manifest = JSON.parse(readFileSync(path.join(artifact, 'package.json'), 'utf8'));
  assert.ok(manifest.version.includes('-remote.'), 'Never smoke/register an unmodified upstream accidentally');
  const routes = new Map();
  const archived = new Set();
  const archiveCalls = [];
  const old = Date.now() - 40 * 86400000;
  const snapshots = ['old', 'pinned', 'live', 'active', 'recent', 'subagent'].map((kind) => ({
    header: { id: `synthetic-${kind}`, cwd: '/synthetic/project', createdAt: kind === 'recent' ? Date.now() : old, delegationDepth: kind === 'subagent' ? 1 : 0 },
  }));
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return this[name]; },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    inject(names, callback) { assert.ok(names.includes('connection')); callback(this); },
    connection: {
      requestRejection(req) { return req.headers.role === 'anonymous' ? 401 : req.headers.role === 'untrusted' ? 403 : undefined; },
      admit(req) { return { peer: { principal: { kind: req.headers.role === 'owner' ? 'owner' : 'external' } } }; },
    },
    webServer: {
      register(route) {
        assert.ok(!routes.has(route.path));
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archived]; },
      pinnedSessionIds: ['synthetic-pinned'],
      async archiveSession(id, options) {
        assert.equal(options, undefined, 'Must never use stopActivity to archive active work');
        archiveCalls.push(id);
        archived.add(id);
      },
      async unarchiveSession(id) { archived.delete(id); },
    },
    sessions: { get(id) { return id === 'synthetic-live' ? {} : undefined; } },
    sessionPersistence: { async list() { return snapshots; } },
    async waterfall(_name, { sessionId }) { return sessionId === 'synthetic-active' ? ['synthetic-busy'] : []; },
  };
  plugin.apply(ctx, { enabled: true, idleDays: 14, dryRun: true, keepPinned: true, includeSubagents: false, intervalHours: 12, startupDelayMs: 60000, excludeCwdSubstrings: [] });
  assert.equal(routes.size, 5);
  async function request(suffix, { role = 'owner', method = 'GET', body, raw } = {}) {
    const payload = raw ?? (body === undefined ? '' : JSON.stringify(body));
    const req = {
      method, url: `/api/dsh-auto-archive${suffix}`, headers: { role },
      async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload); },
    };
    const res = {
      status: undefined, data: undefined,
      writeHead(status) { this.status = status; },
      end(text) { this.data = JSON.parse(text); },
    };
    const handler = routes.get(req.url.split('?')[0]);
    assert.ok(handler, `Missing route ${suffix}`);
    await handler(req, res);
    return res;
  }
  for (const suffix of ['/status', '/settings', '/run', '/revert', '/history']) {
    assert.equal((await request(suffix, { role: 'anonymous' })).status, 401);
    assert.equal((await request(suffix, { role: 'untrusted' })).status, 403);
    assert.equal((await request(suffix, { role: 'external' })).status, 403);
  }
  assert.equal(archiveCalls.length, 0);
  let settings = await request('/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.data.value.dryRun, true);
  let scan = await request('/run', { method: 'POST', body: {} });
  assert.equal(scan.status, 200);
  assert.equal(scan.data.result.planned, 1);
  assert.equal(scan.data.result.archived, 0);
  assert.equal(archiveCalls.length, 0);
  for (const body of [{ dryRun: false }, { allowLive: true }, { allowDisabled: true }, { idleDays: 0.00001 }, { onlySessionId: 'synthetic-old' }]) {
    assert.equal((await request('/run', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/run', { method: 'POST', raw: '{bad json' })).status, 400);
  assert.equal(archiveCalls.length, 0);
  settings = await request('/settings');
  const changed = await request('/settings', { method: 'POST', body: { patch: { idleDays: 30, dryRun: false }, expectedRevision: settings.data.revision } });
  assert.equal(changed.status, 200);
  scan = await request('/run', { method: 'POST', body: {} });
  assert.equal(scan.data.result.archived, 1);
  assert.deepEqual(archiveCalls, ['synthetic-old']);
  const reverted = await request('/revert', { method: 'POST', body: {} });
  assert.equal(reverted.status, 200);
  assert.equal(archived.size, 0);
  const disabled = await request('/settings', { method: 'POST', body: { patch: { enabled: false } } });
  assert.equal(disabled.status, 200);
  const stoppedScan = await request('/run', { method: 'POST', body: {} });
  assert.equal(stoppedScan.data.result.skipped, 'disabled');
  assert.equal(archiveCalls.length, 1);
  for (const dispose of disposers.splice(0).reverse()) dispose();
  assert.equal(routes.size, 0);
  console.log(`Derived ${manifest.version} runtime smoke passed: owner-only routes, preview lock, configurable threshold, synthetic archive/undo, and protected active/live/pinned sessions. No real profile or sessions accessed.`);
} finally {
  for (const dispose of disposers.reverse()) dispose();
  if (oldHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldHome;
  assert.equal(path.dirname(home), realpathSync(tmpdir()));
  assert.ok(path.basename(home).startsWith('dsh-archive-runtime-smoke-'));
  rmSync(home, { recursive: true, force: true });
}
