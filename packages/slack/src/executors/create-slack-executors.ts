import type {
  ControlPlaneASTNode,
  HumanChannelASTNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
  SlackApproverNode,
  SlackNotifierNode,
} from '@harness-dsl/core';
import { defaultSlackTransport } from './default-slack-transport.constants.js';
import { getOrCreateSlackApproverAdapter } from './internal/get-or-create-slack-approver-adapter.js';
import type { SlackApproverAdapter } from './slack-approver-adapter.js';
import { SlackNotifierAdapter } from './slack-notifier-adapter.js';
import type { SlackTransport } from './slack-transport.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/slack` human and control-plane adapters.
 *
 * Memoizes `SlackApproverAdapter` per `(RuntimeDriverContext, node)` so `humanChannels['slack:approver']`
 * and `controlPlanes['slack:approver']` share the same instance within a single runtime context.
 *
 * @param {SlackTransport} [transport=defaultSlackTransport] - Transport used for Slack API, webhook, and Socket Mode calls.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/slack`.
 */
export function createSlackExecutors(
  transport: SlackTransport = defaultSlackTransport,
): RuntimeExecutorRegistrySlice {
  const adaptersByContext = new WeakMap<
    RuntimeDriverContext,
    Map<string, SlackApproverAdapter>
  >();

  return Object.freeze<RuntimeExecutorRegistrySlice>({
    humanChannels: Object.freeze({
      'slack:approver': (
        node: HumanChannelASTNode,
        ctx: RuntimeDriverContext,
      ): SlackApproverAdapter =>
        getOrCreateSlackApproverAdapter(adaptersByContext, node as SlackApproverNode, {
          ctx,
          transport,
        }),
      'slack:notifier': (
        node: HumanChannelASTNode,
        ctx: RuntimeDriverContext,
      ): SlackNotifierAdapter =>
        new SlackNotifierAdapter(node as SlackNotifierNode, ctx, transport),
    }),
    controlPlanes: Object.freeze({
      'slack:approver': (
        node: ControlPlaneASTNode,
        ctx: RuntimeDriverContext,
      ): SlackApproverAdapter =>
        getOrCreateSlackApproverAdapter(adaptersByContext, node as SlackApproverNode, {
          ctx,
          transport,
        }),
    }),
  });
}
