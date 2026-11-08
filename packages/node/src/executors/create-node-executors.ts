import type {
  NodeHttpControlPlaneNode,
  NodeMcpSseNode,
  NodeMcpStdioNode,
  NodeRunnerNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
} from '@paraharness/core';
import {
  createLocalCommandToolDriver,
  executeLocalCommandCheck,
  executeLocalCommandStep,
} from './local-command-executors.js';
import {
  createLocalServiceToolDriver,
  startLocalDaemonService,
} from './local-daemon-service.js';
import {
  createLocalStreamCheckToolDriver,
  executeLocalStreamCheck,
} from './local-stream-check-executors.js';
import {
  createNodeHttpControlPlaneAdapter,
  createNodeMcpSseAdapter,
  createNodeMcpStdioAdapter,
} from './node-control-plane-and-mcp-adapters.js';
import {
  evaluateNodeAllowBinariesGuard,
  evaluateNodeDenyNetworkGuard,
} from './node-guard-executors.js';
import { NodeRunnerDriver } from './node-runner-driver.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@paraharness/node` executors and drivers.
 *
 * Binds `node:command`, `node:command-check`, `node:command-tool`, `node:stream-check`,
 * `node:stream-check-tool`, `node:service`, `node:service-tool`, `node:allow-binaries`,
 * `node:deny-network`, `node:runner`, `node:http-control-plane`, `node:mcp-stdio`, and `node:mcp-sse`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen registry slice for `@paraharness/node`.
 */
export function createNodeExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    steps: Object.freeze({
      'node:command': executeLocalCommandStep,
      'node:stream-check': executeLocalStreamCheck,
    }),
    checks: Object.freeze({
      'node:command-check': executeLocalCommandCheck,
      'node:stream-check': executeLocalStreamCheck,
    }),
    services: Object.freeze({
      'node:service': startLocalDaemonService,
    }),
    policyGuards: Object.freeze({
      'node:allow-binaries': evaluateNodeAllowBinariesGuard,
      'node:deny-network': evaluateNodeDenyNetworkGuard,
    }),
    tools: Object.freeze({
      'node:command-tool': createLocalCommandToolDriver(),
      'node:stream-check-tool': createLocalStreamCheckToolDriver(),
      'node:service-tool': createLocalServiceToolDriver(),
    }),
    runners: Object.freeze({
      'node:runner': (node: NodeRunnerNode): NodeRunnerDriver => new NodeRunnerDriver(node),
    }),
    controlPlanes: Object.freeze({
      'node:http-control-plane': (
        node: NodeHttpControlPlaneNode,
        ctx: RuntimeDriverContext,
      ) => createNodeHttpControlPlaneAdapter(node, ctx),
      'node:mcp-stdio': (node: NodeMcpStdioNode, ctx: RuntimeDriverContext) =>
        createNodeMcpStdioAdapter(node, ctx),
      'node:mcp-sse': (node: NodeMcpSseNode, ctx: RuntimeDriverContext) =>
        createNodeMcpSseAdapter(node, ctx),
    }),
  });
}
