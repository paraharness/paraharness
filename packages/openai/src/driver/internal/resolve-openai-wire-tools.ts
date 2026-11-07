import type { ModelTurnRequest, WireToolSchema } from '@harness-dsl/core';

/**
 * Resolves OpenAI Responses API function tool definitions from `CompiledWirePrefix` or `req.wireToolSchemas`.
 *
 * Preserves identical tool definitions across `'auto'` and `'none'` tool-choice turns.
 *
 * @param {ModelTurnRequest} req - Turn request containing `wirePrefix`, `roleKey`, and `wireToolSchemas`.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} OpenAI function tool descriptors.
 */
export function resolveOpenAiWireTools(
  req: ModelTurnRequest,
): readonly Readonly<Record<string, unknown>>[] {
  const byRole = req.wirePrefix?.wireToolSchemasByRoleKey;
  const schemas: readonly WireToolSchema[] =
    (req.roleKey !== undefined ? byRole?.[req.roleKey] : undefined) ??
    byRole?.['*'] ??
    req.wireToolSchemas ??
    [];
  const tools: Readonly<Record<string, unknown>>[] = [];
  for (const schema of schemas) {
    tools.push(
      Object.freeze({
        type: 'function',
        name: schema.name,
        description: schema.description,
        parameters: schema.inputJsonSchema,
        strict: true,
      }),
    );
  }
  return Object.freeze(tools);
}
