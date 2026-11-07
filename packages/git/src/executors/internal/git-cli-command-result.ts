/**
 * Result returned by `runGitCommand` after executing a `git` CLI subprocess.
 *
 * Contains the exit code, decoded UTF-8 `stdout` and `stderr` strings, and raw `stdoutBuffer` bytes.
 */
export interface GitCliCommandResult {
  /** Numeric subprocess exit code (`0` on success). */
  readonly exitCode: number;
  /** UTF-8 decoded standard output. */
  readonly stdout: string;
  /** UTF-8 decoded standard error. */
  readonly stderr: string;
  /** Raw standard output buffer for NUL-delimited (`-z`) binary/path parsing. */
  readonly stdoutBuffer: Buffer;
}
