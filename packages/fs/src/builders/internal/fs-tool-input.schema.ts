import { z } from '@paraharness/core';

/**
 * Zod input schema for `FsReadToolNode` (`fs:read` / `read_file`).
 *
 * Validates that the caller provides a non-empty workspace-relative `path` string.
 */
export const FsReadToolInputSchema = z.object({
  path: z.string().min(1),
});

/**
 * Validated input payload for `read_file`.
 */
export type FsReadToolInput = z.infer<typeof FsReadToolInputSchema>;

/**
 * Zod input schema for `FsEditToolNode` (`fs:edit` / `edit_file`).
 *
 * Validates the target file `path`, exact `oldString` to locate, and replacement `newString`.
 */
export const FsEditToolInputSchema = z.object({
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
});

/**
 * Validated input payload for `edit_file`.
 */
export type FsEditToolInput = z.infer<typeof FsEditToolInputSchema>;

/**
 * Zod input schema for `FsWriteToolNode` (`fs:write` / `write_file`).
 *
 * Validates the workspace-relative destination `path` and full UTF-8 `content`.
 */
export const FsWriteToolInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/**
 * Validated input payload for `write_file`.
 */
export type FsWriteToolInput = z.infer<typeof FsWriteToolInputSchema>;

/**
 * Zod input schema for `FsGlobToolNode` (`fs:glob` / `glob_files`).
 *
 * Validates a non-empty POSIX glob `pattern`.
 */
export const FsGlobToolInputSchema = z.object({
  pattern: z.string().min(1),
});

/**
 * Validated input payload for `glob_files`.
 */
export type FsGlobToolInput = z.infer<typeof FsGlobToolInputSchema>;

/**
 * Zod input schema for `FsGrepToolNode` (`fs:grep` / `grep_files`).
 *
 * Validates regular expression `pattern` and optional `glob` and regex `flags`.
 */
export const FsGrepToolInputSchema = z.object({
  pattern: z.string().min(1),
  glob: z.string().optional(),
  flags: z.string().optional(),
});

/**
 * Validated input payload for `grep_files`.
 */
export type FsGrepToolInput = z.infer<typeof FsGrepToolInputSchema>;

/**
 * Zod telemetry schema for `FsTelemetryCollectorNode` (`fs:telemetry`).
 *
 * Validates distinct `filesRead` and `filesMutated` path arrays collected per step.
 */
export const FsTelemetryMetricsSchema = z.object({
  filesRead: z.array(z.string()).readonly(),
  filesMutated: z.array(z.string()).readonly(),
});

/**
 * Validated telemetry metrics shape for `fs.telemetry()`.
 */
export type FsTelemetryMetrics = z.infer<typeof FsTelemetryMetricsSchema>;
