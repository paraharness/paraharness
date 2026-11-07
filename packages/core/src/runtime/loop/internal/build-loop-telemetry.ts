import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';

/**
 * Builds a serialized telemetry summary JSON string for a `LoopContinuationFrame` (`SPEC.md` §3.8).
 *
 * Captures cumulative and `.act()`-scoped turn, USD cost, and wall-clock duration metrics.
 *
 * @param {LoopContinuationFrame} loopFrame - Loop continuation frame carrying telemetry counters.
 *
 * @returns {string} JSON-serialized loop telemetry snapshot.
 */
export function buildLoopTelemetry(loopFrame: LoopContinuationFrame): string {
  return JSON.stringify({
    loopId: loopFrame.loopId,
    iteration: loopFrame.iteration,
    turnsTaken: loopFrame.turnsTaken,
    costUsd: loopFrame.costUsd,
    elapsedDurationMs: loopFrame.elapsedDurationMs,
    actTurnsTaken: loopFrame.actTurnsTaken,
    actCostUsd: loopFrame.actCostUsd,
    actElapsedDurationMs: loopFrame.actElapsedDurationMs,
  });
}
