import type { MemoryConfig } from '../schemas/memory-config.schema.js';

/**
 * Validated configuration bundle returned by `loadMemoryConfig`.
 */
export interface LoadedMemoryConfig {
  /** Validated `MemoryConfig` object parsed from `memory.config.json`. */
  readonly config: MemoryConfig;
  /** Absolute filesystem path of the discovered or overridden `memory.config.json` file. */
  readonly configPath: string;
  /** Pre-compiled Unicode `RegExp` instances corresponding to `config.format.forbidRegexes`. */
  readonly compiledForbidRegexes: readonly RegExp[];
}
