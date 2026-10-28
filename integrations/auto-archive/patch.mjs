// Compatibility transformations for xiao-hans/dsh-session-auto-archive v0.1.1.
// The caller verifies the pinned commit; unexpected source shapes fail closed.

/** Delegate both trust and login checks to the injected native DSH service. */
export function nativeRequestRejection(ctx, req) {
  try {
    const connection = ctx.connection;
    if (typeof connection?.requestRejection !== 'function') return 503;
    const rejection = connection.requestRejection(req);
    if (rejection === 401 || rejection === 403) return rejection;
    if (rejection !== undefined || typeof connection.admit !== 'function') return 503;
    const admission = connection.admit(req);
    if (admission?.rejection === 401 || admission?.rejection === 403) return admission.rejection;
    const kind = admission?.peer?.principal?.kind;
    if (typeof kind !== 'string') return 503;
    return kind === 'owner' ? undefined : 403;
  } catch { /* unavailable/throwing auth must not become loopback access */ }
  return 503;
}

/** A manual run can strengthen, but cannot weaken, the saved dry-run policy. */
export function safeRunConfig(base, overrides) {
  const input = overrides === undefined ? {} : overrides;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('run body must be an object');
  for (const key of Object.keys(input)) {
    if (key !== 'dryRun') throw new TypeError('run accepts only the dryRun field');
  }
  if (Object.hasOwn(input, 'dryRun') && typeof input.dryRun !== 'boolean') throw new TypeError('dryRun must be boolean');
  if (input.dryRun === false && base.dryRun !== false) throw new TypeError('save dryRun=false in settings before requesting a live run');
  return { ...base, dryRun: base.dryRun !== false || input.dryRun === true };
}

/** Dispose cancels pending work; an already-entered archive promise may settle. */
export function startTimerLoop(runner, resolveConfig, timers = globalThis, ready = Promise.resolve()) {
  let stopped = false;
  let timer;
  const scheduleNext = (delay) => {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      void Promise.resolve(ready)
        .then(() => stopped ? undefined : runner.runOnce('timer'))
        .finally(() => {
          if (!stopped) scheduleNext(resolveConfig().intervalHours * 60 * 60 * 1000);
        })
        .catch(() => { /* runOnce normally reports its own failures */ });
    }, delay);
    timer?.unref?.();
  };
  scheduleNext(resolveConfig().startupDelayMs);
  return () => {
    if (stopped) return;
    stopped = true;
    runner.stop();
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
}

const HELPERS = [nativeRequestRejection, safeRunConfig, startTimerLoop].map((fn) => fn.toString()).join('\n\n');
const edit = (name, before, after, count = 1) => Object.freeze({ name, before, after, count });

// Tests use these same fragments without vendoring the engine or machine paths.
export const HOST_EDITS = Object.freeze([
  edit('kit-import',
    "import { getService, dshHome, plainConfig, isLoopbackRequest, writeJson } from '@hyzyn/dsh-kit';",
    "import { getService, dshHome, plainConfig, writeJson } from '@hyzyn/dsh-kit';"),
  edit('policy-helpers', 'function makeRunner(ctx, resolveConfig) {', `${HELPERS}\n\nfunction makeRunner(ctx, resolveConfig) {`),
  edit('runner-state', '    let running = false;\n    let lastResult = undefined;',
    '    let running = false;\n    let stopped = false;\n    const cancelled = () => stopped || resolveConfig().enabled === false;\n    let lastResult = undefined;'),
  edit('revert-entry', '    async function revertLast(sessionId) {\n        const registry = getService(ctx, \'workspaceRegistry\');',
    '    async function revertLast(sessionId) {\n        if (stopped) return { reverted: [], skipped: \'disposed\' };\n        const registry = getService(ctx, \'workspaceRegistry\');'),
  edit('revert-loop', '        for (const id of ids) {\n            if (!archived.has(id)) continue;',
    '        for (const id of ids) {\n            if (stopped) break;\n            if (!archived.has(id)) continue;'),
  edit('audit-entry', '    const audit = async (line) => {\n        try {\n            await mkdir(storeDir, { recursive: true });\n            await appendFile(',
    '    const audit = async (line) => {\n        if (stopped) return;\n        try {\n            await mkdir(storeDir, { recursive: true });\n            if (stopped) return;\n            await appendFile('),
  edit('run-policy', `        const ov = overrides && typeof overrides === 'object' ? overrides : {};
        const config = {
            ...resolveConfig(),
            ...(typeof ov.dryRun === 'boolean' ? { dryRun: ov.dryRun } : null),
            ...(Number.isFinite(ov.idleDays) && ov.idleDays > 0 ? { idleDays: ov.idleDays } : null),
            ...(ov.allowLive === true ? { allowLive: true } : null),
            ...(typeof ov.onlySessionId === 'string' && ov.onlySessionId ? { onlySessionId: ov.onlySessionId } : null),
        };
        if (!config.enabled && !ov.allowDisabled) return { ok: false, skipped: 'disabled' };`,
    `        if (stopped) return { ok: false, skipped: 'disposed' };
        const config = safeRunConfig(resolveConfig(), overrides);
        if (!config.enabled) return { ok: false, skipped: 'disabled' };`),
  edit('scan-loop', '            for (const snapshot of snapshots) {\n                const header = snapshot?.header;',
    '            for (const snapshot of snapshots) {\n                if (cancelled()) break;\n                const header = snapshot?.header;'),
  edit('remove-session-bypass', '                if (config.onlySessionId && id !== config.onlySessionId) continue;\n', ''),
  edit('remove-live-bypass', "                    if (!config.allowLive && sessionsService?.get?.(id) !== undefined) { skip('live'); continue; }",
    "                    if (sessionsService?.get?.(id) !== undefined) { skip('live'); continue; }"),
  edit('remove-debug-comment', '                // allowLive 仅供调试：跳过 live 判定（activity waterfall 仍会拦在跑的）。\n', ''),
  edit('dry-run-current-policy', '                if (config.dryRun) {\n                    result.planned += 1;',
    '                if (cancelled() || (!config.dryRun && resolveConfig().dryRun !== false)) break;\n                if (config.dryRun) {\n                    result.planned += 1;'),
  edit('archive-boundary', '                try {\n                    await registry.archiveSession(id);',
    '                try {\n                    if (cancelled() || resolveConfig().dryRun !== false) break;\n                    await registry.archiveSession(id);'),
  edit('status-boundary', '            try {\n                await mkdir(storeDir, { recursive: true });\n                await writeFile(join(storeDir, \'status.json\'),',
    '            try {\n                if (!stopped) {\n                    await mkdir(storeDir, { recursive: true });\n                    if (!stopped) await writeFile(join(storeDir, \'status.json\'),'),
  edit('status-boundary-close', "JSON.stringify(result, null, 2), 'utf8');\n            } catch (error) {",
    "JSON.stringify(result, null, 2), 'utf8');\n                }\n            } catch (error) {"),
  edit('runner-stop', '    return {\n        runOnce,\n        revertLast,',
    '    return {\n        stop: () => { stopped = true; },\n        runOnce,\n        revertLast,'),
  edit('config-ready', '        void loadStoredConfig();', '        const configReady = loadStoredConfig();'),
  edit('timer', `        ctx.effect(() => {
            let timer;
            const scheduleNext = (delay) => {
                timer = setTimeout(() => {
                    void runner.runOnce('timer').finally(() => scheduleNext(resolveConfig().intervalHours * DAY_MS / 24));
                }, delay);
                timer.unref?.();
            };
            // 启动调度不看 enabled：disabled 时 runOnce 自身短路，卡片里改开
            // enabled 也能在下一轮生效（热更新）。
            scheduleNext(resolveConfig().startupDelayMs);
            return () => { if (timer) clearTimeout(timer); };
        }, \`${'${LOG_PREFIX}'}: timer loop\`);`,
    `        ctx.effect(() => startTimerLoop(runner, resolveConfig, globalThis, configReady), \`${'${LOG_PREFIX}'}: timer loop\`);`),
  edit('route-injection', "        ctx.inject(['webServer'], (webCtx) => {", "        ctx.inject(['webServer', 'connection'], (webCtx) => {"),
  edit('route-guards', "if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });",
    "const rejection = nativeRequestRejection(webCtx, req);\n                        if (rejection !== undefined) return writeJson(res, rejection, { ok: false, error: rejection === 503 ? 'authentication unavailable' : 'request rejected' });", 5),
  edit('run-json', '                        } catch { /* 空/坏 body 走默认 */ }',
    "                        } catch { return writeJson(res, 400, { ok: false, error: 'invalid json body' }); }"),
  edit('run-validation', `                        // 一次性覆盖（dryRun/idleDays/allowLive/onlySessionId）由 runOnce 内部
                        // 合并，不再临时改共享 config（避免并发窗口互相污染）。
                        const result = await runner.runOnce('api', body);`,
    `                        await configReady;
                        try { safeRunConfig(resolveConfig(), body); }
                        catch (error) { return writeJson(res, 400, { ok: false, error: String(error.message) }); }
                        const result = await runner.runOnce('api', body);`),
  edit('header-auth-comment', 'POST /api/dsh-auto-archive/run（loopback-only）', 'POST /api/dsh-auto-archive/run（DSH 原生登录与 trust 校验）'),
  edit('routes-auth-comment', '// loopback API：状态查询 + 手动触发（dryRun 可临时覆盖）。', '// DSH authenticated API：状态查询 + 手动触发（只能加强 dryRun 保护）。'),
]);

export const CLIENT_EDITS = Object.freeze([
  edit('deployment-base', '    const API = "/api/dsh-auto-archive";',
    '    const API = new URL("api/dsh-auto-archive", document.baseURI).pathname.replace(/\\/$/, "");'),
]);

/** Exact-count replacements reject upstream drift and accidental double-patching. */
export function applyEdits(source, edits) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  let output = source;
  for (const { name, before, after, count } of edits) {
    const parts = output.split(before);
    const found = parts.length - 1;
    if (found !== count) throw new Error(`auto-archive patch '${name}': expected ${count} matches, found ${found}`);
    output = parts.join(after);
  }
  return output;
}

export function patchHost(source) { return applyEdits(source, HOST_EDITS); }
export function patchClient(source) { return applyEdits(source, CLIENT_EDITS); }
