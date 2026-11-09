/**
 * Result returned by `ensureMemoryGitCheckout` (§8.2.1).
 */
export interface EnsureMemoryGitCheckoutResult {
  /** Whether a new `.git` repository was initialized in `<checkoutDir>`. */
  readonly initializedNewGitRepo: boolean;
  /** Whether local records were reconciled with `origin/<branch>`. */
  readonly reconciledWithRemote: boolean;
  /** Whether a Git commit was created during initialization/reconciliation. */
  readonly gitCommitted: boolean;
  /** Whether commits were pushed to `origin/<branch>` during initialization/reconciliation. */
  readonly gitPushed: boolean;
  /** Cumulative ID remapping (`oldId -> newId`) produced by any 3-way reconciliation. */
  readonly cumulativeIdRemap: ReadonlyMap<string, string>;
}
