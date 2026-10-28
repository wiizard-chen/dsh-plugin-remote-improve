import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  patchHost, patchClient, applyEdits, HOST_EDITS, CLIENT_EDITS,
  nativeRequestRejection, safeRunConfig, startTimerLoop,
} from '../integrations/auto-archive/patch.mjs';

const getEdit = (name) => {
  const edit = HOST_EDITS.find((entry) => entry.name === name);
  assert.ok(edit, `missing patch: ${name}`);
  return edit;
};
const before = (name) => getEdit(name).before;
const select = (...names) => names.map(getEdit);
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// These are only matched fragments, not a vendored upstream engine.
function syntheticSource(edits) {
  return edits.map((entry) => Array(entry.count).fill(entry.before).join('\n')).join('\n/* synthetic boundary */\n');
}

test('host/client transforms are pure and reject missing, duplicated and double-patched anchors', () => {
  const source = syntheticSource(HOST_EDITS);
  const patched = patchHost(source);
  assert.notEqual(patched, source);
  assert.equal(source, syntheticSource(HOST_EDITS));
  assert.equal(patched.split('const rejection = nativeRequestRejection(webCtx, req);').length - 1, 5);
  assert.ok(patched.includes("ctx.inject(['webServer', 'connection']"));
  assert.ok(!patched.includes('isLoopbackRequest'));
  assert.throws(() => patchHost(patched), /expected 1 matches, found 0/);
  const guard = before('route-guards');
  assert.throws(() => patchHost(source.replace(guard, '/* drift */')), /route-guards.*expected 5 matches, found 4/);
  assert.throws(() => patchHost(source + '\n' + guard), /route-guards.*expected 5 matches, found 6/);
  assert.throws(() => patchHost(source + '\n' + before('runner-state')), /runner-state.*expected 1 matches, found 2/);
  assert.throws(() => patchClient('/* changed upstream */'), /deployment-base/);
  const client = patchClient(CLIENT_EDITS[0].before);
  assert.throws(() => patchClient(client), /expected 1 matches, found 0/);
  assert.throws(() => patchClient(42), /source must be a string/);
});

test('the patched browser API follows root, remote subpath, query and escaped base paths', () => {
  const evaluate = new Function('document', 'URL', patchClient(CLIENT_EDITS[0].before) + '\nreturn API;');
  for (const [baseURI, prefix] of [
    ['https://example.test/', '/api/dsh-auto-archive'],
    ['https://example.test/dsh/', '/dsh/api/dsh-auto-archive'],
    ['https://example.test/nested/dsh/?q=1#fragment', '/nested/dsh/api/dsh-auto-archive'],
    ['https://example.test/a%20b/dsh/', '/a%20b/dsh/api/dsh-auto-archive'],
  ]) {
    const api = evaluate({ baseURI }, URL);
    assert.equal(api, prefix);
    for (const route of ['/settings', '/status', '/run', '/revert', '/history?limit=50']) {
      const resolved = new URL(api + route, baseURI);
      assert.equal(resolved.origin, 'https://example.test');
      assert.ok(resolved.pathname.startsWith(prefix + '/'));
    }
  }
});

test('native request rejection preserves service receiver/request and handles only native result types', () => {
  const req = { headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' } };
  for (const expected of [undefined, 401, 403]) {
    const connection = {
      requestRejection(actual) { assert.equal(this, connection); assert.equal(actual, req); return expected; },
      admit(actual) { assert.equal(this, connection); assert.equal(actual, req); return { peer: { principal: { kind: 'owner' } } }; },
    };
    assert.equal(nativeRequestRejection({ connection }, req), expected);
  }
  for (const invalid of [null, false, true, 200, 500, '401', Promise.resolve(undefined)]) {
    assert.equal(nativeRequestRejection({ connection: { requestRejection: () => invalid } }, req), 503);
  }
  assert.equal(nativeRequestRejection({}, req), 503);
  assert.equal(nativeRequestRejection(null, req), 503);
  assert.equal(nativeRequestRejection({ connection: {} }, req), 503);
  assert.equal(nativeRequestRejection({ connection: { requestRejection() { throw new Error('synthetic auth failure'); } } }, req), 503);
  assert.equal(nativeRequestRejection({ get connection() { throw new Error('synthetic unavailable service'); } }, req), 503);
});

test('native auth requires an owner and fails closed for missing/invalid admissions', async () => {
  const req = { headers: {} };
  const ownerCheck = () => undefined;
  for (const kind of ['agent', 'api', 'delegate', 'unknown']) {
    const connection = { requestRejection: ownerCheck, admit: () => ({ peer: { principal: { kind } } }) };
    assert.equal(nativeRequestRejection({ connection }, req), 403);
    const fixture = makeRoutes(connection);
    for (const route of fixture.routes.values()) { const res = {}; await route.handler(req, res); assert.equal(res.status, 403); }
    assert.equal(fixture.touched(), 0);
    fixture.dispose();
  }
  for (const admission of [undefined, null, {}, { peer: {} }, { peer: { principal: {} } }, Promise.resolve({ peer: { principal: { kind: 'owner' } } })]) {
    assert.equal(nativeRequestRejection({ connection: { requestRejection: ownerCheck, admit: () => admission } }, req), 503);
  }
  assert.equal(nativeRequestRejection({ connection: { requestRejection: ownerCheck } }, req), 503);
  assert.equal(nativeRequestRejection({ connection: { requestRejection: ownerCheck, admit() { throw new Error('synthetic admission failure'); } } }, req), 503);
  for (const rejection of [401, 403]) {
    assert.equal(nativeRequestRejection({ connection: { requestRejection: ownerCheck, admit: () => ({ rejection }) } }, req), rejection);
  }
});

function makeRoutes(connection) {
  const routes = new Map();
  const dependencies = [];
  const disposed = [];
  let touched = 0;
  const webCtx = {
    connection,
    effect(fn) { disposed.push(fn()); },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
    },
  };
  const ctx = { inject(names, fn) { dependencies.push(...names); fn(webCtx); } };
  const writeJson = (res, status, body) => { res.status = status; res.body = body; };
  // The helper handles status, while all four other handlers have their own guard.
  const direct = ['settings', 'run', 'revert', 'history'].map((name) => `
    server.register({ path: '/api/dsh-auto-archive/${name}', handler: async (req, res) => {
      ${before('route-guards')}
      touched();
      return writeJson(res, 200, { ok: true });
    } });`).join('\n');
  const source = `${before('route-injection')}
    webCtx.effect(() => {
      const server = webCtx.webServer;
      const json = async (req, res, init, makeBody) => {
        ${before('route-guards')}
        return writeJson(res, init, await makeBody());
      };
      server.register({ path: '/api/dsh-auto-archive/status', handler: async (req, res) => json(req, res, 200, async () => { touched(); return { ok: true }; }) });
      ${direct}
      return () => { for (const route of [...routes.values()]) routes.delete(route.path); };
    });
  });`;
  const patched = applyEdits(source, select('route-injection', 'route-guards'));
  new Function('ctx', 'nativeRequestRejection', 'writeJson', 'touched', 'routes', patched)(ctx, nativeRequestRejection, writeJson, () => touched++, routes);
  assert.deepEqual(dependencies, ['webServer', 'connection']);
  assert.equal(routes.size, 5);
  return { routes, touched: () => touched, dispose: () => disposed.reverse().forEach((fn) => fn?.()) };
}

test('all five routes deny anonymous loopback/proxy requests and trust failures before touching data', async () => {
  for (const expected of [401, 403, 503]) {
    const connection = expected === 503 ? undefined : { requestRejection: () => expected };
    const fixture = makeRoutes(connection);
    for (const route of fixture.routes.values()) {
      const res = {};
      await route.handler({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' } }, res);
      assert.equal(res.status, expected, route.path);
      assert.equal(res.body.ok, false);
    }
    assert.equal(fixture.touched(), 0);
    fixture.dispose();
    assert.equal(fixture.routes.size, 0);
  }
});

test('all five routes allow native-authenticated remote requests and fail closed if auth throws', async () => {
  let authorized = true;
  const fixture = makeRoutes({ requestRejection(req) {
    assert.equal(req.socket.remoteAddress, '203.0.113.10');
    if (!authorized) throw new Error('synthetic unavailable auth');
    return undefined;
  }, admit: () => ({ peer: { principal: { kind: 'owner' } } }) });
  const req = { socket: { remoteAddress: '203.0.113.10' }, headers: {} };
  for (const route of fixture.routes.values()) { const res = {}; await route.handler(req, res); assert.equal(res.status, 200); }
  assert.equal(fixture.touched(), 5);
  authorized = false;
  for (const route of fixture.routes.values()) { const res = {}; await route.handler(req, res); assert.equal(res.status, 503); }
  assert.equal(fixture.touched(), 5);
  fixture.dispose();
});

test('manual runs accept only boolean dryRun, protect saved dry-run mode, and allow saved real mode', () => {
  const base = { enabled: true, dryRun: true, idleDays: 14 };
  const snapshot = { ...base };
  assert.equal(safeRunConfig(base).dryRun, true);
  assert.equal(safeRunConfig(base, {}).dryRun, true);
  assert.equal(safeRunConfig(base, { dryRun: true }).dryRun, true);
  assert.throws(() => safeRunConfig(base, { dryRun: false }), /save dryRun=false/);
  for (const overrides of [null, [], false, 0, 'bad', { dryRun: null }, { dryRun: 'false' }, { dryRun: 0 }, { dryRun: undefined }]) {
    assert.throws(() => safeRunConfig(base, overrides), TypeError);
  }
  for (const key of ['allowLive', 'allowDisabled', 'idleDays', 'onlySessionId', 'debugBypass']) {
    assert.throws(() => safeRunConfig(base, { [key]: true }), /only the dryRun field/);
  }
  assert.deepEqual(base, snapshot);
  const live = { ...base, dryRun: false };
  assert.equal(safeRunConfig(live, {}).dryRun, false);
  assert.equal(safeRunConfig(live, { dryRun: false }).dryRun, false);
  assert.equal(safeRunConfig(live, { dryRun: true }).dryRun, true);
  assert.equal(safeRunConfig({ ...live, enabled: false }).enabled, false);
});

function request(raw = '') {
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = 'POST';
  req.headers = {};
  return req;
}
function makeRunRoute(base, ready = Promise.resolve()) {
  const calls = [];
  const runner = { async runOnce(trigger, overrides) { calls.push({ trigger, overrides }); return { ok: true, dryRun: safeRunConfig(base, overrides).dryRun }; } };
  const body = `return async (req, res) => {
    ${before('route-guards')}
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false });
    let body = {};
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    ${before('run-json')}
    ${before('run-validation')}
    return writeJson(res, 200, { ok: result.ok !== false, result });
  };`;
  const patched = applyEdits(body, [{ ...getEdit('route-guards'), count: 1 }, ...select('run-json', 'run-validation')]);
  const webCtx = { connection: { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) } };
  const writeJson = (res, status, data) => { res.status = status; res.body = data; };
  const handler = new Function('webCtx', 'nativeRequestRejection', 'safeRunConfig', 'runner', 'resolveConfig', 'configReady', 'writeJson', patched)(
    webCtx, nativeRequestRejection, safeRunConfig, runner, () => base, ready, writeJson,
  );
  return { calls, handler };
}

test('patched run handler rejects bad JSON/debug bypass and does not affect empty revert semantics', async () => {
  const fixture = makeRunRoute({ enabled: true, dryRun: true });
  for (const raw of ['{', 'null', '[]', 'true', '"bad"', '{"dryRun":"false"}', '{"dryRun":false}', '{"allowLive":true}', '{"allowDisabled":true}', '{"idleDays":1}', '{"onlySessionId":"synthetic"}']) {
    const res = {};
    await fixture.handler(request(raw), res);
    assert.equal(res.status, 400, raw);
  }
  assert.equal(fixture.calls.length, 0);
  for (const raw of ['', '{}', '{"dryRun":true}']) {
    const res = {};
    await fixture.handler(request(raw), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.result.dryRun, true);
  }
  assert.equal(fixture.calls.length, 3);
  const untouched = 'catch { /* 空 body = 撤销最近一次整批 */ }';
  assert.ok(patchHost(syntheticSource(HOST_EDITS) + '\n' + untouched).includes(untouched));
});

test('patched run handler waits for loaded config and supports real archiving after settings opt-in', async () => {
  const loaded = deferred();
  const config = { enabled: true, dryRun: false };
  const fixture = makeRunRoute(config, loaded.promise);
  const res = {};
  const pending = fixture.handler(request('{"dryRun":false}'), res);
  await tick();
  assert.equal(fixture.calls.length, 0);
  config.dryRun = true;
  loaded.resolve();
  await pending;
  assert.equal(res.status, 400);
  config.dryRun = false; // This is the same saved-setting transition used by UI.
  const live = {};
  await fixture.handler(request('{}'), live);
  assert.equal(live.status, 200);
  assert.equal(live.body.result.dryRun, false);
});

function fakeTimers() {
  let next = 0;
  const pending = new Map();
  const scheduled = [];
  const cleared = [];
  const timers = {
    setTimeout(fn, delay) {
      const handle = { id: next++, unref() { handle.unrefed = true; } };
      pending.set(handle, fn);
      scheduled.push({ handle, delay, fn });
      return handle;
    },
    clearTimeout(handle) { cleared.push(handle); pending.delete(handle); },
  };
  return { timers, pending, scheduled, cleared, fire() { const [handle, fn] = pending.entries().next().value; pending.delete(handle); fn(); } };
}

test('timer disposal clears pending startup and stale callbacks cannot run or rearm', async () => {
  const clock = fakeTimers();
  let runs = 0, stops = 0;
  const dispose = startTimerLoop({ runOnce: async () => runs++, stop: () => stops++ }, () => ({ startupDelayMs: 5, intervalHours: 12 }), clock.timers);
  assert.equal(clock.scheduled[0].delay, 5);
  assert.equal(clock.scheduled[0].handle.unrefed, true);
  const stale = clock.scheduled[0].fn;
  dispose(); dispose(); stale();
  await tick();
  assert.equal(runs, 0);
  assert.equal(stops, 1);
  assert.equal(clock.pending.size, 0);
  assert.equal(clock.cleared.length, 1);
  assert.equal(clock.scheduled.length, 1);
});

test('in-flight timer completion cannot resurrect an unloaded timer', async () => {
  const clock = fakeTimers();
  const work = deferred();
  let runs = 0, stops = 0;
  const dispose = startTimerLoop({ runOnce: () => { runs++; return work.promise; }, stop: () => stops++ }, () => ({ startupDelayMs: 0, intervalHours: 1 }), clock.timers);
  clock.fire(); await tick();
  assert.equal(runs, 1);
  dispose(); work.resolve(); await tick();
  assert.equal(stops, 1);
  assert.equal(clock.pending.size, 0);
  assert.equal(clock.scheduled.length, 1);
});

test('timer waits for stored configuration and disposal during that wait cancels the run', async () => {
  const clock = fakeTimers();
  const loaded = deferred();
  let runs = 0;
  const dispose = startTimerLoop({ runOnce: async () => runs++, stop() {} }, () => ({ startupDelayMs: 0, intervalHours: 1 }), clock.timers, loaded.promise);
  clock.fire(); await tick();
  assert.equal(runs, 0);
  dispose(); loaded.resolve(); await tick();
  assert.equal(runs, 0);
  assert.equal(clock.scheduled.length, 1);
});

test('normal timer completion schedules with current interval and timer id zero is cleared', async () => {
  const clock = fakeTimers();
  const config = { startupDelayMs: 3, intervalHours: 1 };
  const dispose = startTimerLoop({ runOnce: async () => {}, stop() {} }, () => config, clock.timers);
  clock.fire(); config.intervalHours = 2; await tick();
  assert.equal(clock.scheduled[1].delay, 2 * 60 * 60 * 1000);
  dispose(); assert.equal(clock.pending.size, 0);
  const cleared = [];
  startTimerLoop({ runOnce() {}, stop() {} }, () => config, { setTimeout: () => 0, clearTimeout: (id) => cleared.push(id) })();
  assert.deepEqual(cleared, [0]);
});

// A small synthetic engine contains only lifecycle and write boundaries under
// patch; eligibility/date selection stays upstream, not reimplemented here.
function runnerFactory() {
  const source = `${before('policy-helpers')}
    const storeDir = join(dshHome(), 'storages', 'auto-archive');
${before('runner-state')}
${before('audit-entry')}join(storeDir, 'audit.log'), JSON.stringify(line) + '\\n', 'utf8');
        } catch (error) { throw error; }
    };
${before('revert-entry')}
        const ids = sessionId ? [sessionId] : registry.archivedSessionIds;
        const archived = new Set(registry.archivedSessionIds);
        const reverted = [];
${before('revert-loop')}
            await registry.unarchiveSession(id);
            reverted.push(id);
        }
        return { reverted };
    }
    async function runOnce(trigger, overrides) {
${before('run-policy')}
        if (running) return { ok: false, skipped: 'already-running' };
        running = true;
        const result = { ok: true, planned: 0, archived: 0 };
        try {
            const registry = getService(ctx, 'workspaceRegistry');
            const persistence = getService(ctx, 'sessionPersistence');
            const sessionsService = ctx.sessions;
            const snapshots = await persistence.list();
${before('scan-loop')}
                const id = header.id;
${before('remove-session-bypass')}
                const skip = () => {};
${before('remove-debug-comment')}
                try {
${before('remove-live-bypass')}
                } catch { /* synthetic service probe */ }
                await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => []);
                const entry = { sessionId: id };
${before('dry-run-current-policy')}
                    await audit({ action: 'planned', ...entry });
                    continue;
                }
${before('archive-boundary')}
                    result.archived++;
                    await audit({ action: 'archived', ...entry });
                } catch (error) { throw error; }
            }
${before('status-boundary')}${before('status-boundary-close')}
                throw error;
            }
            lastResult = result;
            return result;
        } finally { running = false; }
    }
${before('runner-stop')}
        getStatus: () => ({ lastResult, running }),
    };
}`;
  const names = ['policy-helpers', 'runner-state', 'audit-entry', 'revert-entry', 'revert-loop', 'run-policy', 'scan-loop', 'remove-session-bypass', 'remove-debug-comment', 'remove-live-bypass', 'dry-run-current-policy', 'archive-boundary', 'status-boundary', 'status-boundary-close', 'runner-stop'];
  const patched = applyEdits(source, select(...names));
  return new Function('dshHome', 'getService', 'join', 'mkdir', 'appendFile', 'writeFile', patched + '\nreturn makeRunner;');
}

function runnerFixture(t, options = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-archive-compat-')));
  t.after(() => {
    assert.equal(path.dirname(home), realpathSync(tmpdir()));
    assert.ok(path.basename(home).startsWith('dsh-archive-compat-'));
    rmSync(home, { recursive: true, force: true });
  });
  const config = { enabled: true, dryRun: false, ...options.config };
  const calls = { list: 0, archive: [], unarchive: [], writes: [] };
  const registry = {
    archivedSessionIds: [],
    async archiveSession(id) { calls.archive.push(id); await options.archive?.(id); registry.archivedSessionIds.push(id); },
    async unarchiveSession(id) { calls.unarchive.push(id); registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id); },
  };
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: { async list() { calls.list++; return options.list ? options.list() : ['synthetic-a', 'synthetic-b'].map((id) => ({ header: { id } })); } },
    sessions: { get: (id) => options.live?.has(id) ? {} : undefined },
    waterfall: async (...args) => options.activity ? options.activity(...args) : [],
  };
  const deps = ['mkdir', 'appendFile', 'writeFile'].map((name) => async (...args) => { calls.writes.push({ operation: name, file: args[0] }); return fs[name](...args); });
  const makeRunner = runnerFactory()(() => home, (context, name) => context[name], path.join, ...deps);
  return { home, config, calls, registry, runner: makeRunner(ctx, () => config) };
}

test('synthetic runner preserves disabled/live protection and permits deliberate real mode', async (t) => {
  const f = runnerFixture(t, { config: { enabled: false }, live: new Set(['synthetic-b']) });
  assert.equal((await f.runner.runOnce('api')).skipped, 'disabled');
  assert.equal(f.calls.list, 0);
  await assert.rejects(f.runner.runOnce('api', { allowDisabled: true }), /only the dryRun field/);
  f.config.enabled = true;
  const result = await f.runner.runOnce('api', { dryRun: false });
  assert.equal(result.archived, 1);
  assert.deepEqual(f.calls.archive, ['synthetic-a']);
  assert.ok(existsSync(path.join(f.home, 'storages/auto-archive/status.json')));
});

test('synthetic runner keeps saved dry-run mode and accepts UI-style transition to real mode', async (t) => {
  const f = runnerFixture(t, { config: { dryRun: true } });
  await assert.rejects(f.runner.runOnce('api', { dryRun: false }), /save dryRun=false/);
  assert.equal((await f.runner.runOnce('api')).planned, 2);
  assert.deepEqual(f.calls.archive, []);
  const auditFile = path.join(f.home, 'storages/auto-archive/audit.log');
  assert.equal(readFileSync(auditFile, 'utf8').trim().split('\n').length, 2);
  f.config.dryRun = false;
  assert.equal((await f.runner.runOnce('api')).archived, 2);
});

test('dispose during persistence listing prevents all subsequent archive/audit/status writes', async (t) => {
  const list = deferred();
  const f = runnerFixture(t, { list: () => list.promise });
  const pending = f.runner.runOnce('timer');
  await tick(); f.runner.stop();
  list.resolve([{ header: { id: 'synthetic-a' } }]);
  await pending;
  assert.deepEqual(f.calls.archive, []);
  assert.deepEqual(f.calls.writes, []);
  assert.equal((await f.runner.runOnce('api')).skipped, 'disposed');
});

test('dispose during activity check stops immediately before the archive boundary', async (t) => {
  const activity = deferred();
  const f = runnerFixture(t, { activity: () => activity.promise });
  const pending = f.runner.runOnce('api');
  await tick(); f.runner.stop(); activity.resolve([]);
  await pending;
  assert.deepEqual(f.calls.archive, []);
  assert.deepEqual(f.calls.writes, []);
});

test('already-started archive may finish, but disposal stops later sessions and persistent writes', async (t) => {
  const archive = deferred();
  const f = runnerFixture(t, { archive: () => archive.promise });
  const pending = f.runner.runOnce('timer');
  await tick();
  assert.deepEqual(f.calls.archive, ['synthetic-a']);
  f.runner.stop(); archive.resolve();
  assert.equal((await pending).archived, 1);
  assert.deepEqual(f.calls.archive, ['synthetic-a']);
  assert.deepEqual(f.calls.writes, []);
  assert.equal((await f.runner.revertLast()).skipped, 'disposed');
  assert.deepEqual(f.calls.unarchive, []);
});

test('disabling or restoring global dry-run during an activity check prevents real mutation', async (t) => {
  for (const update of [{ enabled: false }, { dryRun: true }]) {
    const activity = deferred();
    const f = runnerFixture(t, { activity: () => activity.promise });
    const pending = f.runner.runOnce('api');
    await tick(); Object.assign(f.config, update); activity.resolve([]);
    const result = await pending;
    assert.equal(result.archived, 0);
    assert.deepEqual(f.calls.archive, []);
  }
});
