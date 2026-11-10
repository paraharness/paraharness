import type { ClaudeHttpRequest } from './claude-http-request.js';
import type { ClaudeHttpResponse } from './claude-http-response.js';
import type { ClaudeHttpTransport } from './claude-http-transport.js';
import { sendClaudeMessagesViaSdk } from './internal/send-claude-messages-via-sdk.js';

/** Default Anthropic Messages API HTTPS endpoint URL. */
export const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Default Anthropic API version header value. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Required `anthropic-beta` header value for Claude Code OAuth bearer authentication (`'claude-code-20250219,oauth-2025-04-20'`). */
export const ANTHROPIC_OAUTH_BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20';

/** Mandatory leading `system[0]` text block required by Anthropic `/v1/messages` when authenticating via a Claude Code CLI OAuth seat. */
export const CLAUDE_CODE_OAUTH_SYSTEM_PREAMBLE_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Token prefix identifying an Anthropic OAuth access token (`'sk-ant-oat'`). */
export const CLAUDE_OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/** Default Claude Code configuration directory name under the user's home directory (`'.claude'`). */
export const CLAUDE_DEFAULT_CONFIG_SUBDIR = '.claude';

/** Base macOS Keychain service name storing Claude Code OAuth credentials (`'Claude Code-credentials'`). */
export const CLAUDE_KEYCHAIN_BASE_SERVICE_NAME = 'Claude Code-credentials';

/** Prefix length of the SHA-256 hex digest appended to custom `configDir` Keychain service names. */
export const CLAUDE_KEYCHAIN_HASH_PREFIX_LENGTH = 8;

/** Divisor converting raw token counts to thousands of tokens (`1_000`). */
export const TOKENS_PER_THOUSAND = 1_000;

/** USD pricing per `1,000` input and output tokens keyed by Claude model family (`'opus' | 'sonnet' | 'haiku'`). */
export const CLAUDE_MODEL_PRICING_PER_THOUSAND_TOKENS: Readonly<
  Record<'opus' | 'sonnet' | 'haiku', Readonly<{ readonly inputUsd: number; readonly outputUsd: number }>>
> = Object.freeze({
  opus: Object.freeze({ inputUsd: 0.015, outputUsd: 0.075 }),
  sonnet: Object.freeze({ inputUsd: 0.003, outputUsd: 0.015 }),
  haiku: Object.freeze({ inputUsd: 0.001, outputUsd: 0.005 }),
});

/** Default `max_tokens` ceiling sent on Anthropic `/v1/messages` requests. */
export const DEFAULT_CLAUDE_MAX_TOKENS = 16_384;

/** Extended thinking token budgets keyed by reasoning effort level (`'low' | 'medium' | 'high'`). */
export const CLAUDE_THINKING_BUDGETS: Readonly<Record<'low' | 'medium' | 'high', number>> =
  Object.freeze({
    low: 2_048,
    medium: 8_192,
    high: 16_384,
  });

/** Candidate credential filenames searched inside a Claude CLI `configDir`. */
export const CLAUDE_CREDENTIAL_FILENAMES: readonly string[] = Object.freeze([
  '.credentials.json',
  'credentials.json',
  'oauth.json',
  'auth.json',
]);

/** Default `@anthropic-ai/sdk`-backed HTTP transport implementation for Anthropic `/v1/messages`. */
export const defaultClaudeHttpTransport: ClaudeHttpTransport = Object.freeze<ClaudeHttpTransport>({
  /**
   * Dispatches a `/v1/messages` POST request via the official `@anthropic-ai/sdk` client.
   *
   * Forwards `request` directly to `sendClaudeMessagesViaSdk()`.
   *
   * @param {ClaudeHttpRequest} request - Wire-formatted Anthropic `/v1/messages` request.
   *
   * @returns {Promise<ClaudeHttpResponse>} HTTP status, parsed body, and optional `resetAtMs`.
   *
   * @throws {Error} If `request.signal` is aborted or a network transport exception occurs.
   */
  sendMessagesRequest(request: ClaudeHttpRequest): Promise<ClaudeHttpResponse> {
    return sendClaudeMessagesViaSdk(request);
  },
});
