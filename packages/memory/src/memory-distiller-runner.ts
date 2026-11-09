import type {
  DistillerStructuredOutput,
  MemoryBucketStatus,
} from './schemas/memory-tools.schema.js';

/**
 * Request payload passed to an injected `MemoryDistillerRunner` during `memory_propose`.
 */
export interface DistillerProposalRequest {
  /** Model identifier from `config.distiller.model`. */
  readonly model: string;
  /** Reasoning effort level from `config.distiller.effort`. */
  readonly effort: 'low' | 'medium' | 'high';
  /** Execution timeout in milliseconds from `config.distiller.timeoutMs`. */
  readonly timeoutMs: number;
  /** Prompt-cached system prompt containing rules, format constraints, and existing ledger records. */
  readonly systemPrompt: string;
  /** Dynamic user prompt containing the candidate text, incident context, and target bucket status. */
  readonly userPrompt: string;
  /** Target bucket capacity status. */
  readonly bucketStatus: MemoryBucketStatus;
  /** JSON Schema object generated from `DistillerStructuredOutputSchema` for structured output enforcement. */
  readonly outputJsonSchema: Readonly<Record<string, unknown>>;
}

/**
 * Port interface for executing the Distiller LLM (`claude-cli` or in-process orchestrator subagent).
 */
export interface MemoryDistillerRunner {
  /**
   * Executes the Distiller prompt and returns a validated structured proposal.
   *
   * @param {DistillerProposalRequest} request - Distiller prompt, JSON schema, and model parameters.
   *
   * @returns {Promise<DistillerStructuredOutput>} Structured Distiller match and choice analysis.
   *
   * @throws {MemoryHarnessError} With code `'DISTILLER_EXECUTION_FAILED'` when the runner fails or times out.
   */
  runDistillerProposal(request: DistillerProposalRequest): Promise<DistillerStructuredOutput>;
}
