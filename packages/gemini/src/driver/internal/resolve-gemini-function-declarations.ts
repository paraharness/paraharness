import type { ModelTurnRequest, WireToolSchema } from '@metaharness/core';

/**
 * Resolves Gemini `functionDeclarations` tool descriptors from `CompiledWirePrefix` or `req.wireToolSchemas`.
 *
 * Preserves identical `functionDeclarations` across `'auto'` and `'none'` tool-choice turns.
 *
 * @param {ModelTurnRequest} req - Turn request containing `wirePrefix`, `roleKey`, and `wireToolSchemas`.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} Gemini function declarations array.
 */
export function resolveGeminiFunctionDeclarations(
  req: ModelTurnRequest,
): readonly Readonly<Record<string, unknown>>[] {
  const byRole = req.wirePrefix?.wireToolSchemasByRoleKey;
  const schemas: readonly WireToolSchema[] =
    (req.roleKey !== undefined ? byRole?.[req.roleKey] : undefined) ??
    byRole?.['*'] ??
    req.wireToolSchemas ??
    [];
  const declarations: Readonly<Record<string, unknown>>[] = [];
  for (const schema of schemas) {
    declarations.push(
      Object.freeze({
        name: schema.name,
        description: schema.description,
        parametersJsonSchema: schema.inputJsonSchema,
      }),
    );
  }
  return Object.freeze(declarations);
}
