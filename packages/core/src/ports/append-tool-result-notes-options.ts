/**
 * Options for `ModelDriver.appendToolResultNotes()`.
 *
 * Controls whether the targeted `tool_result` block is marked with `isError: true` when appending notes.
 */
export interface AppendToolResultNotesOptions {
  /** When `true`, marks the targeted tool result block as an error (`isError: true`). */
  readonly isError?: boolean;
}
