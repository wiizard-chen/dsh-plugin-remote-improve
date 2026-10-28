import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const perfURL = pathToFileURL(path.join(root, 'packages/dsh-perf-patches/index.js')).href;
const floorURL = pathToFileURL(path.join(root, 'packages/dsh-perf-context-floor/index.js')).href;

function runIsolated(t, program, settings = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-perf-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
    assert.ok(path.basename(fixture).startsWith('dsh-perf-test-'));
    rmSync(fixture, { recursive: true, force: true });
  });
  const write = (relative, content) => {
    const full = path.join(fixture, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  write('package.json', JSON.stringify({ name: 'synthetic-dsh-host', version: '0.0.0-test' }));
  write('node_modules/ws/package.json', JSON.stringify({ name: 'ws', main: 'index.cjs' }));
  write('node_modules/ws/index.cjs', `
    class WebSocketServer {
      constructor(options = {}) { this.options = options; }
      handleUpgrade(...args) { this.lastArgs = args; return 'original-result'; }
    }
    module.exports = { WebSocketServer };
  `);
  write('node_modules/@deepseek-ai/dsh-api-gateway/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-api-gateway', main: 'index.cjs' }));
  write('node_modules/@deepseek-ai/dsh-api-gateway/index.cjs', 'module.exports = {};');
  write('node_modules/@deepseek-ai/dsh-api-session-controller/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-api-session-controller', type: 'module', main: 'index.js' }));
  write('node_modules/@deepseek-ai/dsh-api-session-controller/index.js', `
    export class SessionController {
      frames = [];
      pages = [];
      calls = [];
      async *follow() { for (const frame of this.frames) yield frame; }
      async page(request) {
        this.calls.push(request);
        const page = this.pages.shift();
        if (page instanceof Error) throw page;
        return page ?? { records: [], hasMore: false };
      }
    }
  `);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DSH_PERF_') || key === 'DSH_INSTALL_ANCHOR') delete env[key];
  Object.assign(env, { DSH_INSTALL_ANCHOR: path.join(fixture, 'package.json') }, settings);
  const prelude = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const require = createRequire(process.env.DSH_INSTALL_ANCHOR);
    const { WebSocketServer } = require('ws');
    const { SessionController } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-api-session-controller')).href);
    const perfURL = ${JSON.stringify(perfURL)};
    const floorURL = ${JSON.stringify(floorURL)};
    const collect = async (stream) => { const frames = []; for await (const frame of stream) frames.push(frame); return frames; };
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + program], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
}

test('perf hooks negotiate compression and trim only the opening snapshot', (t) => {
  runIsolated(t, `
    await import(perfURL);
    const hooked = SessionController.prototype.follow;
    const upgrade = WebSocketServer.prototype.handleUpgrade;
    await import(perfURL + '?second-load');
    assert.equal(SessionController.prototype.follow, hooked);
    assert.equal(WebSocketServer.prototype.handleUpgrade, upgrade);
    const socket = new WebSocketServer({ noServer: true });
    assert.equal(socket.handleUpgrade('request', 'socket', 'head'), 'original-result');
    assert.equal(socket.options.perMessageDeflate.threshold, 1024);
    assert.deepEqual(socket.lastArgs, ['request', 'socket', 'head']);
    const controller = new SessionController();
    const records = [{ id: 1, text: 'x'.repeat(60) }, { id: 2, text: 'y'.repeat(60) }];
    const update = { type: 'event', event: { type: 'test/event' } };
    controller.frames = [{ type: 'snapshot', records, cursor: 2, hasMore: false }, update];
    const frames = await collect(controller.follow({ address: 'synthetic-session' }));
    assert.deepEqual(frames[0].records, [records[1]]);
    assert.equal(frames[0].hasMore, true);
    assert.equal(frames[0].cursor, 2);
    assert.equal(frames[1], update);
    controller.pages.push({ records, hasMore: false });
    assert.deepEqual((await controller.page({})).records, records);
  `, { DSH_PERF_PAGE_BUDGET_BYTES: '100' });
});

test('perf retains a single oversized record and an empty snapshot', (t) => {
  runIsolated(t, `
    await import(perfURL);
    const controller = new SessionController();
    const record = { text: 'x'.repeat(200) };
    controller.frames = [{ type: 'snapshot', records: [record] }, { type: 'snapshot', records: [] }];
    const frames = await collect(controller.follow({}));
    assert.deepEqual(frames[0].records, [record]);
    assert.deepEqual(frames[1].records, []);
  `, { DSH_PERF_PAGE_BUDGET_BYTES: '10' });
});

test('all explicit disable switches leave synthetic host prototypes unchanged', (t) => {
  runIsolated(t, `
    const originalFollow = SessionController.prototype.follow;
    const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
    await import(perfURL);
    await import(floorURL);
    assert.equal(SessionController.prototype.follow, originalFollow);
    assert.equal(WebSocketServer.prototype.handleUpgrade, originalUpgrade);
  `, { DSH_PERF_DISABLE_DEFLATE: '1', DSH_PERF_DISABLE_BUDGET: '1', DSH_PERF_FLOOR_DISABLE: '1' });
});

test('floor wraps perf and prepends history using the snapshot cursor', (t) => {
  runIsolated(t, `
    await import(perfURL);
    await import(floorURL);
    const wrapped = SessionController.prototype.follow;
    await import(floorURL + '?second-load');
    assert.equal(SessionController.prototype.follow, wrapped);
    const controller = new SessionController();
    const first = { event: { seq: 1, type: 'turn/start' }, prompt: 'synthetic prompt' };
    const second = { event: { seq: 2, type: 'tool/end' } };
    controller.frames = [{ type: 'snapshot', records: [second], cursor: 2, hasMore: true }];
    controller.pages.push({ records: [first], hasMore: false });
    const frames = await collect(controller.follow({ address: 'synthetic-session' }));
    assert.deepEqual(frames[0].records, [first, second]);
    assert.equal(frames[0].hasMore, false);
    assert.equal(controller.calls.length, 1);
    assert.equal(controller.calls[0].beforeSeq, 2);
    assert.equal(controller.calls[0].throughSeq, 2);
    assert.equal(controller.calls[0].address, 'synthetic-session');
  `);
});

test('floor passes through a usable snapshot when older history fails', (t) => {
  runIsolated(t, `
    await import(floorURL);
    const controller = new SessionController();
    const frame = { type: 'snapshot', records: [{ event: { seq: 3, type: 'tool/end' } }], cursor: 3, hasMore: true };
    controller.frames = [frame];
    controller.pages.push(new Error('synthetic page failure'));
    const frames = await collect(controller.follow({ address: 'synthetic-session' }));
    assert.equal(frames[0], frame);
  `);
});
