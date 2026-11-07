/**
 * Formats the validated output of `executeLocalCommandStep` into a `ToolExecutionResult.content` string.
 *
 * Returns strings directly, converts `undefined` to an empty string, and JSON-serializes structured values.
 *
 * @param {unknown} output - Validated output returned by `executeLocalCommandStep`.
 *
 * @returns {string} Serialized tool result content string.
 */
export function formatCommandToolContent(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output === undefined) {
    return '';
  }
  return JSON.stringify(output);
}
