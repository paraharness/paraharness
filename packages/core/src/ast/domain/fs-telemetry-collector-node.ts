import type { BaseTelemetryCollectorASTNode } from '../base/base-telemetry-collector-ast-node.js';

/**
 * Passive AST node collecting distinct read and mutated file paths from `FsToolEffect` records (`fs.telemetry`).
 *
 * Populates `UniversalStepTelemetry.custom.fs` with deduplicated `filesRead` and `filesMutated`
 * arrays for downstream interrupt replacement mappers and audit receipts.
 */
export interface FsTelemetryCollectorNode
  extends BaseTelemetryCollectorASTNode<
    'fs:telemetry',
    { readonly filesRead: readonly string[]; readonly filesMutated: readonly string[] }
  > {}
