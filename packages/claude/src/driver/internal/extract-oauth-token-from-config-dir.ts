import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CREDENTIAL_FILENAMES } from '../default-claude-http-transport.constants.js';

/**
 * Expands a leading `'~/'` home-directory prefix on a Claude CLI `configDir` path.
 *
 * Returns `configDir` unchanged when it does not begin with `'~/'`.
 *
 * @param {string} configDir - Raw `configDir` path from a `ClaudeAccountSeatNode`.
 *
 * @returns {string} Filesystem path with leading `'~/'` expanded.
 */
function expandClaudeConfigDirHome(configDir: string): string {
  if (configDir.startsWith('~/')) {
    return join(homedir(), configDir.slice(2));
  }
  return configDir;
}

/**
 * Resolves the ordered list of candidate credential file paths for a Claude CLI `configDir`.
 *
 * Returns `[resolvedDir]` when `resolvedDir` is a regular file, and otherwise joins each
 * filename in `CLAUDE_CREDENTIAL_FILENAMES`.
 *
 * @param {string} resolvedDir - Existing filesystem path to a file or directory.
 *
 * @returns {readonly string[]} Candidate credential file paths to inspect.
 */
function resolveClaudeCredentialPaths(resolvedDir: string): readonly string[] {
  if (statSync(resolvedDir).isFile()) {
    return Object.freeze([resolvedDir]);
  }
  const candidatePaths: string[] = [];
  for (const filename of CLAUDE_CREDENTIAL_FILENAMES) {
    candidatePaths.push(join(resolvedDir, filename));
  }
  return Object.freeze(candidatePaths);
}

/**
 * Extracts a bearer token string from the raw text of a Claude CLI credential file.
 *
 * Parses JSON objects for `claudeAiOauth.accessToken`, `accessToken`, `access_token`, `oauthToken`,
 * or `token`, and falls back to the raw trimmed string if the file holds a plain-text token.
 *
 * @param {string} rawText - Trimmed non-empty file contents.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no token field is present.
 */
function parseClaudeCredentialFileText(rawText: string): string | undefined {
  try {
    const parsed = JSON.parse(rawText) as Readonly<Record<string, unknown>>;
    const nested = parsed['claudeAiOauth'] as Readonly<Record<string, unknown>> | undefined;
    const token =
      nested?.['accessToken'] ??
      parsed['accessToken'] ??
      parsed['access_token'] ??
      parsed['oauthToken'] ??
      parsed['token'];
    if (typeof token === 'string' && token.trim().length > 0) {
      return token.trim();
    }
    return undefined;
  } catch {
    return rawText;
  }
}

/**
 * Extracts an OAuth bearer token string from a Claude CLI `configDir` path on disk when present.
 *
 * Searches standard credential JSON files inside `configDir` (or `configDir` directly if it is a file)
 * and reads `claudeAiOauth.accessToken`, `accessToken`, `access_token`, `oauthToken`, or `token`.
 *
 * @param {string} configDir - Filesystem path to the Claude CLI configuration directory.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no credential file exists.
 */
export function extractOAuthTokenFromConfigDir(configDir: string): string | undefined {
  const resolvedDir = expandClaudeConfigDirHome(configDir);
  if (!existsSync(resolvedDir)) {
    return undefined;
  }
  const candidatePaths = resolveClaudeCredentialPaths(resolvedDir);
  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) {
      continue;
    }
    const rawText = readFileSync(filePath, 'utf8').trim();
    if (rawText.length === 0) {
      continue;
    }
    const token = parseClaudeCredentialFileText(rawText);
    if (token !== undefined) {
      return token;
    }
  }
  return undefined;
}
