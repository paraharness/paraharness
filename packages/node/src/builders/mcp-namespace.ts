import { createMcpServerBuilder } from './create-mcp-server-builder.js';
import { createMcpSseBuilder } from './create-mcp-sse-builder.js';
import { createMcpStdioBuilder } from './create-mcp-stdio-builder.js';
import type { McpNamespace } from './mcp-namespace-contract.js';

/** Frozen `mcp.*` DSL builder namespace for `@harness-dsl/node`. */
export const mcp: McpNamespace = Object.freeze<McpNamespace>({
  server: createMcpServerBuilder,
  stdio: createMcpStdioBuilder,
  sse: createMcpSseBuilder,
});
