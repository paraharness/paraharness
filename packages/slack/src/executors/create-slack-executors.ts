import type {
  ControlPlaneASTNode,
  HumanChannelASTNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
  SlackApproverNode,
  SlackNotifierNode,
} from '@harness-dsl/core';
import { defaultSlackTransport } from './default-slack-transport.constants.js';
import { SlackApproverAdapter } from './slack-approver-adapter.js';
import { SlackNotifierAdapter } from './slack-notifier-adapter.js';
import type { SlackTransport } from './slack-transport.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/slack` human and control-plane adapters.
 *
 * Registers `humanChannels['slack:approver']`, `humanChannels['slack:notifier']`, and
 * `controlPlanes['slack:approver']` backed by the provided `transport`.
 *
 * @param {SlackTransport} [transport=defaultSlackTransport] - Transport used for Slack API, webhook, and Socket Mode calls.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/slack`.
 */
export function createSlackExecutors(
  transport: SlackTransport = defaultSlackTransport,
): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    humanChannels: Object.freeze({
      'slack:approver': (
        node: HumanChannelASTNode,
        ctx: RuntimeDriverContext,
      ): SlackApproverAdapter =>
        new SlackApproverAdapter(node as SlackApproverNode, ctx, transport),
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
        new SlackApproverAdapter(node as SlackApproverNode, ctx, transport),
    }),
  });
}
