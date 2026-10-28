/**
 * @local/dsh-perf-patches — upgrade-proof load-speed patches for the DSH web GUI.
 *
 * This package is loaded as the FIRST profile bundle (see its cordis.patch.yml and
 * `dsh.profile.bundles` in ~/.dsh/profiles/web/package.json), so this module is
 * imported before @deepseek-ai/dsh-base mounts the gateway and the session
 * controller. It changes no file under the dsh installation, so `dsh` upgrades
 * cannot overwrite it. If a future dsh changes the patched internals, the patch
 * is skipped with a loud warning instead of breaking boot.
 *
 * Patch 1 — WebSocket compression
 *   dsh-api-gateway constructs `new WebSocketServer({ noServer: true })` and the
 *   session replay therefore travels as one uncompressed JSON text frame (17.9 MB
 *   for a large session). We inject `perMessageDeflate` at upgrade time; browsers
 *   negotiate it automatically (2.5-2.6x smaller frames measured on this box).
 *
 * Patch 2 — first-paint byte budget
 *   Opening a session yields a snapshot containing the whole tail window
 *   (HISTORY_PAGE_OPTIONS maxMessages=500 + turnWindow cuts the entire session for
 *   tool-event-heavy logs; measured 17.84 MB). We trim the opening snapshot's
 *   records to the newest N bytes and mark hasMore=true. The untouched client
 *   already supports "Load earlier" paging, so the first paint carries only the
 *   recent history (measured 0.61 MB with a 1.2 MB budget) and older history is
 *   fetched on demand. Older-history pages (page()) are deliberately NOT trimmed:
 *   trimming a prepend page in the wrong direction severs its continuity with the
 *   client window and silently breaks "Load earlier".
 *
 * Configuration (environment):
 *   DSH_PERF_PAGE_BUDGET_BYTES  opening-snapshot budget, default 1200000
 *   DSH_PERF_DISABLE_DEFLATE=1  skip patch 1
 *   DSH_PERF_DISABLE_BUDGET=1   skip patch 2
 */
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TAG = '[dsh-perf-patches]';
const BUDGET = Number(process.env.DSH_PERF_PAGE_BUDGET_BYTES ?? 1_200_000);
const log = (...args) => console.log(TAG, ...args);
const warn = (...args) => console.warn(TAG, ...args);

/** Absolute <dsh install>/package.json for the running launcher. */
function findInstallAnchor() {
  const fromEnv = process.env.DSH_INSTALL_ANCHOR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const bin = process.argv[1];
  if (bin !== undefined) {
    try {
      const real = realpathSync(bin);
      if (real.endsWith(`${path.sep}lib${path.sep}bin.js`)) {
        return path.resolve(path.dirname(real), '..', 'package.json');
      }
    } catch {
      // fall through to the explicit error below
    }
  }
  throw new Error('cannot locate the dsh installation (set DSH_INSTALL_ANCHOR)');
}

const installAnchor = findInstallAnchor();
const installRequire = createRequire(installAnchor);
const dshVersion = (() => {
  try {
    return JSON.parse(readFileSync(installAnchor, 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
log(`loading for dsh ${dshVersion} (${installAnchor})`);

/* ------------------------------------------------------------------------- *
 * Patch 1: default perMessageDeflate for every WebSocketServer.handleUpgrade.
 * ------------------------------------------------------------------------- */
function patchWebSocketCompression() {
  if (process.env.DSH_PERF_DISABLE_DEFLATE === '1') {
    log('deflate patch disabled by env');
    return;
  }
  try {
    const gatewayEntry = installRequire.resolve('@deepseek-ai/dsh-api-gateway');
    const ws = createRequire(gatewayEntry)('ws');
    const prototype = ws?.WebSocketServer?.prototype;
    if (typeof prototype?.handleUpgrade !== 'function') {
      throw new Error('ws.WebSocketServer.prototype.handleUpgrade not found');
    }
    if (prototype.handleUpgrade.__dshPerfPatched === true) return;
    const original = prototype.handleUpgrade;
    const patched = function handleUpgradeWithCompression(...args) {
      if (!this.options.perMessageDeflate) {
        this.options.perMessageDeflate = {
          threshold: 1024,
          zlibDeflateOptions: { level: 3 },
        };
      }
      return original.apply(this, args);
    };
    patched.__dshPerfPatched = true;
    prototype.handleUpgrade = patched;
    log('patch 1/2: perMessageDeflate enabled for websocket upgrades');
  } catch (error) {
    warn('patch 1/2 SKIPPED (ws compression):', error?.message ?? error);
  }
}

/* ------------------------------------------------------------------------- *
 * Patch 2: opening-snapshot byte budget on SessionController.follow().
 * ------------------------------------------------------------------------- */
/** Keep the newest records that fit `budget` bytes; never return an empty page. */
function trimSnapshotRecords(records, budget) {
  if (!Array.isArray(records) || records.length === 0) return { records, trimmed: false };
  const sizes = records.map((record) => {
    try {
      return JSON.stringify(record).length;
    } catch {
      return 0;
    }
  });
  let total = 0;
  let cut = records.length;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    total += sizes[index];
    if (total > budget) {
      cut = index + 1;
      break;
    }
    cut = index;
  }
  if (cut <= 0) return { records, trimmed: false };
  if (cut >= records.length) cut = records.length - 1; // one oversized record still has to go out
  return { records: records.slice(cut), trimmed: true };
}

async function patchFirstPaintBudget() {
  if (process.env.DSH_PERF_DISABLE_BUDGET === '1') {
    log('budget patch disabled by env');
    return;
  }
  try {
    const sessionControllerEntry = installRequire.resolve('@deepseek-ai/dsh-api-session-controller');
    // Import by absolute file URL: the profile plugin cannot resolve installation
    // packages by bare specifier, while the loader imports this same file path, so
    // the module instance (and thus SessionController.prototype) is shared.
    const { SessionController } = await import(pathToFileURL(sessionControllerEntry).href);
    const prototype = SessionController?.prototype;
    if (typeof prototype?.follow !== 'function') {
      throw new Error('SessionController.prototype.follow not found');
    }
    if (prototype.follow.__dshPerfPatched === true) return;
    const originalFollow = prototype.follow;
    const patchedFollow = async function* followWithBudget(request, signal) {
      for await (const frame of originalFollow.call(this, request, signal)) {
        if (frame?.type === 'snapshot' && Array.isArray(frame.records)) {
          const { records, trimmed } = trimSnapshotRecords(frame.records, BUDGET);
          if (trimmed) {
            yield { ...frame, records, hasMore: true };
            continue;
          }
        }
        yield frame;
      }
    };
    patchedFollow.__dshPerfPatched = true;
    prototype.follow = patchedFollow;
    log(`patch 2/2: opening snapshot budget ${BUDGET} bytes`);
  } catch (error) {
    warn('patch 2/2 SKIPPED (first-paint budget):', error?.message ?? error);
  }
}

patchWebSocketCompression();
try {
  await patchFirstPaintBudget();
} catch (error) {
  warn('patch 2/2 failed:', error?.message ?? error);
}

/** No host service of its own: this entry exists only to run the import-time patches. */
export default {
  name: 'dsh-perf-patches',
  apply(ctx) {
    log('applied (profile bundle loaded before dsh-base)');
  },
};
