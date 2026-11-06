/**
 * Configuration options for `fs.writeGuard(options)`.
 *
 * Defines glob patterns that deny write mutations (`denyGlobs`), optional exemptions
 * (`allowGlobs`), and optional base-ref existence filtering (`onlyExistingAtBaseRef`).
 */
export interface FsWriteGuardOptions {
  /** Glob patterns denying write mutations. */
  readonly denyGlobs: readonly string[];
  /** Optional glob patterns exempted from `denyGlobs`. */
  readonly allowGlobs?: readonly string[];
  /** When `true`, blocks only paths that already existed at `handle.baseRef`. */
  readonly onlyExistingAtBaseRef?: boolean;
}
