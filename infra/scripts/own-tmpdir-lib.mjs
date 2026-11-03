/**
 * What `own-tmpdir.mjs` does, as functions a test can call (see that file for
 * why it exists). This file never runs anything when it is imported: the CLI
 * is `own-tmpdir.mjs`, which runs `main` unconditionally, so there is no "am I
 * the main module?" check anywhere to get wrong (cold review of 02ce616: that
 * check compared a symlink-resolved `import.meta.url` with an unresolved
 * `process.argv[1]`, and through a symlinked path the wrapper exited 0
 * without running the command at all).
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The prefix every folder this makes starts with. */
export const OWN_TMPDIR_PREFIX = 'wg-run-';

export const RAM_TMPDIR = '/dev/shm';

export const PARENT_VAR = 'OWN_TMPDIR_PARENT';

const writable = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export function ownTmpdirParent(env = process.env, ram = RAM_TMPDIR) {
  return env[PARENT_VAR] || (writable(ram) ? ram : tmpdir());
}

export function diskReason(env = process.env, ram = RAM_TMPDIR) {
  if (env[PARENT_VAR]) return `${PARENT_VAR} is set to ${env[PARENT_VAR]}`;
  return writable(ram) ? null : `${ram} cannot be written`;
}

/** The environment a command runs in: `env`, with every temp variable at `dir`. */
export function ownTmpdirEnv(env, dir) {
  return { ...env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs `command` with `args` in a fresh temp directory under `parent`, removes
 * it, and resolves with how the command ended.
 */
export function runWithOwnTmpdir(command, args, { env = process.env, parent = ownTmpdirParent(env) } = {}) {
  const dir = mkdtempSync(join(parent, OWN_TMPDIR_PREFIX));
  const child = spawn(command, args, { stdio: 'inherit', env: ownTmpdirEnv(env, dir) });
  const forward = (signal) => child.kill(signal);
  for (const signal of FORWARDED) process.on(signal, forward);
  const done = new Promise((resolve) => {
    const finish = (outcome) => {
      for (const signal of FORWARDED) process.off(signal, forward);
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      resolve({ ...outcome, dir });
    };
    child.on('error', (error) => finish({ code: 127, signal: null, error }));
    child.on('exit', (code, signal) => finish({ code, signal }));
  });
  return done;
}

/**
 * The CLI: runs `argv` and answers with the exit code the process should end
 * with — or ends it with the signal the command died of, so a caller's own
 * trap sees that signal.
 */
export async function main(argv) {
  const [command, ...args] = argv;
  if (command === undefined) {
    process.stderr.write('usage: own-tmpdir.mjs <command> [args...]\n');
    return 2;
  }
  const reason = diskReason();
  if (reason !== null) process.stderr.write(`own-tmpdir: temp folder under ${ownTmpdirParent()}, not in memory: ${reason}\n`);
  const outcome = await runWithOwnTmpdir(command, args);
  if (outcome.error !== undefined) {
    process.stderr.write(`own-tmpdir: could not run ${command}: ${outcome.error.message}\n`);
    return 127;
  }
  if (outcome.signal !== null && outcome.signal !== undefined) {
    process.kill(process.pid, outcome.signal);
    return 1;
  }
  return outcome.code ?? 1;
}
