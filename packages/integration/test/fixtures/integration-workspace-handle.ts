/**
 * Handle to an initialized temporary monorepo and Git workspace fixture for `@metaharness/integration` E2E tests.
 *
 * Exposes paths to the temporary root directory, working Git repository (`packages/{db,api,web}`),
 * bare `origin` remote, SQLite ledger/topology store, and `gh` PR log file, along with a deterministic cleanup hook.
 */
export interface IntegrationWorkspaceHandle {
  /** Root temporary directory containing both the working repository, bare remote, and CLI shims. */
  readonly tempRootDir: string;
  /** Initialized working Git monorepo directory (`packages/{db,api,web}`, `.harness/**`, `PRODUCT_SPEC.md`, `TECH_DESIGN.md`). */
  readonly repoDir: string;
  /** Local bare Git remote directory registered as `origin` on `repoDir`. */
  readonly remoteBareDir: string;
  /** Path to the SQLite database file (`<repoDir>/.harness/state.sqlite`). */
  readonly sqlitePath: string;
  /** Path to the JSON file recording `gh pr create` and `gh pr view` invocations. */
  readonly ghPrsLogPath: string;
  /** Environment variable map with `PATH` prepended with the local `pnpm`/`gh` shim directory and test tokens. */
  readonly env: Readonly<Record<string, string>>;

  /**
   * Reads all pull requests recorded by the local `gh` CLI shim in `ghPrsLogPath`.
   *
   * Returns an ordered array of PR metadata objects created via `publishPr` (`gh pr create`).
   *
   * @returns {Promise<ReadonlyArray<{ readonly base: string; readonly head: string; readonly title: string; readonly body: string; readonly state: string }>>} Recorded pull request entries.
   */
  readCreatedPrs(): Promise<
    ReadonlyArray<{
      readonly base: string;
      readonly head: string;
      readonly title: string;
      readonly body: string;
      readonly state: string;
    }>
  >;

  /**
   * Restores the process working directory and `PATH` environment variable and removes `tempRootDir`.
   *
   * Safe to invoke multiple times in `afterEach` or `try / finally` blocks.
   *
   * @returns {Promise<void>} Resolves once `tempRootDir` is deleted and process state is restored.
   */
  cleanup(): Promise<void>;
}
