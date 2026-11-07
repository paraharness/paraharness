import type { ServiceASTNode } from '../../ast/domain-ast.types.js';
import type { ServiceStartInput } from '../../ports/runtime-executor-registry.js';
import type { ServiceSession } from '../../ports/service-session.js';
import type { AcquireSkillServicesParams } from './acquire-skill-services-params.js';
import type { ActiveServiceEntry } from './active-service-entry.js';
import type { ReacquireSkillServicesParams } from './reacquire-skill-services-params.js';

/**
 * Reference-counted registry of active `ServiceSession` daemons keyed by `(scopeKey, serviceNode.id)` (`SPEC.md` §3.4.2).
 *
 * Manages skill-scoped service acquisition, reference-counted release on `completeSkill`,
 * step-boundary/suspension quiescing (`quiesceScopeServices`), and pre-drain re-acquisition
 * (`reacquireActiveSkillServices`) with `[SERVICE_REACQUIRED]` note generation.
 */
export class ServiceSessionRegistry {
  /** Nested map of `scopeKey -> (serviceId -> ActiveServiceEntry)`. */
  private readonly entriesByScope = new Map<string, Map<string, ActiveServiceEntry<unknown>>>();

  /**
   * Acquires or increments reference counts for all `unlockedServices` declared on `params.skill`.
   *
   * Spawns a new `ServiceSession` via `registry.services[serviceNode.type]` only when `serviceNode.id`
   * is not already running in `params.scopeKey`.
   *
   * @template THandle Runtime handle type of the active isolation scope.
   *
   * @param {AcquireSkillServicesParams<THandle>} params - Skill service acquisition parameters.
   *
   * @returns {Promise<ReadonlyMap<string, ServiceSession<THandle>>>} Live service sessions for `params.scopeKey`.
   */
  async acquireSkillServices<THandle = unknown>(
    params: AcquireSkillServicesParams<THandle>,
  ): Promise<ReadonlyMap<string, ServiceSession<THandle>>> {
    const scopeMap = this.getOrCreateScopeMap(params.scopeKey);
    for (const serviceNode of params.skill.unlockedServices) {
      const existing = scopeMap.get(serviceNode.id);
      if (existing !== undefined) {
        existing.holdingSkillIds.add(params.skill.id);
        continue;
      }
      const session = await this.startServiceDaemon(
        serviceNode,
        { runId: params.runId, scopeKey: params.scopeKey, scopeHandle: params.scopeHandle },
        params.driverContext,
      );
      scopeMap.set(serviceNode.id, {
        scopeKey: params.scopeKey,
        serviceNode,
        session,
        holdingSkillIds: new Set<string>([params.skill.id]),
      });
    }
    return this.getActiveSessionsForScope<THandle>(params.scopeKey);
  }

  /**
   * Releases a skill's reference lease across all services in `scopeKey`, stopping any daemon whose reference count drops to zero.
   *
   * Stops all zero-reference sessions via `Promise.allSettled` and rethrows the first error after all settle (`SPEC.md` §3.4.2).
   *
   * @param {string} scopeKey - Canonical scope key of the active isolation scope.
   * @param {string} skillId  - Completed skill identifier releasing its service leases.
   *
   * @returns {Promise<readonly string[]>} Identifiers of service sessions that were stopped.
   */
  async releaseSkillServices(scopeKey: string, skillId: string): Promise<readonly string[]> {
    const scopeMap = this.entriesByScope.get(scopeKey);
    if (scopeMap === undefined) return Object.freeze([]);
    const stoppedServiceIds: string[] = [];
    const sessionsToStop: ServiceSession[] = [];
    for (const [serviceId, entry] of scopeMap) {
      if (!entry.holdingSkillIds.has(skillId)) continue;
      entry.holdingSkillIds.delete(skillId);
      if (entry.holdingSkillIds.size === 0) {
        scopeMap.delete(serviceId);
        stoppedServiceIds.push(serviceId);
        sessionsToStop.push(entry.session);
      }
    }
    if (scopeMap.size === 0) {
      this.entriesByScope.delete(scopeKey);
    }
    const settled = await Promise.allSettled(sessionsToStop.map((s) => s.stop()));
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
    }
    return Object.freeze(stoppedServiceIds);
  }

  /**
   * Stops and unmounts all active `ServiceSession` daemons running in `scopeKey` (matching exact `scopeKey` and `${scopeKey}:*` sub-scopes) or across all scopes.
   *
   * Invoked at step boundaries (`.act()` to `.evaluate()`), on actor suspension, and during `.onLimitExceeded()` cleanup.
   *
   * @param {string} [scopeKey] - Optional canonical scope key or prefix to quiesce; quiesces all scopes when omitted.
   *
   * @returns {Promise<readonly string[]>} Identifiers of stopped service sessions.
   */
  async quiesceScopeServices(scopeKey?: string): Promise<readonly string[]> {
    const matchedKeys: string[] = [];
    if (scopeKey === undefined) {
      for (const key of this.entriesByScope.keys()) {
        matchedKeys.push(key);
      }
    } else {
      const prefix = `${scopeKey}:`;
      for (const key of this.entriesByScope.keys()) {
        if (key === scopeKey || key.startsWith(prefix)) {
          matchedKeys.push(key);
        }
      }
    }
    const stopped: string[] = [];
    const sessionsToStop: ServiceSession[] = [];
    for (const key of matchedKeys) {
      const scopeMap = this.entriesByScope.get(key);
      if (scopeMap === undefined) continue;
      this.entriesByScope.delete(key);
      for (const [serviceId, entry] of scopeMap) {
        stopped.push(serviceId);
        sessionsToStop.push(entry.session);
      }
    }
    const settled = await Promise.allSettled(sessionsToStop.map((s) => s.stop()));
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
    }
    return Object.freeze(stopped);
  }

  /**
   * Re-acquires background daemon sessions for all `activeSkillIds` before draining `remainingCalls` on resume (`SPEC.md` §3.4.2).
   *
   * Returns `[SERVICE_REACQUIRED]` synchronization notes for every service session started during re-acquisition.
   *
   * @template THandle Runtime handle type of the active isolation scope.
   *
   * @param {ReacquireSkillServicesParams<THandle>} params - Re-acquisition parameters and active skill IDs.
   *
   * @returns {Promise<readonly string[]>} Formatted `[SERVICE_REACQUIRED]` note strings for newly started services.
   */
  async reacquireActiveSkillServices<THandle = unknown>(
    params: ReacquireSkillServicesParams<THandle>,
  ): Promise<readonly string[]> {
    const scopeMap = this.getOrCreateScopeMap(params.scopeKey);
    const beforeIds = new Set<string>(scopeMap.keys());
    for (const skillId of params.activeSkillIds) {
      const skill = params.skillsById.get(skillId);
      if (skill === undefined) continue;
      await this.acquireSkillServices({
        runId: params.runId,
        scopeKey: params.scopeKey,
        scopeHandle: params.scopeHandle,
        skill,
        driverContext: params.driverContext,
      });
    }
    const notes: string[] = [];
    for (const serviceId of scopeMap.keys()) {
      if (!beforeIds.has(serviceId)) {
        notes.push(`[SERVICE_REACQUIRED] Service '${serviceId}' was restarted for scope '${params.scopeKey}'.`);
      }
    }
    return Object.freeze(notes);
  }

  /**
   * Returns a read-only snapshot map of active `ServiceSession` instances for `scopeKey`.
   *
   * Used to populate `ExecutionContext.activeServiceSessions` during tool and check execution.
   *
   * @template THandle Runtime handle type of the active isolation scope.
   *
   * @param {string} scopeKey - Canonical scope key.
   *
   * @returns {ReadonlyMap<string, ServiceSession<THandle>>} Map of `serviceId` to live `ServiceSession`.
   */
  getActiveSessionsForScope<THandle = unknown>(
    scopeKey: string,
  ): ReadonlyMap<string, ServiceSession<THandle>> {
    const scopeMap = this.entriesByScope.get(scopeKey);
    const sessions = new Map<string, ServiceSession<THandle>>();
    if (scopeMap === undefined) return sessions;
    for (const [serviceId, entry] of scopeMap) {
      sessions.set(serviceId, entry.session as ServiceSession<THandle>);
    }
    return sessions;
  }

  /**
   * Retrieves or creates the inner `serviceId -> ActiveServiceEntry` map for `scopeKey`.
   *
   * Lazily initializes a new `Map` and registers it under `this.entriesByScope` when `scopeKey` has no mounted services.
   *
   * @param {string} scopeKey - Canonical scope key.
   *
   * @returns {Map<string, ActiveServiceEntry<unknown>>} Mutable service map for `scopeKey`.
   */
  private getOrCreateScopeMap(scopeKey: string): Map<string, ActiveServiceEntry<unknown>> {
    const existing = this.entriesByScope.get(scopeKey);
    if (existing !== undefined) return existing;
    const created = new Map<string, ActiveServiceEntry<unknown>>();
    this.entriesByScope.set(scopeKey, created);
    return created;
  }

  /**
   * Starts a single `ServiceASTNode` daemon via `driverContext.registry.services[serviceNode.type]`.
   *
   * Throws an actionable error when no service factory is registered in `driverContext.registry.services` for `serviceNode.type`.
   *
   * @param {ServiceASTNode<unknown>}                     serviceNode   - Passive service AST node to start.
   * @param {ServiceStartInput<unknown>}                  startInput    - Run, scope key, and scope handle coordinates.
   * @param {AcquireSkillServicesParams['driverContext']} driverContext - Runtime driver context.
   *
   * @returns {Promise<ServiceSession<unknown>>} Spawned service session instance.
   */
  private async startServiceDaemon(
    serviceNode: ServiceASTNode<unknown>,
    startInput: ServiceStartInput<unknown>,
    driverContext: AcquireSkillServicesParams['driverContext'],
  ): Promise<ServiceSession<unknown>> {
    const executor = driverContext.registry.services[serviceNode.type];
    if (executor === undefined) {
      throw new Error(
        `No ServiceSession executor registered for '${serviceNode.type}' (service '${serviceNode.id}', scope '${startInput.scopeKey}').`,
      );
    }
    return executor(serviceNode as never, startInput, driverContext);
  }
}
