/**
 * Configuration options for declaring an Anthropic Claude model via `claude.model(alias, options)`.
 *
 * Specifies the provider-level model identifier transmitted to `/v1/messages` and the optional
 * extended thinking effort budget applied across turns.
 */
export interface ClaudeModelOptions {
  /** Optional Anthropic wire model identifier (defaults to `alias`, such as `'claude-sonnet-4-6'`). */
  readonly id?: string;
  /** Optional reasoning effort level controlling extended thinking budget allocation. */
  readonly effort?: 'low' | 'medium' | 'high';
}
