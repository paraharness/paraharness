import type { ModelTurnRequest, WireToolSchema } from '@harness-dsl/core';

/**
 * Resolves the wire tool schemas for `req` from `CompiledWirePrefix` or `req.wireToolSchemas`.
 *
 * Preserves identical tool definitions across both `'auto'` and `'none'` tool-choice turns so
 * Anthropic's KV prefix cache remains valid during epistemic flush turns.
 *
 * @param {ModelTurnRequest} req - Turn request containing `wirePrefix`, `roleKey`, and `wireToolSchemas`.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} Anthropic wire tool descriptors.
 */
export function resolveAnthropicWireTools(
  req: ModelTurnRequest,
): readonly Readonly<Record<string, unknown>>[] {
  const byRole = req.wirePrefix?.wireToolSchemasByRoleKey;
  const roleTools = req.roleKey !== undefined ? byRole?.[req.roleKey] : undefined;
  const schemas: readonly WireToolSchema[] =
    roleTools ?? byRole?.['*'] ?? req.wireToolSchemas ?? [];
  const tools: Readonly<Record<string, unknown>>[] = [];
  for (const schema of schemas) {
    tools.push(
      Object.freeze({
        name: schema.name,
        description: schema.description,
        input_schema: schema.inputJsonSchema,
      }),
    );
  }
  return Object.freeze(tools);
}
