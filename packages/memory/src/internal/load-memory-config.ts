import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryHarnessError } from '../memory-harness-error.js';
import { MemoryConfigSchema, type MemoryConfig } from '../schemas/memory-config.schema.js';
import type { LoadedMemoryConfig } from './loaded-memory-config.js';
import {
  AGENTS_CONFIG_REL_PATH,
  CLAUDE_CONFIG_REL_PATH,
  COMPILED_FORBID_REGEX_CACHE,
} from './memory-protocol.constants.js';

/**
 * Resolves the target `memory.config.json` path inside `workspaceRoot`.
 *
 * Checks an explicit `configPath` override first, then `.agents/memory.config.json`, and finally
 * `.claude/memory.config.json`.
 *
 * @param {string} workspaceRoot - Absolute or relative workspace root directory.
 * @param {string} [configPath]  - Optional explicit path override to `memory.config.json`.
 *
 * @returns {string} Resolved absolute path to the existing configuration file.
 *
 * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'` if no configuration file exists at the probed paths.
 */
function resolveMemoryConfigPath(workspaceRoot: string, configPath?: string): string {
  if (configPath !== undefined) {
    const explicitPath = path.resolve(workspaceRoot, configPath);
    if (!existsSync(explicitPath)) {
      throw new MemoryHarnessError(
        'CONFIG_NOT_FOUND',
        `Unified Memory config not found at explicit path '${explicitPath}'.`,
        { probedPaths: [explicitPath] },
      );
    }
    return explicitPath;
  }
  const agentsPath = path.resolve(workspaceRoot, AGENTS_CONFIG_REL_PATH);
  if (existsSync(agentsPath)) return agentsPath;
  const claudePath = path.resolve(workspaceRoot, CLAUDE_CONFIG_REL_PATH);
  if (existsSync(claudePath)) return claudePath;
  throw new MemoryHarnessError(
    'CONFIG_NOT_FOUND',
    `Unified Memory config not found. Probed '${agentsPath}' and '${claudePath}'.`,
    { probedPaths: [agentsPath, claudePath] },
  );
}

/**
 * Reads and parses a JSON configuration file from disk, validating it against `MemoryConfigSchema`.
 *
 * @param {string} resolvedPath - Absolute filesystem path to `memory.config.json`.
 *
 * @returns {MemoryConfig} Validated `MemoryConfig` object.
 *
 * @throws {MemoryHarnessError} With `'CONFIG_VALIDATION_FAILED'` if JSON parsing or schema validation fails.
 */
function parseAndValidateConfigFile(resolvedPath: string): MemoryConfig {
  let rawJson: unknown;
  try {
    const fileText = readFileSync(resolvedPath, 'utf8');
    rawJson = JSON.parse(fileText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MemoryHarnessError(
      'CONFIG_VALIDATION_FAILED',
      `Failed to parse JSON in memory config '${resolvedPath}': ${message}`,
      { configPath: resolvedPath },
    );
  }
  const parsed = MemoryConfigSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new MemoryHarnessError(
      'CONFIG_VALIDATION_FAILED',
      `Invalid memory config at '${resolvedPath}': ${issueSummary}`,
      { configPath: resolvedPath, issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

/**
 * Compiles and caches Unicode regular expressions (`new RegExp(pattern, 'u')`) for `forbidRegexes`.
 *
 * @param {readonly string[]} patterns     - Raw regex pattern strings from `config.format.forbidRegexes`.
 * @param {string}            resolvedPath - Config file path for error attribution.
 *
 * @returns {readonly RegExp[]} Frozen array of compiled `RegExp` instances.
 *
 * @throws {MemoryHarnessError} With `'CONFIG_VALIDATION_FAILED'` if any pattern is invalid.
 */
export function compileForbidRegexes(
  patterns: readonly string[],
  resolvedPath = '<memory.config.json>',
): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const cached = COMPILED_FORBID_REGEX_CACHE.get(pattern);
    if (cached !== undefined) {
      compiled.push(cached);
      continue;
    }
    try {
      const regex = new RegExp(pattern, 'u');
      COMPILED_FORBID_REGEX_CACHE.set(pattern, regex);
      compiled.push(regex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MemoryHarnessError(
        'CONFIG_VALIDATION_FAILED',
        `Invalid forbidRegexes pattern '${pattern}' in '${resolvedPath}': ${message}`,
        { configPath: resolvedPath, pattern },
      );
    }
  }
  return Object.freeze(compiled);
}

/**
 * Discovers, parses, and validates `memory.config.json` for `workspaceRoot`, pre-compiling all
 * `format.forbidRegexes` patterns at load time per §2.1 and `Rule 4.4`.
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 * @param {string} [configPath]  - Optional explicit path override to `memory.config.json`.
 *
 * @returns {LoadedMemoryConfig} Validated configuration, resolved file path, and pre-compiled regexes.
 *
 * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'` or `'CONFIG_VALIDATION_FAILED'`.
 */
export function loadMemoryConfig(workspaceRoot: string, configPath?: string): LoadedMemoryConfig {
  const resolvedPath = resolveMemoryConfigPath(workspaceRoot, configPath);
  const config = parseAndValidateConfigFile(resolvedPath);
  const compiledForbidRegexes = compileForbidRegexes(config.format.forbidRegexes, resolvedPath);
  return Object.freeze<LoadedMemoryConfig>({
    config,
    configPath: resolvedPath,
    compiledForbidRegexes,
  });
}
