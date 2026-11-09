import { z } from 'zod';
import { MemoryRecordTypeSchema } from './memory-record.schema.js';

/**
 * Git synchronization configuration for `.memory` branch worktrees or external shared repositories.
 */
export const MemoryGitStorageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkoutDir: z.string().min(1).default('.memory'),
  remoteUrl: z.string().min(1).optional(),
  branch: z.string().min(1).default('main'),
  autoCommit: z.boolean().default(true),
  autoPush: z.boolean().default(false),
  autoPullOnInit: z.boolean().default(true),
});

/**
 * Inferred Git storage configuration type.
 */
export type MemoryGitStorageConfig = z.infer<typeof MemoryGitStorageConfigSchema>;

/**
 * Ledger file path and optional Git synchronization settings.
 */
export const MemoryStorageConfigSchema = z.object({
  ledgerPath: z.string().min(1).default('.memory/memory.jsonl'),
  git: MemoryGitStorageConfigSchema.default({
    enabled: false,
    checkoutDir: '.memory',
    branch: 'main',
    autoCommit: true,
    autoPush: false,
    autoPullOnInit: true,
  }),
});

/**
 * Inferred storage configuration type.
 */
export type MemoryStorageConfig = z.infer<typeof MemoryStorageConfigSchema>;

/**
 * Scoped or unscoped capacity rule governing soft consolidation pressure and hard rejection walls.
 *
 * @note
 * - `paths: []` (empty array) matches exclusively unscoped records (`context === undefined`).
 * - `paths: ['*']` matches any path-scoped record as a fallback per distinct context scope.
 * - Specific globs/paths in `paths` (such as `['packages/bar/**']`) define a dedicated budget for that scope.
 * - `roles: ['general']` matches only `record.role === 'general'`; `roles: ['*']` partitions into a separate per-role bucket for each role.
 * - `types` defaults to `['lesson']` when omitted so rules and notes are uncapped unless explicitly listed.
 */
export const MemoryCapRuleSchema = z
  .object({
    softCap: z.number().int().min(1),
    hardCap: z.number().int().min(1),
    roles: z.array(z.string().min(1)).min(1).default(['*']),
    paths: z.array(z.string().min(1)).default(['*']),
    types: z.array(MemoryRecordTypeSchema).min(1).default(['lesson']),
  })
  .refine((rule) => rule.hardCap >= rule.softCap, {
    message: 'hardCap must be greater than or equal to softCap.',
    path: ['hardCap'],
  });

/**
 * Inferred capacity rule configuration type.
 */
export type MemoryCapRule = z.infer<typeof MemoryCapRuleSchema>;

/**
 * Deterministic formatting constraints enforced exclusively on `type: 'lesson'` records.
 */
export const MemoryLessonFormatConfigSchema = z.object({
  maxChars: z.number().int().min(50).max(2000).default(500),
  template: z.string().min(1).default('Do <X> when <Y>, because <Z>.'),
  requireSubstrings: z.array(z.string().min(1)).default([' because ']),
  requireSingleSentence: z.boolean().default(true),
  forbidRegexes: z
    .array(z.string().min(1))
    .default([
      '\\b\\d{4}-\\d{2}-\\d{2}\\b',
      '\\b(?:TIC|CD|INC|PR|ISS)-\\d+\\b',
      '#\\d+\\b',
      '["“”„«»]',
    ]),
});

/**
 * Inferred lesson formatting configuration type.
 */
export type MemoryLessonFormatConfig = z.infer<typeof MemoryLessonFormatConfigSchema>;

/**
 * Execution runner and model configuration for the Distiller agent invoked by `memory_propose`.
 */
export const MemoryDistillerConfigSchema = z.object({
  runner: z.enum(['subagent', 'claude-cli']).default('subagent'),
  model: z.string().min(1).default('opus'),
  effort: z.enum(['low', 'medium', 'high']).default('high'),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  customInstructions: z.string().min(1).optional(),
});

/**
 * Inferred Distiller configuration type.
 */
export type MemoryDistillerConfig = z.infer<typeof MemoryDistillerConfigSchema>;

/**
 * Root configuration schema for `.agents/memory.config.json` (fallback `.claude/memory.config.json`).
 */
export const MemoryConfigSchema = z
  .object({
    repoId: z.string().min(1),
    storage: MemoryStorageConfigSchema.default({
      ledgerPath: '.memory/memory.jsonl',
      git: {
        enabled: false,
        checkoutDir: '.memory',
        branch: 'main',
        autoCommit: true,
        autoPush: false,
        autoPullOnInit: true,
      },
    }),
    allowedRoles: z
      .array(z.string().min(1))
      .min(1)
      .refine((roles) => roles.includes('general'), {
        message: 'allowedRoles must include "general".',
      }),
    maxTotalRecords: z.number().int().min(1).optional(),
    caps: z.array(MemoryCapRuleSchema).default([
      {
        roles: ['general'],
        paths: [],
        types: ['lesson'],
        softCap: 15,
        hardCap: 25,
      },
      {
        roles: ['*'],
        paths: [],
        types: ['lesson'],
        softCap: 15,
        hardCap: 25,
      },
      {
        roles: ['*'],
        paths: ['*'],
        types: ['lesson'],
        softCap: 10,
        hardCap: 20,
      },
    ]),
    format: MemoryLessonFormatConfigSchema.default({
      maxChars: 500,
      template: 'Do <X> when <Y>, because <Z>.',
      requireSubstrings: [' because '],
      requireSingleSentence: true,
      forbidRegexes: [
        '\\b\\d{4}-\\d{2}-\\d{2}\\b',
        '\\b(?:TIC|CD|INC|PR|ISS)-\\d+\\b',
        '#\\d+\\b',
        '["“”„«»]',
      ],
    }),
    distiller: MemoryDistillerConfigSchema.default({
      runner: 'subagent',
      model: 'opus',
      effort: 'high',
      timeoutMs: 120000,
    }),
  })
  .superRefine((cfg, ctx) => {
    const allowedSet = new Set(cfg.allowedRoles);
    if (allowedSet.size !== cfg.allowedRoles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedRoles'],
        message: 'allowedRoles must not contain duplicate role names.',
      });
    }
    for (let i = 0; i < cfg.caps.length; i += 1) {
      const cap = cfg.caps[i];
      if (cap === undefined) continue;
      if (new Set(cap.roles).size !== cap.roles.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'roles'],
          message: 'Cap roles must not contain duplicate entries.',
        });
      }
      if (new Set(cap.types).size !== cap.types.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'types'],
          message: 'Cap types must not contain duplicate entries.',
        });
      }
      if (cap.roles.includes('*') && cap.roles.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'roles'],
          message: 'Cap roles cannot mix "*" with specific role names.',
        });
      }
      for (const r of cap.roles) {
        if (r !== '*' && !allowedSet.has(r)) {
          ctx.addIssue({
            code: 'custom',
            path: ['caps', i, 'roles'],
            message: `Cap role '${r}' is not present in allowedRoles.`,
          });
        }
      }
      if (cap.paths.includes('*') && cap.paths.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['caps', i, 'paths'],
          message: 'Cap paths cannot mix "*" with specific path or glob patterns.',
        });
      }
      for (let j = 0; j < cap.paths.length; j += 1) {
        const rawPath = cap.paths[j];
        if (rawPath === undefined || rawPath === '*') continue;
        const trimmed = rawPath.trim();
        const posix = trimmed
          .replaceAll('\\', '/')
          .replace(/\/+/g, '/')
          .replace(/^(\.\/)+/, '')
          .replace(/\/$/, '');
        const segments = posix.length === 0 ? [] : posix.split('/');
        if (
          trimmed.length === 0 ||
          posix.length === 0 ||
          trimmed.startsWith('/') ||
          /^[A-Za-z]:/.test(trimmed) ||
          /^[A-Za-z]:/.test(posix) ||
          segments.some((seg) => seg === '..' || seg === '.')
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['caps', i, 'paths', j],
            message: `Invalid cap path pattern '${rawPath}'.`,
          });
        }
      }
    }
    if (
      cfg.storage.git.autoPush &&
      (!cfg.storage.git.autoCommit || cfg.storage.git.remoteUrl === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'git', 'autoPush'],
        message:
          'storage.git.autoPush requires storage.git.autoCommit === true and a non-empty storage.git.remoteUrl.',
      });
    }
    const normLedger = cfg.storage.ledgerPath
      .trim()
      .replaceAll('\\', '/')
      .replace(/\/+/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/$/, '');
    const ledgerSegs = normLedger.length === 0 ? [] : normLedger.split('/');
    const hasInvalidLedgerPath =
      normLedger.length === 0 ||
      normLedger.startsWith('/') ||
      /^[A-Za-z]:/.test(normLedger) ||
      ledgerSegs.some((seg) => seg === '..' || seg === '.');
    if (hasInvalidLedgerPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'ledgerPath'],
        message: `Invalid storage.ledgerPath ('${cfg.storage.ledgerPath}'). Must be a relative path inside the workspace.`,
      });
    }
    if (cfg.storage.git.enabled) {
      const normCheckout = cfg.storage.git.checkoutDir
        .trim()
        .replaceAll('\\', '/')
        .replace(/\/+/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/\/$/, '');
      const checkoutSegs =
        normCheckout === '.' || normCheckout === '' ? [] : normCheckout.split('/');
      const hasInvalidCheckoutPath =
        normCheckout.length === 0 ||
        normCheckout.startsWith('/') ||
        /^[A-Za-z]:/.test(normCheckout) ||
        (normCheckout !== '.' && checkoutSegs.some((seg) => seg === '..' || seg === '.'));
      if (hasInvalidCheckoutPath) {
        ctx.addIssue({
          code: 'custom',
          path: ['storage', 'git', 'checkoutDir'],
          message: `Invalid storage.git.checkoutDir ('${cfg.storage.git.checkoutDir}'). Must be a relative directory path inside the workspace.`,
        });
      }
      const insideCheckout =
        !hasInvalidLedgerPath &&
        !hasInvalidCheckoutPath &&
        (checkoutSegs.length === 0 ||
          (normLedger.startsWith(`${normCheckout}/`) &&
            normLedger.length > normCheckout.length + 1));
      if (!insideCheckout) {
        ctx.addIssue({
          code: 'custom',
          path: ['storage', 'ledgerPath'],
          message: `storage.ledgerPath ('${cfg.storage.ledgerPath}') must resolve inside storage.git.checkoutDir ('${cfg.storage.git.checkoutDir}') when storage.git.enabled is true.`,
        });
      }
    }
    for (let i = 0; i < cfg.format.forbidRegexes.length; i += 1) {
      const pattern = cfg.format.forbidRegexes[i];
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'u');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['format', 'forbidRegexes', i],
          message: `Invalid regular expression pattern '${pattern}'.`,
        });
      }
    }
  });

/**
 * Inferred root configuration type for the Unified Memory Harness.
 */
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
