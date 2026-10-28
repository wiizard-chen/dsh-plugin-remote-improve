/**
 * @local/dsh-perf-context-floor — companion plugin for @local/dsh-perf-patches.
 *
 * The byte-budget patch trims the opening snapshot to the newest N bytes, which
 * can leave a tool-heavy, still-running session with a window that starts in the
 * middle of a Turn. The chat UI then only shows the current Turn's status rows
 * ("analyzing request" / "deep diving") and asks the user to click Load earlier
 * before any conversation is visible.
 *
 * This plugin runs AFTER the budget patch (profile bundle order) and extends the
 * opening snapshot backwards over whole Turns, using the host's own page() API:
 *
 *   1. always complete the Turn that the trimmed window starts in, so the window
 *      begins at a `turn/start` event (its user prompt becomes visible);
 *   2. while the window is still small (fewer than SOFT bytes) and below MAX_TURNS,
 *      keep prepending previous whole Turns;
 *   3. stop at HARD bytes; on any failure fall back to the unmodified window.
 *
 * No files in the dsh installation are touched; if a future dsh changes the
 * internals this plugin looks for, it logs SKIPPED and stays inert.
 *
 * Environment:
 *   DSH_PERF_FLOOR_SOFT_BYTES  default 1200000  desired minimum window size
 *   DSH_PERF_FLOOR_HARD_BYTES  default 8388608  never exceed this window size
 *   DSH_PERF_FLOOR_MAX_TURNS   default 3        stop after this many whole Turns
 *   DSH_PERF_FLOOR_DISABLE=1   skip this plugin
 */
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TAG = '[dsh-perf-floor]';
const SOFT = Number(process.env.DSH_PERF_FLOOR_SOFT_BYTES ?? 1_200_000);
const HARD = Number(process.env.DSH_PERF_FLOOR_HARD_BYTES ?? 8_388_608);
const MAX_TURNS = Number(process.env.DSH_PERF_FLOOR_MAX_TURNS ?? 3);
const log = (...args) => console.log(TAG, ...args);
const warn = (...args) => console.warn(TAG, ...args);

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
      // explicit error below
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

const isTurnStart = (record) => record?.event?.type === 'turn/start';
const countTurns = (records) => records.reduce((count, record) => count + (isTurnStart(record) ? 1 : 0), 0);
const estimateBytes = (records) => {
  let total = 0;
  for (const record of records) {
    try {
      total += JSON.stringify(record).length;
    } catch {
      // a non-serializable record cannot be measured; ignore its weight
    }
  }
  return total;
};

/** Prepend whole Turns to the opening snapshot via the host's page() RPC. */
async function extendWindow(controller, request, frame, signal) {
  const records = [...frame.records];
  let hasMore = frame.hasMore === true;
  let bytes = estimateBytes(records);
  let guard = 0;

  while (guard < 12) {
    guard += 1;
    const aligned = isTurnStart(records[0]);
    const turns = countTurns(records);
    const complete = aligned && turns >= 1;
    if (complete && (bytes >= SOFT || turns >= MAX_TURNS)) break;
    if (bytes >= HARD) break;
    if (!hasMore) break;

    const firstSeq = records[0]?.event?.seq;
    if (!Number.isSafeInteger(firstSeq) || firstSeq <= 0) break;

    const page = await controller.page(
      {
        address: request.address,
        throughSeq: frame.cursor,
        beforeSeq: firstSeq,
        maxMessages: 100000,
        turnWindow: { minMessages: 1, minTurns: 1 },
      },
      signal,
    );
    const older = Array.isArray(page?.records) ? page.records : [];
    if (older.length === 0) {
      hasMore = false;
      break;
    }
    records.unshift(...older);
    bytes += estimateBytes(older);
    hasMore = page.hasMore === true;
  }

  if (records.length === frame.records.length) return frame;
  log(`extended window: ${(estimateBytes(frame.records) / 1024).toFixed(0)}KB -> ${(bytes / 1024).toFixed(0)}KB, turns=${countTurns(records)}, aligned=${isTurnStart(records[0])}`);
  return { ...frame, records, hasMore };
}

if (process.env.DSH_PERF_FLOOR_DISABLE === '1') {
  log('disabled by env');
} else {
  try {
    const sessionControllerEntry = installRequire.resolve('@deepseek-ai/dsh-api-session-controller');
    const { SessionController } = await import(pathToFileURL(sessionControllerEntry).href);
    const prototype = SessionController?.prototype;
    if (typeof prototype?.follow !== 'function' || typeof prototype?.page !== 'function') {
      throw new Error('SessionController.follow/page not found');
    }
    if (prototype.follow.__dshContextFloor === true) {
      log('already applied');
    } else {
      const previousFollow = prototype.follow;
      const followWithFloor = async function* followWithContextFloor(request, signal) {
        for await (const frame of previousFollow.call(this, request, signal)) {
          if (frame?.type !== 'snapshot' || !Array.isArray(frame.records) || frame.records.length === 0) {
            yield frame;
            continue;
          }
          try {
            yield await extendWindow(this, request, frame, signal);
          } catch (error) {
            warn('extend skipped:', error?.message ?? error);
            yield frame;
          }
        }
      };
      followWithFloor.__dshContextFloor = true;
      prototype.follow = followWithFloor;
      log(`applied for dsh ${dshVersion} (SOFT=${SOFT} HARD=${HARD} MAX_TURNS=${MAX_TURNS})`);
    }
  } catch (error) {
    warn('SKIPPED (context floor):', error?.message ?? error);
  }
}

export default {
  name: 'dsh-perf-context-floor',
  apply(ctx) {
    log('plugin applied');
  },
};
