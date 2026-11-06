import type { BaseToolASTNode } from '@harness-dsl/core';
import type { NetSuiteDraftHandle } from './netsuite-draft-handle.js';

/**
 * Passive AST node representing a NetSuite draft journal tool (`netsuite.journalTools()`).
 *
 * Uses `effectTracking: 'declared'` so `ToolDriver.describeEffects()` emits pre-flight
 * `netsuite:journal-effect` descriptors inspected by `NetSuiteClosedPeriodGuardNode`.
 *
 * @template THandle Isolation scope handle type (defaults to `NetSuiteDraftHandle`).
 */
export interface NetSuiteJournalToolNode<THandle = NetSuiteDraftHandle>
  extends BaseToolASTNode<'netsuite:journal-tool', 'declared', THandle> {
  /** Discriminant identifying a NetSuite journal tool AST node. */
  readonly type: 'netsuite:journal-tool';
  /** Static indicator that tool effects are declared pre-flight. */
  readonly effectTracking: 'declared';
}
