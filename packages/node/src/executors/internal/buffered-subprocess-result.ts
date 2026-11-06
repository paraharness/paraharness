/**
 * Captured exit status and standard output/error streams from `runBufferedSubprocess`.
 *
 * Returned once the child process exits normally.
 */
export interface BufferedSubprocessResult {
  /** Process exit status code (`0` on success). */
  readonly exitCode: number;
  /** Complete UTF-8 standard output captured from the subprocess. */
  readonly stdout: string;
  /** Complete UTF-8 standard error captured from the subprocess. */
  readonly stderr: string;
}
