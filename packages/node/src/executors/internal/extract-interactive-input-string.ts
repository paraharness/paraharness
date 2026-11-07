/**
 * Extracts the string command line input from validated `.interact()` tool arguments.
 *
 * Accepts either a direct string or an object carrying a string `input` property, falling back to JSON serialization.
 *
 * @param {unknown} validatedArgs - Schema-validated tool arguments.
 *
 * @returns {string} Command string to send to the interactive PTY session.
 */
export function extractInteractiveInputString(validatedArgs: unknown): string {
  if (typeof validatedArgs === 'string') return validatedArgs;
  if (
    typeof validatedArgs === 'object' &&
    validatedArgs !== null &&
    'input' in validatedArgs &&
    typeof validatedArgs.input === 'string'
  ) {
    return validatedArgs.input;
  }
  return JSON.stringify(validatedArgs);
}
