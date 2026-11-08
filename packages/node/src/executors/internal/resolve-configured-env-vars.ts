import type { EnvRef } from '@paraharness/core';

/**
 * Parameters for resolving static and symbolic `EnvRef` environment bindings into a target dictionary.
 *
 * Bundles the optional declared environment map, runtime `resolveEnv` callback, and mutable target record.
 */
export interface ResolveConfiguredEnvVarsParams {
  /** Optional command or check environment variable map. */
  readonly envConfig: Readonly<Record<string, string | EnvRef>> | undefined;
  /** Runtime callback resolving string literals and symbolic `EnvRef` references. */
  readonly resolveEnv: (value: string | EnvRef) => string | undefined;
  /** Mutable target environment record to populate in place. */
  readonly targetEnv: Record<string, string | undefined>;
}

/**
 * Narrowing predicate checking whether `value` is a symbolic `EnvRef` AST descriptor.
 *
 * Inspects `value.type === 'harness:env-ref'` without type casts.
 *
 * @param {string | EnvRef} value - Environment binding value.
 *
 * @returns {value is EnvRef} True when `value` is a symbolic `EnvRef`.
 */
function isEnvRefDescriptor(value: string | EnvRef): value is EnvRef {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'harness:env-ref';
}

/**
 * Resolves all declared environment variables from `params.envConfig` into `params.targetEnv`.
 *
 * Rejects missing or empty values for symbolic `EnvRef` entries so secret references fail fast.
 *
 * @param {ResolveConfiguredEnvVarsParams} params - Declared environment config, resolver, and target map.
 *
 * @throws {Error} If a symbolic `EnvRef` resolves to `undefined` or an empty string.
 */
export function resolveConfiguredEnvVars(params: ResolveConfiguredEnvVarsParams): void {
  if (params.envConfig === undefined) {
    return;
  }
  for (const [key, rawVal] of Object.entries(params.envConfig)) {
    const resolved = params.resolveEnv(rawVal);
    if (isEnvRefDescriptor(rawVal) && (resolved === undefined || resolved.length === 0)) {
      throw new Error(
        `Required environment variable '${rawVal.key}' referenced by P.env('${rawVal.key}') is not set.`,
      );
    }
    params.targetEnv[key] = resolved ?? '';
  }
}
