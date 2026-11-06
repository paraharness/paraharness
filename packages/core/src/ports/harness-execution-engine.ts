import type { AstBuilder } from '../ast/ast-builder.js';
import type { HarnessNode } from '../ast/harness-node.js';
import type { HarnessRuntime } from './harness-runtime.js';
import type { HarnessRuntimeOptions } from './harness-runtime-options.js';

/**
 * Factory interface for swappable execution engines that instantiate a `HarnessRuntime` from a passive `HarnessNode`.
 *
 * Decouples declarative AST construction from concrete runtime orchestration engines.
 */
export interface HarnessExecutionEngine {
  /**
   * Creates a new `HarnessRuntime` instance bound to the given declarative `HarnessNode` AST.
   *
   * Extracts the passive `HarnessNode` when a builder is supplied and binds the provided
   * executor registry and environment variable map without starting background loops until `start()` is called.
   *
   * @param {HarnessNode | AstBuilder<HarnessNode>} harness   - Compiled `HarnessNode` or `H.harness(...)` builder.
   * @param {HarnessRuntimeOptions}                 [options] - Optional executor registry and environment map.
   *
   * @returns {HarnessRuntime} Configured runtime instance ready to `start()`.
   */
  createRuntime(
    harness: HarnessNode | AstBuilder<HarnessNode>,
    options?: HarnessRuntimeOptions,
  ): HarnessRuntime;
}
