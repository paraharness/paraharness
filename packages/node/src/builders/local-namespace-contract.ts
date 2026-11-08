import type {
  AstBuilder,
  NodeAllowBinariesNode,
  NodeDenyNetworkNode,
  NodeMcpSseNode,
  NodeMcpStdioNode,
} from '@paraharness/core';
import type { LocalCommandBuilder } from './local-command-builder.js';
import type { LocalDaemonBuilder } from './local-daemon-builder.js';
import type { LocalRunnerBuilder } from './local-runner-builder.js';
import type { LocalStreamCheckBuilder } from './local-stream-check-builder.js';
import type { McpServerOptions } from './mcp-namespace-contract.js';

/**
 * Configuration options for creating a local OS subprocess and daemon runner pool (`local.runner`).
 *
 * Defines the concurrency limits separating one-shot subprocess slots (`slots`) from long-lived
 * background daemon sessions (`maxDaemons`).
 */
export interface LocalRunnerOptions {
  /** Optional unique identifier for the runner pool (defaults to `'default-runner'`). */
  readonly id?: string;
  /** Maximum number of concurrent one-shot command or stream-check subprocesses. */
  readonly slots: number;
  /** Optional maximum number of concurrent background daemon sessions (defaults to `slots`). */
  readonly maxDaemons?: number;
}

/**
 * Public `local.*` DSL builder namespace exported by `@paraharness/node`.
 *
 * Provides declarative builders for local OS process pools (`local.runner`), one-shot commands
 * (`local.command`), streaming verification checks (`local.streamCheck`), background daemons
 * (`local.daemon`), subprocess policy guards (`local.allowBinaries`, `local.denyNetwork`), and
 * MCP transports (`local.mcpStdio`, `local.mcpSse`).
 */
export interface LocalNamespace {
  /**
   * Creates a local OS subprocess and daemon concurrency pool (`local.runner`).
   *
   * Separates one-shot command slots (`slots`) from long-lived daemon slots (`maxDaemons`).
   *
   * @param {LocalRunnerOptions} options - Runner pool concurrency options.
   *
   * @returns {LocalRunnerBuilder} Frozen runner pool builder.
   */
  runner(options: LocalRunnerOptions): LocalRunnerBuilder;

  /**
   * Creates a fluent builder for a one-shot local OS subprocess command (`local.command(id)`).
   *
   * Compiles to `LocalCommandNode` and supports `.asCheck()` and `.asTool()` projections.
   *
   * @param {string} id - Unique identifier of the command.
   *
   * @returns {LocalCommandBuilder<unknown, unknown, unknown>} Fluent command builder.
   */
  command(id: string): LocalCommandBuilder<unknown, unknown, unknown>;

  /**
   * Creates a fluent builder for a streaming subprocess check (`local.streamCheck(id)`).
   *
   * Streams combined `stdout` and `stderr` through a rolling multi-line regex circuit breaker.
   *
   * @template THandle Runtime handle type of the active isolation scope.
   *
   * @param {string} id - Unique identifier of the streaming check.
   *
   * @returns {LocalStreamCheckBuilder<THandle>} Fluent stream check builder.
   */
  streamCheck<THandle = unknown>(id: string): LocalStreamCheckBuilder<THandle>;

  /**
   * Creates a fluent builder for a lifecycle-bound background daemon service (`local.daemon(id)`).
   *
   * Manages dynamic port allocation, hash-suffixed `scopeKey` sanitization, TCP readiness, and PTY interactions.
   *
   * @param {string} id - Unique identifier of the daemon service.
   *
   * @returns {LocalDaemonBuilder} Fluent daemon builder.
   */
  daemon(id: string): LocalDaemonBuilder;

  /**
   * Creates a policy guard restricting subprocess execution to an explicit allowlist of binaries.
   *
   * Compiles to `NodeAllowBinariesNode` (`type: 'node:allow-binaries'`).
   *
   * @param {readonly string[]} binaries - Allowed executable binary names.
   *
   * @returns {AstBuilder<NodeAllowBinariesNode> & NodeAllowBinariesNode} Frozen allow-binaries guard node.
   */
  allowBinaries(
    binaries: readonly string[],
  ): AstBuilder<NodeAllowBinariesNode> & NodeAllowBinariesNode;

  /**
   * Creates a policy guard denying outbound network access for guarded subprocesses.
   *
   * Compiles to `NodeDenyNetworkNode` (`type: 'node:deny-network'`).
   *
   * @returns {AstBuilder<NodeDenyNetworkNode> & NodeDenyNetworkNode} Frozen deny-network guard node.
   */
  denyNetwork(): AstBuilder<NodeDenyNetworkNode> & NodeDenyNetworkNode;

  /**
   * Creates an MCP stdio control-plane descriptor (`local.mcpStdio`).
   *
   * Compiles to `NodeMcpStdioNode` (`type: 'node:mcp-stdio'`).
   *
   * @param {string} [serverName='metaharness-mcp'] - Logical MCP server name.
   *
   * @returns {AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode} Frozen MCP stdio control-plane node.
   */
  mcpStdio(serverName?: string): AstBuilder<NodeMcpStdioNode> & NodeMcpStdioNode;

  /**
   * Creates an MCP HTTP/SSE control-plane descriptor (`local.mcpSse`).
   *
   * Compiles to `NodeMcpSseNode` (`type: 'node:mcp-sse'`).
   *
   * @param {McpServerOptions} options - TCP port configuration.
   *
   * @returns {AstBuilder<NodeMcpSseNode> & NodeMcpSseNode} Frozen MCP SSE control-plane node.
   */
  mcpSse(options: McpServerOptions): AstBuilder<NodeMcpSseNode> & NodeMcpSseNode;
}
