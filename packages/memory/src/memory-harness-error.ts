import type { MemoryErrorCode } from './schemas/memory-tools.schema.js';

/**
 * Structured domain error thrown by `@paraharness/memory` operations.
 *
 * Carries a deterministic machine-readable `code` (`MemoryErrorCode`) and optional diagnostic
 * `details` metadata alongside the human-readable error message.
 */
export class MemoryHarnessError extends Error {
  /** Deterministic machine-readable error code identifying the failure category. */
  readonly code: MemoryErrorCode;

  /** Optional structured diagnostic context associated with the error. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  /**
   * Creates a new `MemoryHarnessError` instance.
   *
   * @param {MemoryErrorCode}                   code      - Machine-readable error code.
   * @param {string}                            message   - Actionable diagnostic message.
   * @param {Readonly<Record<string, unknown>>} [details] - Optional structured metadata.
   */
  constructor(
    code: MemoryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'MemoryHarnessError';
    this.code = code;
    this.details = details !== undefined ? Object.freeze({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
