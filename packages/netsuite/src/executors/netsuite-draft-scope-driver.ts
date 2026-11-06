import type { IsolationScope, z } from '@harness-dsl/core';
import type { DraftJournalReceipt } from '../nodes/draft-journal-receipt.js';
import type { NetSuiteDraftHandle } from '../nodes/netsuite-draft-handle.js';
import type { NetSuiteDraftScopeNode } from '../nodes/netsuite-draft-scope-node.js';

/**
 * Tier-1 runtime isolation scope driver for NetSuite draft journals (`netsuite:draft-scope`).
 *
 * Implements `IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>` (`acquireRoot`,
 * `reattachRoot`, `inspect`, `release`) for transactional ledger reconciliation without git semantics.
 */
export class NetSuiteDraftScopeDriver
  implements IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>
{
  /** Unique identifier of the NetSuite draft journal scope node. */
  readonly id: string;

  /** Zod schema validating `DraftJournalReceipt` objects emitted by `inspect()`. */
  readonly receiptSchema: z.ZodType<DraftJournalReceipt, z.ZodTypeDef, unknown>;

  /** Active draft journal handles indexed by `runId` for crash-recovery reattachment. */
  private readonly handlesByRunId = new Map<string, NetSuiteDraftHandle>();

  /**
   * Initializes a `NetSuiteDraftScopeDriver` bound to a compiled `NetSuiteDraftScopeNode`.
   *
   * Stores the scope identifier and receipt validation schema from `node`.
   *
   * @param {NetSuiteDraftScopeNode} node - Passive NetSuite draft journal scope AST node.
   */
  constructor(node: NetSuiteDraftScopeNode) {
    this.id = node.id;
    this.receiptSchema = node.receiptSchema;
  }

  /**
   * Provisions and initializes an isolated NetSuite draft journal root handle for `runId`.
   *
   * Creates an `'open'` draft journal with deterministic identifier `"draft-${runId}"` and empty staged lines.
   *
   * @param {string} runId - Unique identifier of the enclosing harness run.
   *
   * @returns {Promise<NetSuiteDraftHandle>} Newly acquired root NetSuite draft journal handle.
   */
  acquireRoot(runId: string): Promise<NetSuiteDraftHandle> {
    const handle: NetSuiteDraftHandle = {
      runId,
      journalId: `draft-${runId}`,
      status: 'open',
      entries: [],
    };
    this.handlesByRunId.set(runId, handle);
    return Promise.resolve(handle);
  }

  /**
   * Rebinds an existing root NetSuite draft journal handle during crash recovery.
   *
   * Returns the in-memory handle for `runId` when still active or provisions a fresh `'open'` handle.
   *
   * @param {string} runId        - Unique identifier of the recovering harness run.
   * @param {string} [checkpoint] - Optional persisted base scope checkpoint identifier.
   *
   * @returns {Promise<NetSuiteDraftHandle>} Reattached root NetSuite draft journal handle.
   */
  reattachRoot(runId: string, checkpoint?: string): Promise<NetSuiteDraftHandle> {
    const existing = this.handlesByRunId.get(runId);
    if (existing !== undefined && existing.status !== 'released') {
      return Promise.resolve(existing);
    }
    const journalId =
      checkpoint !== undefined && checkpoint.length > 0 ? checkpoint : `draft-${runId}`;
    const recovered: NetSuiteDraftHandle = {
      runId,
      journalId,
      status: 'open',
      entries: [],
    };
    this.handlesByRunId.set(runId, recovered);
    return Promise.resolve(recovered);
  }

  /**
   * Computes a side-effect-free `DraftJournalReceipt` summarizing staged debits and credits for `handle`.
   *
   * Aggregates `totalDebitUsd`, `totalCreditUsd`, and `netBalanceUsd` in a single pass and validates via `receiptSchema`.
   *
   * @param {NetSuiteDraftHandle} handle - Active NetSuite draft journal scope handle to inspect.
   *
   * @returns {Promise<DraftJournalReceipt>} Schema-validated draft journal inspection receipt.
   */
  inspect(handle: NetSuiteDraftHandle): Promise<DraftJournalReceipt> {
    let totalDebitUsd = 0;
    let totalCreditUsd = 0;
    for (const entry of handle.entries) {
      totalDebitUsd += entry.debitUsd;
      totalCreditUsd += entry.creditUsd;
    }
    const netBalanceUsd = Math.round((totalDebitUsd - totalCreditUsd) * 100) / 100;
    const receipt = this.receiptSchema.parse({
      journalId: handle.journalId,
      runId: handle.runId,
      status: handle.status,
      totalDebitUsd,
      totalCreditUsd,
      netBalanceUsd,
      lineCount: handle.entries.length,
    });
    return Promise.resolve(receipt);
  }

  /**
   * Releases and cleans up an ephemeral NetSuite draft journal scope handle.
   *
   * Marks `handle.status` as `'released'` and removes the run binding from the active handle registry.
   *
   * @param {NetSuiteDraftHandle} handle - NetSuite draft journal scope handle to release.
   *
   * @returns {Promise<void>} Resolves once the draft journal handle has been marked released.
   */
  release(handle: NetSuiteDraftHandle): Promise<void> {
    handle.status = 'released';
    this.handlesByRunId.delete(handle.runId);
    return Promise.resolve();
  }
}
