import { createAllowBinariesBuilder } from './create-allow-binaries-builder.js';
import { createDenyNetworkBuilder } from './create-deny-network-builder.js';
import { createLocalCommandBuilder } from './create-local-command-builder.js';
import { createLocalDaemonBuilder } from './create-local-daemon-builder.js';
import { createLocalRunnerBuilder } from './create-local-runner-builder.js';
import { createLocalStreamCheckBuilder } from './create-local-stream-check-builder.js';
import { createMcpSseBuilder } from './create-mcp-sse-builder.js';
import { createMcpStdioBuilder } from './create-mcp-stdio-builder.js';
import type { LocalNamespace } from './local-namespace-contract.js';

/** Frozen `local.*` DSL builder namespace for `@harness-dsl/node`. */
export const local: LocalNamespace = Object.freeze<LocalNamespace>({
  runner: createLocalRunnerBuilder,
  command: createLocalCommandBuilder,
  streamCheck: createLocalStreamCheckBuilder,
  daemon: createLocalDaemonBuilder,
  allowBinaries: createAllowBinariesBuilder,
  denyNetwork: createDenyNetworkBuilder,
  mcpStdio: createMcpStdioBuilder,
  mcpSse: createMcpSseBuilder,
});
