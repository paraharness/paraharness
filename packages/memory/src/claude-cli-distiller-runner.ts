import { execFile } from 'node:child_process';
import type {
  DistillerProposalRequest,
  MemoryDistillerRunner,
} from './memory-distiller-runner.js';
import { MemoryHarnessError } from './memory-harness-error.js';
import {
  DistillerStructuredOutputSchema,
  type DistillerStructuredOutput,
} from './schemas/memory-tools.schema.js';

/**
 * Built-in `MemoryDistillerRunner` implementation that spawns the `claude` CLI in non-interactive
 * print mode (`claude -p`) with `--output-format json` and `--json-schema` enforcement (§6.4 Step 4).
 *
 * Unwraps all three supported Claude CLI stdout shapes (`{ structured_output }`, `{ result: '<json>' }`,
 * and bare `DistillerStructuredOutput` JSON) and validates the result against `DistillerStructuredOutputSchema`.
 */
export class ClaudeCliDistillerRunner implements MemoryDistillerRunner {
  /**
   * Executes the Distiller prompt via `claude -p` and returns a validated `DistillerStructuredOutput`.
   *
   * @param {DistillerProposalRequest} request - Distiller prompt, JSON schema, timeout, and model parameters.
   *
   * @returns {Promise<DistillerStructuredOutput>} Validated structured Distiller match and choice analysis.
   *
   * @throws {MemoryHarnessError} With code `'DISTILLER_EXECUTION_FAILED'` on timeout, non-zero exit, malformed JSON, or schema validation failure.
   */
  async runDistillerProposal(
    request: DistillerProposalRequest,
  ): Promise<DistillerStructuredOutput> {
    const cliArgs = [
      '-p',
      '--model',
      request.model,
      '--effort',
      request.effort,
      '--system-prompt',
      request.systemPrompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(request.outputJsonSchema),
      request.userPrompt,
    ];
    const stdoutText = await this.spawnClaudeCli(cliArgs, request.timeoutMs);
    const unwrappedPayload = this.unwrapClaudeStdoutJson(stdoutText);
    const validated = DistillerStructuredOutputSchema.safeParse(unwrappedPayload);
    if (!validated.success) {
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        `Claude CLI Distiller output failed DistillerStructuredOutputSchema validation: ${validated.error.message}`,
        { issues: validated.error.issues },
      );
    }
    return validated.data;
  }

  /**
   * Spawns `claude` with `cliArgs` and `timeoutMs`, rejecting with `MemoryHarnessError('DISTILLER_EXECUTION_FAILED')`
   * on process error, timeout, or non-zero exit status.
   *
   * @param {readonly string[]} cliArgs   - Command-line arguments passed to `claude`.
   * @param {number}            timeoutMs - Subprocess execution timeout in milliseconds.
   *
   * @returns {Promise<string>} Captured standard output string from `claude`.
   *
   * @throws {MemoryHarnessError} With `'DISTILLER_EXECUTION_FAILED'` when the subprocess fails or times out.
   */
  private spawnClaudeCli(cliArgs: readonly string[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        'claude',
        [...cliArgs],
        {
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env },
        },
        (err, stdout, stderr) => {
          if (err !== null) {
            const killedByTimeout = (err as Error & { readonly killed?: boolean }).killed === true;
            const reason = killedByTimeout
              ? `timed out after ${timeoutMs}ms`
              : stderr.trim().length > 0
                ? stderr.trim()
                : err.message;
            reject(
              new MemoryHarnessError(
                'DISTILLER_EXECUTION_FAILED',
                `Claude CLI Distiller execution failed: ${reason}`,
                {
                  timeoutMs,
                  killedByTimeout,
                  stderr: stderr.trim(),
                },
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /**
   * Parses `stdoutText` as JSON and unwraps `parsed.structured_output ?? (typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed)`
   * per §6.4 Step 4.
   *
   * @param {string} stdoutText - Raw standard output emitted by `claude -p`.
   *
   * @returns {unknown} Unwrapped candidate structured output object.
   *
   * @throws {MemoryHarnessError} With `'DISTILLER_EXECUTION_FAILED'` if `stdoutText` or `parsed.result` is not valid JSON.
   */
  private unwrapClaudeStdoutJson(stdoutText: string): unknown {
    const trimmed = stdoutText.trim();
    if (trimmed.length === 0) {
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        'Claude CLI Distiller returned empty stdout.',
      );
    }
    let parsedEnvelope: unknown;
    try {
      parsedEnvelope = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MemoryHarnessError(
        'DISTILLER_EXECUTION_FAILED',
        `Claude CLI Distiller returned invalid JSON stdout: ${message}`,
        { stdoutPreview: trimmed.slice(0, 200) },
      );
    }
    if (parsedEnvelope === null || typeof parsedEnvelope !== 'object' || Array.isArray(parsedEnvelope)) {
      return parsedEnvelope;
    }
    const envelopeRecord = parsedEnvelope as Readonly<Record<string, unknown>>;
    if (envelopeRecord['structured_output'] !== undefined && envelopeRecord['structured_output'] !== null) {
      return envelopeRecord['structured_output'];
    }
    if (typeof envelopeRecord['result'] === 'string') {
      try {
        return JSON.parse(envelopeRecord['result']);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MemoryHarnessError(
          'DISTILLER_EXECUTION_FAILED',
          `Claude CLI Distiller returned unparseable JSON string in result field: ${message}`,
          { resultPreview: envelopeRecord['result'].slice(0, 200) },
        );
      }
    }
    return parsedEnvelope;
  }
}
