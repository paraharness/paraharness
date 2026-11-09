import type {
  DistillerProposalRequest,
  MemoryDistillerRunner,
} from '../../src/memory-distiller-runner.js';
import type { DistillerStructuredOutput } from '../../src/schemas/memory-tools.schema.js';

/**
 * Handler callback or static response item queued in `FakeMemoryDistillerRunner`.
 */
export interface FakeDistillerResponderOptions {
  /** Optional custom handler invoked on each `runDistillerProposal` call. */
  readonly onProposal?: (
    request: DistillerProposalRequest,
  ) => DistillerStructuredOutput | Promise<DistillerStructuredOutput>;
  /** Optional initial FIFO queue of deterministic `DistillerStructuredOutput` responses. */
  readonly queuedOutputs?: readonly DistillerStructuredOutput[];
}

/**
 * Deterministic test double implementing `MemoryDistillerRunner` for `memory_propose` tests (`Rule 6.1`).
 *
 * Records every received `DistillerProposalRequest` in `requests` and resolves from either an
 * injected `onProposal` callback or a FIFO queue of `DistillerStructuredOutput` payloads.
 */
export class FakeMemoryDistillerRunner implements MemoryDistillerRunner {
  /** Ordered list of `DistillerProposalRequest` payloads received by this runner. */
  readonly requests: DistillerProposalRequest[] = [];

  /** Internal FIFO queue of scripted `DistillerStructuredOutput` responses. */
  private readonly responseQueue: DistillerStructuredOutput[];

  /** Optional dynamic handler function invoked when present. */
  private onProposalHandler:
    | ((
        request: DistillerProposalRequest,
      ) => DistillerStructuredOutput | Promise<DistillerStructuredOutput>)
    | undefined;

  /**
   * Creates a new `FakeMemoryDistillerRunner` instance.
   *
   * @param {FakeDistillerResponderOptions} [options={}] - Optional initial response queue or custom handler.
   */
  constructor(options: FakeDistillerResponderOptions = {}) {
    this.responseQueue = options.queuedOutputs !== undefined ? [...options.queuedOutputs] : [];
    this.onProposalHandler = options.onProposal;
  }

  /**
   * Appends a deterministic `DistillerStructuredOutput` to the response queue.
   *
   * @param {DistillerStructuredOutput} output - Structured Distiller output to enqueue.
   *
   * @returns {void}
   */
  enqueueOutput(output: DistillerStructuredOutput): void {
    this.responseQueue.push(output);
  }

  /**
   * Sets or replaces the dynamic proposal handler callback.
   *
   * @param {((request: DistillerProposalRequest) => DistillerStructuredOutput | Promise<DistillerStructuredOutput>) | undefined} handler - Handler callback or `undefined`.
   *
   * @returns {void}
   */
  setHandler(
    handler:
      | ((
          request: DistillerProposalRequest,
        ) => DistillerStructuredOutput | Promise<DistillerStructuredOutput>)
      | undefined,
  ): void {
    this.onProposalHandler = handler;
  }

  /**
   * Records `request` and returns the next scripted or dynamically computed `DistillerStructuredOutput`.
   *
   * @param {DistillerProposalRequest} request - Distiller prompt, JSON schema, and model parameters.
   *
   * @returns {Promise<DistillerStructuredOutput>} Scripted Distiller structured output.
   *
   * @throws {Error} When neither an `onProposal` handler nor a queued output is available.
   */
  async runDistillerProposal(
    request: DistillerProposalRequest,
  ): Promise<DistillerStructuredOutput> {
    this.requests.push(request);
    if (this.onProposalHandler !== undefined) {
      return await this.onProposalHandler(request);
    }
    const nextOutput = this.responseQueue.shift();
    if (nextOutput === undefined) {
      throw new Error('FakeMemoryDistillerRunner response queue exhausted.');
    }
    return nextOutput;
  }
}
