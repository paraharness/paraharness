import type { FsTelemetryCollectorNode } from '@harness-dsl/core';
import { FsTelemetryMetricsSchema } from './internal/fs-tool-input.schema.js';

/**
 * Compiles a passive `FsTelemetryCollectorNode` (`fs:telemetry`) for `fs.telemetry()`.
 *
 * Collects distinct `filesRead` and `filesMutated` arrays from `FsToolEffect` records
 * into `UniversalStepTelemetry.custom`.
 *
 * @returns {FsTelemetryCollectorNode} Deeply frozen `FsTelemetryCollectorNode` AST descriptor.
 */
export function createFsTelemetryBuilder(): FsTelemetryCollectorNode {
  return Object.freeze<FsTelemetryCollectorNode>({
    type: 'fs:telemetry',
    id: 'fs:telemetry',
    schema: FsTelemetryMetricsSchema,
  });
}
