import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import writeFileAtomic from 'write-file-atomic';
import { MemorySessionEpochStateSchema } from '../schemas/memory-tools.schema.js';
import {
  LATEST_ROLE_FILENAME,
  SESSION_STATE_REL_DIR,
} from './memory-protocol.constants.js';
import { applyIdRemapToRecordIds } from './reconcile-diverged-memory-ledgers.js';

/**
 * Remaps `seenRecordIds` across a single `.memory/.session-state/<otherSid>.json` file while
 * holding its individual `<otherSid>.lock` (§8.1 Rule 1, §8.2.3 Step 3).
 *
 * @param {string}                      sessionStateDir   - Absolute path to `.memory/.session-state`.
 * @param {string}                      otherSid          - Session identifier of the target session file.
 * @param {ReadonlyMap<string, string>} cumulativeIdRemap - Mapping from old record IDs to re-numbered IDs.
 *
 * @returns {Promise<boolean>} `true` if `<otherSid>.json` had at least one `seenRecordIds` entry remapped.
 */
function remapSingleOtherSessionStateUnderLock(
  sessionStateDir: string,
  otherSid: string,
  cumulativeIdRemap: ReadonlyMap<string, string>,
): Promise<boolean> {
  const lockPath = path.join(sessionStateDir, `${otherSid}.lock`);
  const statePath = path.join(sessionStateDir, `${otherSid}.json`);
  return withFileLock(lockPath, async () => {
    if (!existsSync(statePath)) {
      return false;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      return false;
    }
    const validated = MemorySessionEpochStateSchema.safeParse(parsedJson);
    if (!validated.success) {
      return false;
    }
    const state = validated.data;
    const remappedIds = applyIdRemapToRecordIds(state.seenRecordIds, cumulativeIdRemap);
    const changed =
      remappedIds.length !== state.seenRecordIds.length ||
      remappedIds.some((id, idx) => id !== state.seenRecordIds[idx]);
    if (!changed) {
      return false;
    }
    const updatedState = {
      ...state,
      seenRecordIds: [...remappedIds],
    };
    await writeFileAtomic(statePath, `${JSON.stringify(updatedState, null, 2)}\n`, {
      encoding: 'utf8',
    });
    return true;
  });
}

/**
 * Remaps `seenRecordIds` across all other sessions' `.memory/.session-state/<otherSid>.json` files
 * strictly **after** `<ledgerPath>.lock` and the caller's `<sessionId>.lock` have been released,
 * acquiring each `<otherSid>.lock` individually via `withFileLock` (§8.1 Rule 1, §8.2.3 Step 3).
 *
 * @param {string}                      workspaceRoot     - Absolute path to the workspace root directory.
 * @param {ReadonlyMap<string, string>} cumulativeIdRemap - Transitive `oldId -> newId` map from Git reconciliation.
 * @param {string}                      [callerSessionId] - Optional active caller `sessionId` to skip (already remapped under `<sessionId>.lock`).
 *
 * @returns {Promise<readonly string[]>} Frozen list of `<otherSid>` session IDs whose state files were updated.
 */
export async function remapOtherSessionStatesAfterLockRelease(
  workspaceRoot: string,
  cumulativeIdRemap: ReadonlyMap<string, string>,
  callerSessionId?: string,
): Promise<readonly string[]> {
  if (cumulativeIdRemap.size === 0) {
    return Object.freeze([]);
  }
  const sessionStateDir = path.resolve(workspaceRoot, SESSION_STATE_REL_DIR);
  if (!existsSync(sessionStateDir)) {
    return Object.freeze([]);
  }
  const entries = await readdir(sessionStateDir);
  const updatedSessionIds: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === LATEST_ROLE_FILENAME) {
      continue;
    }
    const otherSid = entry.slice(0, -'.json'.length);
    if (otherSid.length === 0 || (callerSessionId !== undefined && otherSid === callerSessionId)) {
      continue;
    }
    const updated = await remapSingleOtherSessionStateUnderLock(
      sessionStateDir,
      otherSid,
      cumulativeIdRemap,
    );
    if (updated) {
      updatedSessionIds.push(otherSid);
    }
  }
  return Object.freeze(updatedSessionIds);
}
