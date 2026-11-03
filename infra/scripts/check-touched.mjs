#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINTED = /\.(c|m)?(j|t)sx?$/;
const COMMENT_CHECKED = /\.tsx?$/;
const COMMENT_CHECK = 'infra/scripts/strip-comments.mjs';
const TYPED = /\.(ts|tsx|mts|json)$/;
const HARNESS_CHANGE = /^\.(github|claude)\//;
const NAMED_CHANGE = /^(\.github\/|\.claude\/|infra\/(?!(.*\/)?__tests__\/))/;
const READ_WHOLE = `(?=['"\`]|/['"\`*$])`;
const CLIMB_ONLY = /^(\.\.\/)*\.\.$/;
const INFRA = 'infra';
const INFRA_TESTS = 'infra/scripts/__tests__';
const OWN_TMPDIR = 'infra/scripts/own-tmpdir.mjs';
const INFRA_SUITE = 'scripts/infra-test.sh';
const TEST_WORKERS = '--maxWorkers=4';
const USAGE = 'usage: check-touched.mjs [--direct] [--since <commit>] | check-touched.mjs --gate <base sha> <reached package dir>...';
const GATE = '--gate';
const LOCKFILE = 'pnpm-lock.yaml';
const INFRA_CONFIG = /^\.(oxlintrc\.json|mergify\.yml)$/;
const GATE_PLAN = 'infra/scripts/gate.sh';
const SINCE = '--since';
const DIRECT = '--direct';
const MAIN = 'origin/main';
const FILES_ON_STDIN = '--stdin';
const TEST_COUNT = 'infra/scripts/test-count.mjs';
const AT_ONCE = 'TEST_PACKAGES_AT_ONCE';

export const gateArgs = (argv) => {
  const [flag, base, ...reached] = argv;
  if (flag !== GATE || !base || reached.length === 0) throw new Error(USAGE);
  return { base, reached };
};

export const baseRef = (argv) => {
  if (argv.length === 0) return MAIN;
  if (argv.length === 2 && argv[0] === SINCE && argv[1]) return argv[1];
  throw new Error(USAGE);
};

export const localArgs = (argv) => {
  const rest = argv.filter((arg) => arg !== DIRECT);
  if (argv.length - rest.length > 1) throw new Error(USAGE);
  return { ref: baseRef(rest), direct: rest.length < argv.length };
};

export const ownerPackage = (path, has) => {
  for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) {
    if (has(`${dir}/package.json`)) return dir;
  }
  return null;
};

export const lintable = (files) => files.filter((file) => LINTED.test(file));

const folders = (file) => {
  const found = [];
  for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) found.push(dir);
  return found;
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const spellings = (from, target) => [target, posix.relative(from, target)].filter((name) => !CLIMB_ONLY.test(name));

const names = (text, from, file) =>
  spellings(from, file).some((name) => text.includes(name)) ||
  folders(file)
    .filter((dir) => dir.includes('/') || HARNESS_CHANGE.test(`${dir}/`))
    .some((dir) => spellings(from, dir).some((name) => new RegExp(`${escape(name)}${READ_WHOLE}`).test(text)));

export const namedTests = (changed, testFiles) =>
  testFiles.filter(({ path, text }) => changed.some((file) => names(text, posix.dirname(path), file))).map(({ path }) => path);

export const readPlan = (text) => {
  const value = (key) => text.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const lane = value('lane');
  if (!lane) throw new Error(`${GATE_PLAN} --plan named no lane`);
  const list = (key) => (value(key) ?? '').split(' ').filter(Boolean);
  return { lane, reach: list('reach'), touched: list('touched') };
};

const hasVitest = (manifest) => Boolean(manifest.devDependencies?.vitest ?? manifest.dependencies?.vitest);

const owners = (files, has) => [...new Set(files.map((file) => ownerPackage(file, has)).filter(Boolean))].sort();

const typecheckStep = (dir, manifest) => ({
  name: `typecheck ${dir}`,
  cwd: dir,
  command: manifest.scripts?.typecheck ? ['pnpm', 'run', 'typecheck'] : ['pnpm', 'exec', 'tsc', '--noEmit'],
});

const EDGE = 'apps/edge';
const EDGE_RUNNER = 'scripts/test.mjs';

const picks = (dir, base, related) => (related ? ['related', ...related.map((file) => posix.relative(dir, file)), '--run'] : ['--changed', base]);

const vitestStep = (dir, base, workers, related) => ({
  name: `vitest ${dir}`,
  cwd: dir,
  command:
    dir === INFRA
      ? ['pnpm', 'exec', 'sh', INFRA_SUITE, ...picks(dir, base, related), ...workers, '--passWithNoTests']
      : dir === EDGE
        ? ['pnpm', 'exec', 'node', posix.relative(dir, OWN_TMPDIR), 'node', EDGE_RUNNER, ...picks(dir, base, related), ...workers]
        : ['pnpm', 'exec', 'node', posix.relative(dir, OWN_TMPDIR), 'vitest', ...(related ? [] : ['run']), ...picks(dir, base, related), ...workers, '--passWithNoTests'],
});

const wholeStep = (dir, workers) => ({ name: `test ${dir}`, cwd: dir, command: ['pnpm', 'run', 'test', ...workers] });

const everyPackageStep = (workers) => ({ name: 'test every package', cwd: '.', command: ['pnpm', '-r', '--if-present', '--workspace-concurrency=1', 'run', 'test', ...workers] });

const namedStep = (named, workers) => ({ name: 'named tests', cwd: INFRA, command: ['pnpm', 'exec', 'sh', INFRA_SUITE, ...named.map((path) => posix.relative(INFRA, path)), ...workers] });

const wholeTouched = (touched, readJson, workers) => touched.filter((dir) => readJson(`${dir}/package.json`).scripts?.test).map((dir) => wholeStep(dir, workers));

export const plan = ({ base, changed, related, lane, reach, touched = [], direct = false, has, readJson, testFiles }) => {
  const present = changed.filter(has);
  const steps = [];
  const linted = lintable(present);
  if (linted.length > 0) steps.push({ name: 'oxlint', cwd: '.', command: ['pnpm', 'exec', 'oxlint', ...linted] });
  const commented = present.filter((file) => COMMENT_CHECKED.test(file));
  if (commented.length > 0) steps.push({ name: 'comments', cwd: '.', command: ['node', COMMENT_CHECK, '--check', ...commented] });
  for (const dir of owners(present.filter((file) => TYPED.test(file)), has)) {
    if (has(`${dir}/tsconfig.json`)) steps.push(typecheckStep(dir, readJson(`${dir}/package.json`)));
  }
  const full = direct ? wholeTouched(touched, readJson, [TEST_WORKERS]) : [everyPackageStep([TEST_WORKERS])];
  const tests = lane === 'full' ? full : gateTests({ base, changed, related, reached: direct ? touched : reach, readJson, testFiles, workers: [TEST_WORKERS] });
  return [...steps, ...tests];
};

export const gateTests = ({ base, changed, related, reached, readJson, testFiles, workers = [] }) => {
  const whole = (dir, manifest) => !hasVitest(manifest) || changed.includes(LOCKFILE) || (dir === INFRA && changed.some((file) => INFRA_CONFIG.test(file)));
  const steps = reached
    .map((dir) => [dir, readJson(`${dir}/package.json`)])
    .filter(([, manifest]) => manifest.scripts?.test)
    .map(([dir, manifest]) => (whole(dir, manifest) ? wholeStep(dir, workers) : vitestStep(dir, base, workers, related)));
  const infraWhole = steps.some((step) => step.name === wholeStep(INFRA, workers).name);
  const harness = changed.filter((file) => NAMED_CHANGE.test(file));
  const named = harness.length > 0 && !infraWhole ? namedTests(harness, testFiles) : [];
  return named.length > 0 ? [...steps, namedStep(named, workers)] : steps;
};

export const runSteps = async (steps, runStep, say) => {
  if (steps.length === 0) say('check: nothing to lint, type or test in this change');
  let code = 0;
  for (const step of steps) {
    say(`check: ${step.name}: ${step.command.join(' ')}`);
    const stepCode = await runStep(step);
    say(`check: ${step.name} exit ${stepCode}`);
    if (code === 0 && stepCode !== 0) code = stepCode;
  }
  return code;
};

export const runAtOnce = async (steps, runStep, say, atOnce) => {
  if (steps.length === 0) say('check: nothing to lint, type or test in this change');
  const queue = [...steps];
  const codes = new Map();
  const lane = async () => {
    for (let step = queue.shift(); step; step = queue.shift()) {
      say(`check: ${step.name} started`);
      const { code, output } = await runStep(step);
      say(`check: ${step.name}: ${step.command.join(' ')}`);
      if (output) say(output.replace(/\n$/, ''));
      say(`check: ${step.name} exit ${code}`);
      codes.set(step, code);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, steps.length) }, lane));
  const failed = steps.filter((step) => codes.get(step) !== 0);
  if (failed.length > 0) say(`check: failed: ${failed.map((step) => step.name).join(', ')}`);
  return failed.length > 0 ? codes.get(failed[0]) : 0;
};

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const lines = (text) => text.split('\n').filter(Boolean);

const changedFiles = (root, base) =>
  [
    ...new Set([
      ...lines(git(root, 'diff', '--name-only', '--no-renames', `${base}...HEAD`)),
      ...lines(git(root, 'diff', '--name-only', '--no-renames', 'HEAD')),
      ...lines(git(root, 'ls-files', '--others', '--exclude-standard')),
    ]),
  ].sort();

export const changedSince = (root, base, mainBase) => {
  const fromMain = new Set(changedFiles(root, mainBase));
  return changedFiles(root, base).filter((file) => fromMain.has(file));
};

const infraTestFiles = (root) =>
  readdirSync(join(root, INFRA_TESTS))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => ({ path: `${INFRA_TESTS}/${name}`, text: readFileSync(join(root, INFRA_TESTS, name), 'utf8') }));

const run = (root, step) =>
  new Promise((done) => {
    const child = spawn(step.command[0], step.command.slice(1), { cwd: join(root, step.cwd), stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (error) => {
      console.error(error.message);
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });

const runCaptured = (root, step) =>
  new Promise((done) => {
    const chunks = [];
    const child = spawn(step.command[0], step.command.slice(1), { cwd: join(root, step.cwd), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    const output = () => Buffer.concat(chunks).toString('utf8');
    child.on('error', (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      done({ code: 127, output: output() });
    });
    child.on('close', (code, signal) => done({ code: code ?? (signal ? 128 : 1), output: output() }));
  });

const inputs = (root) => ({
  has: (path) => existsSync(join(root, path)),
  readJson: (path) => JSON.parse(readFileSync(join(root, path), 'utf8')),
  testFiles: infraTestFiles(root),
});

const testCount = (root, base) => {
  try {
    return lines(execFileSync(process.execPath, [TEST_COUNT, '--base', base], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    return [`tests: ${TEST_COUNT} failed: ${lines(String(error.stderr ?? '')).at(-1) ?? lines(error.message)[0]}`];
  }
};

const runAll = async (steps, header, footer, root, { tail = () => [], atOnce = 1 } = {}) => {
  const say = (line) => console.log(line);
  say(header);
  const code = atOnce > 1 ? await runAtOnce(steps, (step) => runCaptured(root, step), say, atOnce) : await runSteps(steps, (step) => run(root, step), say);
  for (const line of tail()) say(line);
  say(`${footer} exit ${code}`);
  return code;
};

const gateMain = async (argv) => {
  const { base, reached } = gateArgs(argv);
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const changed = changedFiles(root, base);
  const steps = gateTests({ base, changed, reached, ...inputs(root) });
  const atOnce = Number(process.env[AT_ONCE]) || 1;
  return runAll(steps, `check: gate tests against ${base}, ${changed.length} changed files, reach ${reached.join(' ')}${atOnce > 1 ? `, ${atOnce} at once` : ''}`, `check: gate tests against ${base}`, root, { atOnce });
};

const main = async (argv) => {
  if (argv[0] === GATE) {
    try {
      return await gateMain(argv);
    } catch (error) {
      console.error(error.message);
      return 2;
    }
  }
  let ref;
  let direct;
  try {
    ({ ref, direct } = localArgs(argv));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const base = git(root, 'merge-base', 'HEAD', ref).trim();
  const since = argv.includes(SINCE);
  const mainBase = since ? git(root, 'merge-base', 'HEAD', MAIN).trim() : base;
  const changed = since ? changedSince(root, base, mainBase) : changedFiles(root, base);
  if (since && changed.length === 0) {
    console.log(`check: nothing changed since ${ref} that differs from ${MAIN}, so nothing to run`);
    return 0;
  }
  const planArgs = since ? ['--plan', '--base', mainBase, FILES_ON_STDIN] : ['--plan', '--base', base];
  let scope;
  try {
    scope = readPlan(execFileSync('bash', [GATE_PLAN, ...planArgs], { cwd: root, encoding: 'utf8', ...(since && { input: changed.join('\n') }) }));
  } catch (error) {
    console.error(`check: ${GATE_PLAN} ${planArgs.join(' ')} failed: ${error.message}`);
    return 2;
  }
  const steps = plan({ base, changed, related: since ? changed : undefined, ...scope, direct, ...inputs(root) });
  const scoped = direct ? `touched ${scope.touched.join(' ') || 'none'}` : `reach ${scope.reach.join(' ') || 'none'}`;
  const against = since ? `, only files that also differ from ${MAIN} at ${mainBase}` : '';
  return runAll(steps, `check: base ${base} (${ref})${against}, ${changed.length} changed files, lane ${scope.lane}, ${scoped}`, `check: base ${base}`, root, { tail: () => testCount(root, base) });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
