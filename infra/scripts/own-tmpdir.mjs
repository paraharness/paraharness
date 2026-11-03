#!/usr/bin/env node
/**
 * Runs ONE command with a temp directory of its own, and removes it after.
 *
 *   node infra/scripts/own-tmpdir.mjs <command> [args...]
 *
 * WHY (register, 24 Sep, the disk: ~3,900 folders and ~12 GB in `/tmp`). Each
 * folder is `/tmp/<nanoid>/ssr/<sha1>` or `…/client/<sha1>`, and the files in
 * them are Vite's SSR transform of a module — `__vite_ssr_exportName__` — which
 * is VITEST, not the web export it was first blamed on: an `expo export` writes
 * only caches it reuses — `metro-cache`, `node-compile-cache` and one
 * `metro-file-map-<project>` per checkout (measured with a private `TMPDIR`,
 * 2026-09-24). Vitest 5's forks pool copies every module it transforms into
 * `os.tmpdir()/<nanoid>/<environment>/` — `ssr` for a node suite, `client` for
 * a jsdom one — and never removes that folder: the root project's fetcher
 * writes under `Vitest._tmpDir`, while `TestProject.clearTmpDir()` removes the
 * project's own `tmpDir`, a different folder nothing wrote to. One folder per
 * `vitest run`, every package, every gate, every unit. Playwright's own
 * profiles and artifacts (`playwright_chromiumdev_profile-*`,
 * `playwright-artifacts-*`, `.org.chromium.Chromium.*`) are left the same way
 * by any run that does not finish cleanly — 344 MB of them on the same day.
 *
 * So the scripts that run vitest, and the two e2e scripts with the export
 * each one builds, run under this: the command sees `TMPDIR`, `TMP` and `TEMP`
 * pointing at a folder made for it in `/dev/shm` (memory) whatever `TMPDIR` the
 * caller has, inside `OWN_TMPDIR_PARENT` when that is set, inside the real temp
 * directory when memory cannot be written, and the
 * folder goes when the command does — on success, on failure and on Ctrl-C
 * alike, with the command's own exit code or signal passed through. A command
 * that is SIGKILLed is no exception: this process sees it end, removes the
 * folder and dies of the same signal. What nothing can clean up after is THIS
 * process being SIGKILLed — no handler runs, so the folder stays, and the
 * command, which nothing forwards that signal to, runs on without it; the
 * folder is named `wg-run-*` so it can be found. The export scripts themselves
 * are left as they are: they are what the production web build runs, and what
 * they leave is caches they reuse.
 *
 * The one suite that does NOT run under this is `@wg/infra`'s own, which holds
 * this file's tests (`infra/package.json`): a wrapper that lost exit codes
 * would otherwise pass its own failing tests, and a commit touching only this
 * file inherits a gate that runs exactly that suite (cold review of 02ce616).
 *
 * This file is the CLI and nothing else — it runs `main` whenever Node runs it,
 * with no "am I the main module?" check to go wrong through a symlinked path
 * (the same review). The functions, and their tests, are
 * `own-tmpdir-lib.mjs`'s.
 */
import { main } from './own-tmpdir-lib.mjs';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
