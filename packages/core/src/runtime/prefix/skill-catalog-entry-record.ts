/**
 * Catalog entry describing a mounted skill in the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame.
 *
 * Pairs the skill identifier and description with whether its `.when.partitions` predicate
 * matches the current task's `activePartitions`.
 */
export interface SkillCatalogEntryRecord {
  /** Unique identifier of the mounted skill. */
  readonly skillId: string;
  /** Short catalog description of when to pull the skill via `activateSkill`. */
  readonly description: string;
  /** True when the skill's `.when.partitions` predicate intersects `activePartitions`. */
  readonly highlighted: boolean;
}
