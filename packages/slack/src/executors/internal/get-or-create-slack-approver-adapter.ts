import type { EnvRef, RuntimeDriverContext, SlackApproverNode } from '@harness-dsl/core';
import { SlackApproverAdapter } from '../slack-approver-adapter.js';
import type { SlackTransport } from '../slack-transport.js';

/**
 * Serializes a literal string or symbolic `EnvRef` into a canonical cache key segment.
 *
 * Ensures distinct `SlackApproverNode` configurations within the same `RuntimeDriverContext`
 * map to distinct cache keys while identical configurations share the same adapter instance.
 *
 * @param {string | EnvRef} value - Literal string or symbolic `EnvRef` token/channel.
 *
 * @returns {string} Canonical string representation for adapter cache indexing.
 */
export function serializeSlackTokenOrEnvRef(value: string | EnvRef): string {
  return typeof value === 'string' ? `lit:${value}` : `env:${value.key}`;
}

/**
 * Retrieves or creates the shared `SlackApproverAdapter` instance for `(ctx, node)` in `adaptersByContext`.
 *
 * Ensures `humanChannels['slack:approver']` and `controlPlanes['slack:approver']` share the same
 * `SlackApproverAdapter` instance within a single `RuntimeDriverContext`.
 *
 * @param {WeakMap<RuntimeDriverContext, Map<string, SlackApproverAdapter>>} adaptersByContext - Context-scoped adapter cache.
 * @param {SlackApproverNode}                                                node              - Passive Slack approver AST node.
 * @param {object}                                                           runtime           - Driver context and Slack transport.
 *
 * @returns {SlackApproverAdapter} Shared `SlackApproverAdapter` instance for `(runtime.ctx, node)`.
 */
export function getOrCreateSlackApproverAdapter(
  adaptersByContext: WeakMap<RuntimeDriverContext, Map<string, SlackApproverAdapter>>,
  node: SlackApproverNode,
  runtime: {
    readonly ctx: RuntimeDriverContext;
    readonly transport: SlackTransport;
  },
): SlackApproverAdapter {
  let byKey = adaptersByContext.get(runtime.ctx);
  if (byKey === undefined) {
    byKey = new Map<string, SlackApproverAdapter>();
    adaptersByContext.set(runtime.ctx, byKey);
  }
  const canonicalKey = `${serializeSlackTokenOrEnvRef(node.appToken)}|${serializeSlackTokenOrEnvRef(node.botToken)}|${serializeSlackTokenOrEnvRef(node.channel)}`;
  const existing = byKey.get(canonicalKey);
  if (existing !== undefined) {
    return existing;
  }
  const created = new SlackApproverAdapter(node, runtime.ctx, runtime.transport);
  byKey.set(canonicalKey, created);
  return created;
}
