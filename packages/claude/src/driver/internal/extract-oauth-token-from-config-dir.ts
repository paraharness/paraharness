import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_CREDENTIAL_FILENAMES,
  CLAUDE_DEFAULT_CONFIG_SUBDIR,
  CLAUDE_KEYCHAIN_BASE_SERVICE_NAME,
  CLAUDE_KEYCHAIN_HASH_PREFIX_LENGTH,
} from '../default-claude-http-transport.constants.js';

/**
 * Optional configuration for `extractOAuthTokenFromConfigDir()`.
 *
 * Allows unit tests to override the target platform, bypass disk lookups, or inject a deterministic
 * macOS Keychain reader function.
 */
export interface ExtractOAuthTokenOptions {
  /** Target OS platform override (defaults to `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** When `true`, skips reading credential files on disk before checking macOS Keychain. */
  readonly skipDiskLookup?: boolean;
  /** Optional custom reader invoked to look up a macOS Keychain service secret by name. */
  readonly readKeychainService?: (serviceName: string) => string | undefined;
}

/**
 * Expands a leading `'~'` or `'~/'` home-directory prefix on a Claude CLI `configDir` path.
 *
 * Returns `configDir` unchanged when it does not begin with `'~'`.
 *
 * @param {string} configDir - Raw `configDir` path from a `ClaudeAccountSeatNode`.
 *
 * @returns {string} Filesystem path with leading `'~'` or `'~/'` expanded.
 */
function expandClaudeConfigDirHome(configDir: string): string {
  if (configDir === '~') {
    return homedir();
  }
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
 * Extracts a bearer token string from the raw text of a Claude CLI credential file or Keychain entry.
 *
 * Parses JSON objects for `claudeAiOauth.accessToken`, `accessToken`, `access_token`, `oauthToken`,
 * or `token`, and falls back to the raw trimmed string if the payload holds a plain-text token.
 *
 * @param {string} rawText - Trimmed non-empty credential text.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no token field is present.
 */
function parseClaudeCredentialFileText(rawText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    const nested = record['claudeAiOauth'] as Readonly<Record<string, unknown>> | undefined;
    const token =
      nested?.['accessToken'] ??
      record['accessToken'] ??
      record['access_token'] ??
      record['oauthToken'] ??
      record['token'];
    if (typeof token === 'string' && token.trim().length > 0) {
      return token.trim();
    }
    return undefined;
  } catch {
    return rawText;
  }
}

/**
 * Searches disk credential files inside `resolvedDir` for a Claude CLI OAuth bearer token.
 *
 * @param {string} resolvedDir - Expanded filesystem path to the Claude CLI configuration directory or file.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no disk credential is found.
 */
function extractDiskOAuthToken(resolvedDir: string): string | undefined {
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

/**
 * Computes the ordered list of macOS Keychain service names to query for `resolvedDir`.
 *
 * Queries `Claude Code-credentials-<sha256_prefix_8>` before falling back to `'Claude Code-credentials'`
 * when `resolvedDir` differs from the default `~/.claude` directory.
 *
 * @param {string} resolvedDir - Expanded filesystem path to the Claude CLI configuration directory.
 *
 * @returns {readonly string[]} Ordered macOS Keychain service names to inspect.
 */
function resolveClaudeKeychainServiceNames(resolvedDir: string): readonly string[] {
  const defaultConfigDir = join(homedir(), CLAUDE_DEFAULT_CONFIG_SUBDIR).normalize('NFC');
  const normalizedDir = resolvedDir.normalize('NFC');
  if (normalizedDir === defaultConfigDir) {
    return Object.freeze([CLAUDE_KEYCHAIN_BASE_SERVICE_NAME]);
  }
  const digestPrefix = createHash('sha256')
    .update(normalizedDir)
    .digest('hex')
    .slice(0, CLAUDE_KEYCHAIN_HASH_PREFIX_LENGTH);
  return Object.freeze([
    `${CLAUDE_KEYCHAIN_BASE_SERVICE_NAME}-${digestPrefix}`,
    CLAUDE_KEYCHAIN_BASE_SERVICE_NAME,
  ]);
}

/**
 * Reads a generic password secret from the macOS Keychain by service name via `/usr/bin/security`.
 *
 * Suppresses stderr and returns `undefined` when the Keychain entry is absent or inaccessible.
 *
 * @param {string} serviceName - macOS Keychain service name (`-s`).
 *
 * @returns {string | undefined} Trimmed secret payload, or `undefined` if not found.
 */
function readMacOsKeychainService(serviceName: string): string | undefined {
  try {
    const rawOutput = execFileSync('security', ['find-generic-password', '-s', serviceName, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return rawOutput.length > 0 ? rawOutput : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts an OAuth bearer token from macOS Keychain services corresponding to `resolvedDir`.
 *
 * @param {string}                                    resolvedDir - Expanded Claude CLI configuration directory path.
 * @param {(serviceName: string) => string | undefined} readService - Keychain service reader function.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no Keychain entry matches.
 */
function extractMacOsKeychainOAuthToken(
  resolvedDir: string,
  readService: (serviceName: string) => string | undefined,
): string | undefined {
  const serviceNames = resolveClaudeKeychainServiceNames(resolvedDir);
  for (const serviceName of serviceNames) {
    const rawSecret = readService(serviceName)?.trim();
    if (rawSecret === undefined || rawSecret.length === 0) {
      continue;
    }
    const token = parseClaudeCredentialFileText(rawSecret);
    if (token !== undefined) {
      return token;
    }
  }
  return undefined;
}

/**
 * Extracts an OAuth bearer token string from a Claude CLI `configDir` path on disk or macOS Keychain.
 *
 * Searches standard credential JSON files inside `configDir` first, and on macOS (`darwin`) falls back
 * to querying the `"Claude Code-credentials"` Keychain entries when no disk credential file is present.
 *
 * @param {string}                           configDir - Filesystem path to the Claude CLI configuration directory.
 * @param {ExtractOAuthTokenOptions | undefined} [options] - Optional platform and Keychain reader overrides.
 *
 * @returns {string | undefined} Extracted OAuth bearer token, or `undefined` if no credential is available.
 */
export function extractOAuthTokenFromConfigDir(
  configDir: string,
  options?: ExtractOAuthTokenOptions,
): string | undefined {
  const resolvedDir = expandClaudeConfigDirHome(configDir);
  if (options?.skipDiskLookup !== true) {
    const diskToken = extractDiskOAuthToken(resolvedDir);
    if (diskToken !== undefined) {
      return diskToken;
    }
  }
  const activePlatform = options?.platform ?? process.platform;
  if (activePlatform !== 'darwin') {
    return undefined;
  }
  const defaultConfigDir = join(homedir(), CLAUDE_DEFAULT_CONFIG_SUBDIR).normalize('NFC');
  const isDefaultConfigDir = resolvedDir.normalize('NFC') === defaultConfigDir;
  if (
    options?.readKeychainService === undefined &&
    !isDefaultConfigDir &&
    !existsSync(resolvedDir)
  ) {
    return undefined;
  }
  return extractMacOsKeychainOAuthToken(
    resolvedDir,
    options?.readKeychainService ?? readMacOsKeychainService,
  );
}
