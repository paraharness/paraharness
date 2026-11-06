/**
 * Shared traversal context for validating partition dependencies and detecting directed cycles via 3-state DFS.
 *
 * Holds the topology identifier, known partition keys, forward dependency adjacency list,
 * mutable node visit states, and active recursion trail during build-time DAG validation.
 */
export interface TopologyDfsContext {
  /** Identifier of the topology being validated. */
  readonly topologyId: string;
  /** Set of all declared partition keys in the topology. */
  readonly knownKeys: ReadonlySet<string>;
  /** Adjacency map of `dependsOn` edges per partition. */
  readonly depsByKey: ReadonlyMap<string, readonly string[]>;
  /** Mutable 3-state DFS color map (`'unvisited' | 'visiting' | 'visited'`). */
  readonly stateByKey: Map<string, 'unvisited' | 'visiting' | 'visited'>;
  /** Active recursion stack for cycle path reporting. */
  readonly trail: string[];
}
