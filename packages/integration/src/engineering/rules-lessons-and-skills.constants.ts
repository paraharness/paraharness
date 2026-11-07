import { H } from '@harness-dsl/core';
import { fs } from '@harness-dsl/fs';
import { md } from '@harness-dsl/markdown';
import { sqlite } from '@harness-dsl/sqlite';
import { workItem } from './engineering-schemas.schema.js';
import {
  browserSandbox,
  drizzleGenerate,
  localPostgres,
  sonnet,
} from './pools-and-services.constants.js';
import { highLeverageLessonSignal } from './signals-and-interrupts.constants.js';

/**
 * Deterministic regex check (`forbid-drizzle-in-api`) preventing direct `drizzle-orm` imports in `packages/api` (`CODING_SAMPLE.md` §6.5).
 *
 * Enforced before agent stop whenever `api-orm-boundary` scoped rule is active.
 */
export const forbidDrizzleInApiCheck = fs.regexCheck('forbid-drizzle-in-api', {
  targetGlobs: ['packages/api/**/*.ts'],
  forbidPattern: /from\s+['"]drizzle-orm['"]/,
  violationMessage: 'Direct drizzle-orm imports are forbidden in packages/api; use @acme/db repositories.',
});

/**
 * Deterministic regex check (`forbid-drop-column`) preventing destructive SQL `DROP COLUMN` or `DROP TABLE` migrations (`CODING_SAMPLE.md` §6.5).
 *
 * Enforced before agent stop when `db-migrations.md` scoped rule matches modified SQL migration files.
 */
export const forbidDropColumnCheck = fs.regexCheck('forbid-drop-column', {
  targetGlobs: ['packages/db/migrations/*.sql'],
  forbidPattern: /DROP\s+(COLUMN|TABLE)/i,
  violationMessage: 'Destructive SQL migrations require explicit owner escalation.',
});

/**
 * Hybrid global and path-scoped repository rules (`repo-rules`) combining inline, Markdown, and SQLite sources (`CODING_SAMPLE.md` §6.5).
 *
 * Compiles global invariants into Slot 1 of `engineeringPrefix` and activates scoped boundary/migration checks on matching partitions and effects.
 */
export const repoRules = H.rules('repo-rules')
  .global(
    {
      id: 'no-non-null-assertions',
      directive: 'Never use TypeScript non-null assertion operators (!) in production code paths.',
    },
    md.globalRules('.harness/rules/global/*.md'),
    sqlite.globalRules('.harness/state.sqlite', { table: 'owner_global_rules' }),
  )
  .scoped(
    md.scopedRules('.harness/rules/scoped/**/*.md'),
    H.scopedRule('api-orm-boundary')
      .when({
        partitions: ['api'],
        effects: fs.matchGlobs(['packages/api/**/*.ts']),
      })
      .directive(fs.text('.harness/rules/api-orm-boundary.md'))
      .enforceBeforeStop(forbidDrizzleInApiCheck),
    H.scopedRule(md.scopedRule('.harness/rules/db-migrations.md'))
      .enforceBeforeStop(forbidDropColumnCheck),
  );

/**
 * Deduplicated, evidence-based empirical lesson store (`repo-lessons`) with contrastive distillation and retirement (`CODING_SAMPLE.md` §6.5).
 *
 * Queries lessons by work item title and description, distills failure-to-pass trajectories with `sonnet`,
 * scores with sliding-window partition boosts and epoch decay, retires low-performing lessons, and emits `highLeverageLessonSignal`.
 */
export const repoLessons = H.lessons('repo-lessons')
  .store(
    fs.jsonlLessonStore({
      definitionsDir: '.harness/lessons',
      statsPath: '.harness/lesson-stats.json',
      lockFile: '.harness/lessons.lock',
    }),
  )
  .queryFrom(workItem, (item) => `${item.title}\n${item.description}`)
  .distillWith(sonnet, ($d) =>
    $d
      .onLoopRecovery()
      .onGateRecovery({ minFailedChecks: 1 })
      .guidelines(fs.text('.harness/prompts/lesson-distiller.md')),
  )
  .scoring(($s) =>
    $s
      .slidingWindowInjections(20)
      .partitionMatchBoost(0.25)
      .decayOnPartitionEpochChange(0.85)
      .recall({ minScore: 0.2, maxItems: 5 }),
  )
  .retireAfter(($r) =>
    $r
      .maxViolations(3)
      .orMinCleanPassRate(0.35, { afterInjections: 12 }),
  )
  .emitSignalWhen(
    highLeverageLessonSignal,
    ($t) => $t.minCleanPasses(10).maxViolations(0).cooldownHours(72),
    (lesson) => ({
      lessonId: lesson.id,
      directive: lesson.directive,
      partition:
        lesson.partition === 'db'
          ? ('db' as const)
          : lesson.partition === 'api'
            ? ('api' as const)
            : lesson.partition === 'web'
              ? ('web' as const)
              : undefined,
      cleanPassCount: lesson.totalCleanPasses,
      violatedCount: lesson.totalViolated,
    }),
  );

/**
 * Progressive-disclosure database migration skill (`db-migrations`) unlocking `drizzleGenerate` and `localPostgres` (`CODING_SAMPLE.md` §6.5).
 *
 * Holds the unlocked tool and ephemeral PostgreSQL service daemon until the agent completes or exits its fork.
 */
export const dbMigrationSkill = H.skill(md.skill('.harness/skills/db-migrations/SKILL.md'))
  .unlocksTools(drizzleGenerate.asTool())
  .unlocksServices(localPostgres)
  .lease('until-completed-or-fork-exit');

/**
 * Progressive-disclosure UI verification skill (`ui-verification`) unlocking `browserSandbox` on `web` partition `.tsx` edits (`CODING_SAMPLE.md` §6.5).
 *
 * Mounts headless browser and CDP REPL tools until the agent completes or exits its fork.
 */
export const uiVerificationSkill = H.skill('ui-verification')
  .when({
    partitions: ['web'],
    effects: fs.matchGlobs(['packages/web/src/**/*.tsx']),
  })
  .description('Pull when building or verifying interactive UI components, layouts, or client state.')
  .instructions(fs.text('.harness/skills/ui-verification/instructions.md'))
  .unlocksServices(browserSandbox)
  .lease('until-completed-or-fork-exit');

/**
 * Shared procedural Markdown skill glob (`.harness/skills/shared/*.md`) available to worker agents (`CODING_SAMPLE.md` §6.5).
 *
 * Expands all Markdown skill definitions under `.harness/skills/shared/` into progressive-disclosure skill descriptors.
 */
export const sharedProceduralSkills = md.skills('.harness/skills/shared/*.md');

/**
 * Run-immutable wire prefix group (`engineering-prefix`) shared across `coordinator`, `worker`, and `evaluator` (`CODING_SAMPLE.md` §6.5).
 *
 * Uses `'role-scoped'` tools mode so each actor role caches its own clean toolset without orchestration tool bloat,
 * while keeping mutable `repoTopology` in Slot 2 so in-run contract updates never invalidate byte 0 of Slot 1.
 */
export const engineeringPrefix = H.prefixGroup('engineering-prefix')
  .toolsMode('role-scoped')
  .sharedGrounding(
    fs.text('PRODUCT_SPEC.md'),
    fs.text('TECH_DESIGN.md'),
  )
  .sharedInstructions(fs.text('.harness/prompts/base-posture.md'))
  .sharedRules(repoRules);
