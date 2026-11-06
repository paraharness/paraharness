export { deriveCanonicalRoleKey } from './derive-canonical-role-key.js';

/**
 * Checks whether a value is a plain JavaScript object or array that should be recursively frozen.
 *
 * Excludes functions, `RegExp` instances, `Date` instances, and Zod schema instances (`_def` present)
 * so internal validator caches and prototypes are never mutated.
 *
 * @param {unknown} value - Candidate value to inspect.
 *
 * @returns {value is Record<string, unknown> | unknown[]} True when `value` is a plain object or array.
 */
function isFreezableContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return true;
  }
  if ('_def' in value || value instanceof RegExp || value instanceof Date) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively freezes a plain object or array graph in-place using a visited set to avoid cycles.
 *
 * Traverses array elements and enumerable own-property values before applying `Object.freeze`
 * to the container reference.
 *
 * @template T Value type to freeze.
 *
 * @param {T}               value   - Target value to freeze.
 * @param {WeakSet<object>} visited - Set of already-visited object references.
 *
 * @returns {Readonly<T>} Deeply frozen value.
 */
function deepFreezeWithVisited<T>(value: T, visited: WeakSet<object>): Readonly<T> {
  if (!isFreezableContainer(value)) {
    return value;
  }
  if (visited.has(value)) {
    return value;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeWithVisited(item, visited);
    }
  } else {
    for (const key of Object.keys(value)) {
      deepFreezeWithVisited(value[key], visited);
    }
  }

  return Object.freeze(value);
}

/**
 * Deeply freezes an AST node and all nested plain objects and arrays at `.toAST()` compilation time.
 *
 * Preserves Zod schema instances and functions while guaranteeing that all AST properties, arrays,
 * and nested configuration objects satisfy `Object.isFrozen`.
 *
 * @template T AST node or plain data structure type.
 *
 * @param {T} value - Value to deeply freeze.
 *
 * @returns {Readonly<T>} Deeply frozen value.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  return deepFreezeWithVisited(value, new WeakSet<object>());
}

/**
 * Validates that an AST node identifier string is non-empty after trimming whitespace.
 *
 * Throws an actionable error naming the builder construct when an empty or whitespace-only
 * identifier string is supplied.
 *
 * @param {string} constructLabel - Construct name (`'H.agent'`, `'H.flow'`, etc.) for error reporting.
 * @param {string} id             - Identifier string to validate.
 *
 * @throws {Error} If `id` is empty or whitespace-only.
 */
export function assertNonEmptyIdentifier(constructLabel: string, id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`${constructLabel} requires a non-empty string identifier (received '${id}').`);
  }
}
