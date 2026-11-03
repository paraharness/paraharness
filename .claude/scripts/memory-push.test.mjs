import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "memory-push.sh");
const branch = "memory";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete gitEnv.MEMORY_SESSION;
delete gitEnv.CLAUDE_CODE_SESSION_ID;
const session = "s1";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function identify(clone) {
  git(clone, "config", "user.name", "Test");
  git(clone, "config", "user.email", "test@example.com");
}

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-push-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", "-b", branch, seed);
  identify(seed);
  writeFileSync(join(seed, "x.md"), "line one\nline two\n");
  git(seed, "add", "x.md");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", origin, `${branch}:${branch}`);
  git(origin, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  const A = join(root, "A");
  const B = join(root, "B");
  for (const clone of [A, B]) {
    git(root, "clone", "-q", origin, clone);
    identify(clone);
  }
  return { root, origin, A, B };
}

function execScript(cwd, scriptEnv, paths) {
  const result = spawnSync(script, paths, { cwd, env: scriptEnv, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sessionEnv(env, id) {
  return { MEMORY_SESSION: id, CLAUDE_HARNESS_DIR: join(env.root, "harness") };
}

function savedDir(env, id = session) {
  return join(env.root, "harness", id, "memory-push");
}

function runDirs(env, id = session) {
  const dir = savedDir(env, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)).sort();
}

function version(env, id = session) {
  return ` (your version: ${runDirs(env, id).at(-1)})`;
}

function runAs(env, dir, id, ...paths) {
  return execScript(env.root, { ...gitEnv, ...sessionEnv(env, id), MEMORY_DIR: dir }, paths);
}

function saved(env, file, id = session) {
  return readFileSync(join(runDirs(env, id).at(-1), file), "utf8");
}

function shortSha(clone, sha) {
  return git(clone, "rev-parse", "--short", sha).trim();
}

function headBody(clone) {
  return git(clone, "log", "-1", "--format=%B", "HEAD");
}

function run(env, dir, ...paths) {
  return runAs(env, dir, session, ...paths);
}

function runFrom(env, cwd, extra, ...paths) {
  const scriptEnv = { ...gitEnv, ...sessionEnv(env, session), ...extra };
  delete scriptEnv.MEMORY_DIR;
  return execScript(cwd, scriptEnv, paths);
}

function rejectPushes(env) {
  const hook = join(env.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  return () => rmSync(hook);
}

function keepCommit(env, clone, id, file, content) {
  const allow = rejectPushes(env);
  writeFileSync(join(clone, file), content);
  const r = runAs(env, clone, id, file);
  assert.equal(r.stdout.trim(), `push blocked: push rejected twice ${file}`);
  allow();
  return git(clone, "rev-parse", "HEAD").trim();
}

function productWithMemory(env) {
  const P = join(env.root, "P");
  git(env.root, "init", "-q", "-b", "main", P);
  identify(P);
  writeFileSync(join(P, "readme.md"), "p\n");
  git(P, "add", "readme.md");
  git(P, "commit", "-q", "-m", "product");
  const memory = join(P, ".memory");
  git(env.root, "clone", "-q", env.origin, memory);
  identify(memory);
  return { P, memory };
}

function originTip(env) {
  return git(env.origin, "rev-parse", branch).trim();
}

function originFile(env, file) {
  return git(env.origin, "show", `${branch}:${file}`);
}

async function holdLock(t, lock) {
  const holder = spawn("flock", [lock, "sleep", "5"], { detached: true, stdio: "ignore" });
  t.after(() => {
    try {
      process.kill(-holder.pid, "SIGKILL");
    } catch {}
  });
  const deadline = Date.now() + 3000;
  while (spawnSync("flock", ["-n", lock, "true"]).status === 0) {
    assert.ok(Date.now() < deadline, "lock holder never took the lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function originFiles(env) {
  return git(env.origin, "ls-tree", "--name-only", branch).split("\n").filter(Boolean);
}

function failingGit(env, pattern) {
  const bin = join(env.root, "bin");
  mkdirSync(bin, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *"${pattern}"*) echo "fake failure" >&2; exit 1;; esac\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

function runWith(env, extra, ...paths) {
  return execScript(env.root, { ...gitEnv, ...sessionEnv(env, session), MEMORY_DIR: env.A, ...extra }, paths);
}

async function killDuringFetch(env, ...paths) {
  const slow = join(env.root, "slow-upload-pack");
  writeFileSync(slow, "#!/bin/sh\nsleep 3\nexec git-upload-pack \"$@\"\n");
  chmodSync(slow, 0o755);
  git(env.A, "config", "remote.origin.uploadpack", slow);
  const child = spawn(script, paths, { cwd: env.root, env: { ...gitEnv, ...sessionEnv(env, session), MEMORY_DIR: env.A }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  child.kill("SIGTERM");
  await exited;
  git(env.A, "config", "--unset", "remote.origin.uploadpack");
  return stdout;
}

function commitAndPush(clone, file, content) {
  writeFileSync(join(clone, file), content);
  git(clone, "add", file);
  git(clone, "commit", "-q", "-m", `change ${file}`);
  git(clone, "push", "-q", "origin", `HEAD:${branch}`);
}

test("stages only the named paths", (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "a.md"), "a\n");
  writeFileSync(join(env.A, "b.md"), "b\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "pushed: a.md");
  const files = originFiles(env);
  assert.ok(files.includes("a.md"));
  assert.ok(!files.includes("b.md"));
  assert.match(git(env.A, "status", "--porcelain"), /^\?\? b\.md$/m);
});

test("pushes a removal", (t) => {
  const env = setup(t);
  rmSync(join(env.A, "x.md"));
  const r = run(env, env.A, "x.md");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!originFiles(env).includes("x.md"));
});

test("pushes a move when both ends are named", (t) => {
  const env = setup(t);
  renameSync(join(env.A, "x.md"), join(env.A, "y.md"));
  const r = run(env, env.A, "x.md", "y.md");
  assert.equal(r.code, 0, r.stderr);
  const files = originFiles(env);
  assert.ok(files.includes("y.md"));
  assert.ok(!files.includes("x.md"));
});

test("blocks when nothing is staged", (t) => {
  const env = setup(t);
  const r = run(env, env.A, "x.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: nothing staged x.md");
});

test("blocks while another run holds the lock", async (t) => {
  const env = setup(t);
  const lock = join(env.A, ".git", "memory-push.lock");
  await holdLock(t, lock);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: lock held a.md (${lock})`);
});

test("blocks on git's dirty-tree refusal and saves the writer's edit", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "from B\n");
  const before = git(env.A, "rev-parse", "HEAD").trim();
  writeFileSync(join(env.A, "x.md"), "uncommitted in A\n");
  writeFileSync(join(env.A, "n.md"), "n\n");
  const r = run(env, env.A, "n.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: dirty tree n.md (x.md) (HEAD stays behind the remote: another session's change)${version(env)}`);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), before);
  assert.ok(!existsSync(join(env.A, "n.md")));
  assert.equal(saved(env, "n.md"), "n\n");
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "uncommitted in A\n");
});

test("aborts a merge conflict and names the file", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const r = run(env, env.A, "x.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict x.md (x.md)${version(env)}`);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  assert.doesNotMatch(git(env.A, "status", "--porcelain"), /^UU /m);
});

test("merges a newer origin and pushes without rebasing", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "b.md", "b\n");
  const bSha = git(env.B, "rev-parse", "HEAD").trim();
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr);
  const files = originFiles(env);
  assert.ok(files.includes("a.md"));
  assert.ok(files.includes("b.md"));
  assert.ok(git(env.A, "log", "--format=%H").split("\n").includes(bSha));
});

test("blocks when the push is rejected twice", (t) => {
  const env = setup(t);
  const hook = join(env.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: push rejected twice a.md");
});

test("pushes on the retry after one rejected push", (t) => {
  const env = setup(t);
  const hook = join(env.origin, "hooks", "pre-receive");
  const marker = join(env.origin, "hooks", "rejected-once");
  writeFileSync(hook, `#!/bin/sh\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 1\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "pushed: a.md");
  assert.ok(existsSync(marker));
  assert.ok(originFiles(env).includes("a.md"));
});

test("resolves the main checkout's memory from a git worktree", (t) => {
  const env = setup(t);
  const { P, memory } = productWithMemory(env);
  const wt = join(env.root, "wt");
  git(P, "worktree", "add", "-q", wt, "-b", "wt");
  writeFileSync(join(memory, "a.md"), "a\n");
  const r = runFrom(env, wt, {}, "a.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stdout.trim(), "pushed: a.md");
  assert.ok(originFiles(env).includes("a.md"));
});

test("blocks outside any git repository", (t) => {
  const env = setup(t);
  const empty = join(env.root, "empty");
  mkdirSync(empty);
  const r = runFrom(env, empty, { GIT_CEILING_DIRECTORIES: env.root }, "a.md");
  assert.equal(r.code, 1);
  assert.ok(r.stdout.startsWith("push blocked: no memory checkout"), r.stdout);
});

test("takes its lock in the memory checkout's git dir", (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(env.A, ".git", "memory-push.lock")));
});

test("leaves another session's staged file out of the commit and staged", (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "s.md"), "s\n");
  git(env.A, "add", "s.md");
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr);
  const files = originFiles(env);
  assert.ok(files.includes("a.md"));
  assert.ok(!files.includes("s.md"));
  assert.match(git(env.A, "status", "--porcelain"), /^A {2}s\.md$/m);
});

test("pushes a kept commit on the retry", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "line one\nline two\nB line three\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  writeFileSync(join(env.A, "n.md"), "n\n");
  const first = run(env, env.A, "n.md");
  assert.equal(first.code, 1);
  assert.equal(first.stdout.trim(), `push blocked: dirty tree n.md (x.md) (HEAD stays behind the remote: another session's change)${version(env)}`);
  writeFileSync(join(env.A, "n.md"), saved(env, "n.md"));
  git(env.A, "add", "x.md");
  git(env.A, "commit", "-q", "-m", "kept x.md", "--trailer", `Memory-Session: ${session}`);
  const otherPush = spawnSync("git", ["push", "-q", "origin", `HEAD:${branch}`], { cwd: env.A, env: gitEnv });
  assert.notEqual(otherPush.status, 0);
  const second = run(env, env.A, "n.md");
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(second.stdout.trim(), "pushed: n.md");
  assert.ok(originFiles(env).includes("n.md"));
  assert.equal(originFile(env, "x.md"), "A line one\nline two\nB line three\n");
});

test("leaves the tree at the remote tip after a conflict and pushes the re-applied line", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const first = run(env, env.A, "x.md");
  assert.equal(first.code, 1);
  assert.equal(first.stdout.trim(), `push blocked: merge conflict x.md (x.md)${version(env)}`);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "B line one\nline two\nA appended\n");
  const second = run(env, env.A, "x.md");
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(originFile(env, "x.md"), "B line one\nline two\nA appended\n");
});

test("keeps the commit when the fetch fails and pushes it on the retry", (t) => {
  const env = setup(t);
  const url = git(env.A, "remote", "get-url", "origin").trim();
  git(env.A, "remote", "set-url", "origin", join(env.root, "missing.git"));
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 1);
  assert.ok(r.stdout.startsWith("push blocked: pull failed a.md ("), r.stdout);
  assert.equal(r.stdout.split("\n").filter(Boolean).length, 1);
  assert.match(headBody(env.A), new RegExp(`^Memory-Session: ${session}$`, "m"));
  assert.equal(git(env.A, "rev-parse", "HEAD~1").trim(), originTip(env));
  assert.equal(readFileSync(join(env.A, "a.md"), "utf8"), "a\n");
  assert.ok(!existsSync(savedDir(env)));
  git(env.A, "remote", "set-url", "origin", url);
  const retry = run(env, env.A, "a.md");
  assert.equal(retry.code, 0, retry.stderr + retry.stdout);
  assert.equal(retry.stdout.trim(), "pushed: a.md");
  assert.equal(originFile(env, "a.md"), "a\n");
});

test("blocks when the commit fails", (t) => {
  const env = setup(t);
  const C = join(env.root, "C");
  git(env.root, "clone", "-q", env.origin, C);
  git(C, "config", "user.useConfigOnly", "true");
  writeFileSync(join(C, "a.md"), "a\n");
  const scriptEnv = { ...gitEnv, ...sessionEnv(env, session), MEMORY_DIR: C };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
    delete scriptEnv[name];
  }
  const r = execScript(env.root, scriptEnv, ["a.md"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: commit failed a.md (Author identity unknown)");
});

test("prints usage with no arguments", (t) => {
  const env = setup(t);
  const r = run(env, env.A);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test("never stages everything and never rebases", () => {
  const text = readFileSync(script, "utf8");
  for (const forbidden of ["add -A", "add .", "rebase", "@{upstream}", "merge-tree"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
});

test("resolves the checkout from inside .memory", (t) => {
  const env = setup(t);
  const { memory } = productWithMemory(env);
  writeFileSync(join(memory, "a.md"), "a\n");
  const r = runFrom(env, memory, {}, "a.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stdout.trim(), "pushed: a.md");
  assert.ok(originFiles(env).includes("a.md"));
});

test("pushes without an upstream and pushes a kept commit with nothing new staged", (t) => {
  const env = setup(t);
  git(env.A, "branch", "--unset-upstream");
  writeFileSync(join(env.A, "a.md"), "a\n");
  const first = run(env, env.A, "a.md");
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert.equal(first.stdout.trim(), "pushed: a.md");
  keepCommit(env, env.A, session, "b.md", "b\n");
  assert.ok(!originFiles(env).includes("b.md"));
  const second = run(env, env.A, "b.md");
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(second.stdout.trim(), "pushed: b.md");
  assert.ok(originFiles(env).includes("b.md"));
});

test("a conflict on one named path saves every named path", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  writeFileSync(join(env.A, "new.md"), "new\n");
  const r = run(env, env.A, "x.md", "new.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict x.md new.md (x.md)${version(env)}`);
  assert.ok(!existsSync(join(env.A, "new.md")));
  assert.equal(saved(env, "new.md"), "new\n");
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "B line one\nline two\n");
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
});

test("another session's kept commit and staged file survive a dirty-tree block", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "y.md", "base\n");
  git(env.A, "fetch", "-q", "origin");
  git(env.A, "merge", "-q", "--ff-only", `origin/${branch}`);
  const s1Sha = keepCommit(env, env.A, "s1", "s1.md", "s1\n");
  writeFileSync(join(env.A, "staged.md"), "staged\n");
  git(env.A, "add", "staged.md");
  commitAndPush(env.B, "y.md", "B\n");
  writeFileSync(join(env.A, "y.md"), "S2\n");
  const r = runAs(env, env.A, "s2", "y.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: dirty tree y.md (staged.md) (another session's commit ${shortSha(env.A, s1Sha)} is unpushed)${version(env, "s2")}`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), s1Sha);
  assert.equal(readFileSync(join(env.A, "s1.md"), "utf8"), "s1\n");
  assert.match(git(env.A, "status", "--porcelain"), /^A {2}staged\.md$/m);
  assert.equal(readFileSync(join(env.A, "y.md"), "utf8"), "base\n");
  assert.equal(saved(env, "y.md", "s2"), "S2\n");
});

test("drops our own kept commit on a later conflict", (t) => {
  const env = setup(t);
  keepCommit(env, env.A, "s2", "a.md", "a\n");
  commitAndPush(env.B, "a.md", "B\n");
  const r = runAs(env, env.A, "s2", "a.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict a.md (a.md)${version(env, "s2")}`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(readFileSync(join(env.A, "a.md"), "utf8"), "B\n");
  assert.equal(saved(env, "a.md", "s2"), "a\n");
  assert.equal(git(env.A, "status", "--porcelain").trim(), "");
});

test("drops only our own kept commit and keeps another session's beneath it", (t) => {
  const env = setup(t);
  const s1Sha = keepCommit(env, env.A, "s1", "s1.md", "s1\n");
  writeFileSync(join(env.A, "a.md"), "a\n");
  git(env.A, "add", "a.md");
  git(env.A, "commit", "-q", "-m", "memory: a.md", "--trailer", "Memory-Session: s2");
  commitAndPush(env.B, "a.md", "B\n");
  const r = runAs(env, env.A, "s2", "a.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict a.md (a.md) (another session's commit ${shortSha(env.A, s1Sha)} is unpushed)${version(env, "s2")}`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), s1Sha);
  assert.equal(readFileSync(join(env.A, "s1.md"), "utf8"), "s1\n");
  assert.ok(!existsSync(join(env.A, "a.md")));
  assert.equal(saved(env, "a.md", "s2"), "a\n");
});

test("keeps another session's conflicting kept commit and saves the writer's edit", (t) => {
  const env = setup(t);
  const s1Sha = keepCommit(env, env.A, "s1", "x.md", "S1 line one\nline two\n");
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "n.md"), "n\n");
  const r = runAs(env, env.A, "s2", "n.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict n.md (x.md) (another session's commit ${shortSha(env.A, s1Sha)} is unpushed)${version(env, "s2")}`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), s1Sha);
  assert.ok(!existsSync(join(env.A, "n.md")));
  assert.equal(saved(env, "n.md", "s2"), "n\n");
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "S1 line one\nline two\n");
});

test("names every conflicting file", (t) => {
  const env = setup(t);
  writeFileSync(join(env.B, "y.md"), "B y\n");
  git(env.B, "add", "y.md");
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  writeFileSync(join(env.A, "y.md"), "A y\n");
  const r = run(env, env.A, "x.md", "y.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict x.md y.md (x.md y.md)${version(env)}`);
});

test("commits with the session trailer", (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(git(env.origin, "log", "-1", "--format=%B", branch), new RegExp(`^Memory-Session: ${session}$`, "m"));
});

test("blocks without a session id", (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = execScript(env.root, { ...gitEnv, MEMORY_DIR: env.A }, ["a.md"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: no session id a.md");
});

test("blocks before touching the tree when the save folder cannot be made", (t) => {
  const env = setup(t);
  const readOnly = join(env.root, "ro");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o500);
  t.after(() => existsSync(readOnly) && chmodSync(readOnly, 0o700));
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const before = git(env.A, "rev-parse", "HEAD").trim();
  const r = execScript(env.root, { ...gitEnv, MEMORY_SESSION: session, CLAUDE_HARNESS_DIR: join(readOnly, "harness"), MEMORY_DIR: env.A }, ["x.md"]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.startsWith("push blocked: no save folder x.md"), r.stdout);
  assert.match(headBody(env.A), new RegExp(`^Memory-Session: ${session}$`, "m"));
  assert.equal(git(env.A, "rev-parse", "HEAD~1").trim(), before);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "A line one\nline two\n");
});

test("blocks a named directory before staging anything", (t) => {
  const env = setup(t);
  mkdirSync(join(env.A, "tasks"));
  writeFileSync(join(env.A, "tasks", "t.md"), "t\n");
  const head = git(env.A, "rev-parse", "HEAD").trim();
  const status = git(env.A, "status", "--porcelain", "--untracked-files=all");
  const r = run(env, env.A, "tasks");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: not a file tasks (tasks)");
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), head);
  assert.equal(git(env.A, "status", "--porcelain", "--untracked-files=all"), status);
});

test("a run killed mid-fetch leaves no half state and the next run pushes", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const stdout = await killDuringFetch(env, "a.md");
  assert.ok(stdout.startsWith("push blocked:"), stdout);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  const status = git(env.A, "status", "--porcelain");
  assert.doesNotMatch(status, /^(MM|UU|AA) /m);
  if (existsSync(join(env.A, "a.md"))) {
    assert.equal(readFileSync(join(env.A, "a.md"), "utf8"), "a\n");
  } else {
    assert.equal(saved(env, "a.md"), "a\n");
    assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
    writeFileSync(join(env.A, "a.md"), saved(env, "a.md"));
  }
  const next = run(env, env.A, "a.md");
  assert.equal(next.code, 0, next.stderr + next.stdout);
  assert.equal(next.stdout.trim(), "pushed: a.md");
  assert.equal(originFile(env, "a.md"), "a\n");
});

test("drops its own merge commit and kept commits on a later conflict", (t) => {
  const env = setup(t);
  keepCommit(env, env.A, session, "a.md", "a\n");
  commitAndPush(env.B, "y.md", "B y\n");
  const allow = rejectPushes(env);
  const retry = run(env, env.A, "a.md");
  assert.equal(retry.stdout.trim(), "push blocked: push rejected twice a.md");
  assert.equal(git(env.A, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length, 3);
  assert.match(headBody(env.A), new RegExp(`^Memory-Session: ${session}$`, "m"));
  allow();
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const r = run(env, env.A, "x.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict x.md (x.md)${version(env)}`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "B line one\nline two\n");
  assert.ok(!existsSync(join(env.A, "a.md")));
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
  assert.equal(saved(env, "a.md"), "a\n");
  assert.ok(!existsSync(join(runDirs(env).at(-1), "y.md")));
  assert.equal(git(env.A, "status", "--porcelain").trim(), "");
});

test("names another session's kept commit beneath its own dropped commit", (t) => {
  const env = setup(t);
  const s1Sha = keepCommit(env, env.A, "s1", "s1.md", "s1\n");
  commitAndPush(env.B, "y.md", "B\n");
  writeFileSync(join(env.A, "y.md"), "S2\n");
  const r = runAs(env, env.A, "s2", "y.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict y.md (y.md) (another session's commit ${shortSha(env.A, s1Sha)} is unpushed)${version(env, "s2")}`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), s1Sha);
  assert.ok(!existsSync(join(env.A, "y.md")));
  assert.equal(saved(env, "y.md", "s2"), "S2\n");
});

test("keeps another session's staged entries unchanged after a block", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "b.md", "b\n");
  writeFileSync(join(env.A, "staged.md"), "staged\n");
  git(env.A, "add", "staged.md");
  git(env.A, "mv", "x.md", "moved.md");
  const others = git(env.A, "status", "--porcelain");
  writeFileSync(join(env.A, "n.md"), "n\n");
  const r = run(env, env.A, "n.md");
  assert.equal(r.code, 1);
  assert.ok(r.stdout.startsWith("push blocked: dirty tree n.md ("), r.stdout);
  assert.equal(git(env.A, "status", "--porcelain"), others);
  assert.equal(saved(env, "n.md"), "n\n");
});

test("counts only this session's unpushed commits as something to push", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "y.md", "y\n");
  git(env.A, "fetch", "-q", "origin");
  git(env.A, "merge", "-q", "--ff-only", `origin/${branch}`);
  keepCommit(env, env.A, "s1", "s1.md", "s1\n");
  const r = runAs(env, env.A, "s2", "y.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: nothing staged y.md");
  const retry = runAs(env, env.A, "s1", "s1.md");
  assert.equal(retry.code, 0, retry.stderr + retry.stdout);
  assert.equal(retry.stdout.trim(), "pushed: s1.md");
  assert.equal(originFile(env, "s1.md"), "s1\n");
});

test("blocks a path that neither exists nor is tracked before staging", (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "x.md"), "changed\n");
  const head = git(env.A, "rev-parse", "HEAD").trim();
  const r = run(env, env.A, "x.md", "typo.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), "push blocked: not a file x.md typo.md (typo.md)");
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), head);
  assert.equal(git(env.A, "status", "--porcelain"), " M x.md\n");
});

test("the merge commit it pushes carries the session trailer", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "b.md", "b\n");
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(git(env.origin, "rev-list", "--parents", "-n", "1", branch).trim().split(" ").length, 3);
  assert.match(git(env.origin, "log", "-1", "--format=%B", branch), new RegExp(`^Memory-Session: ${session}$`, "m"));
});

test("saves every path of a dropped kept commit, not only the named ones", (t) => {
  const env = setup(t);
  keepCommit(env, env.A, session, "k.md", "kept\n");
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const r = run(env, env.A, "x.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout.trim(), `push blocked: merge conflict x.md (x.md)${version(env)}`);
  assert.equal(saved(env, "k.md"), "kept\n");
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
  assert.ok(!existsSync(join(env.A, "k.md")));
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
});

test("pushes a staged move when both ends are named", (t) => {
  const env = setup(t);
  commitAndPush(env.A, "a.md", "a\n");
  git(env.A, "mv", "a.md", "b.md");
  const r = run(env, env.A, "a.md", "b.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stdout.trim(), "pushed: a.md b.md");
  const files = originFiles(env);
  assert.ok(files.includes("b.md"));
  assert.ok(!files.includes("a.md"));
});

test("pushes a staged removal", (t) => {
  const env = setup(t);
  git(env.A, "rm", "-q", "x.md");
  const r = run(env, env.A, "x.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stdout.trim(), "pushed: x.md");
  assert.ok(!originFiles(env).includes("x.md"));
});

test("pushes a removal on the retry after a failed commit", (t) => {
  const env = setup(t);
  const hook = join(env.A, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  rmSync(join(env.A, "x.md"));
  const first = run(env, env.A, "x.md");
  assert.equal(first.code, 1);
  assert.equal(first.stdout, "push blocked: commit failed x.md (hook says no)\n");
  assert.equal(git(env.A, "status", "--porcelain"), "D  x.md\n");
  rmSync(hook);
  const second = run(env, env.A, "x.md");
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(second.stdout.trim(), "pushed: x.md");
  assert.ok(!originFiles(env).includes("x.md"));
});

test("a non-ASCII path goes through the conflict block and pushes on the retry", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  writeFileSync(join(env.A, "tâche.md"), "t\n");
  const r = run(env, env.A, "x.md", "tâche.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, `push blocked: merge conflict x.md tâche.md (x.md)${version(env)}\n`);
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
  assert.equal(saved(env, "tâche.md"), "t\n");
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  writeFileSync(join(env.A, "tâche.md"), saved(env, "tâche.md"));
  writeFileSync(join(env.A, "x.md"), "B line one\nline two\nA appended\n");
  const second = run(env, env.A, "x.md", "tâche.md");
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(second.stdout.trim(), "pushed: x.md tâche.md");
  assert.equal(originFile(env, "tâche.md"), "t\n");
});

test("a failing put-back step still prints one line", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const r = runWith(env, failingGit(env, " restore "), "x.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, `push blocked: merge conflict x.md (x.md) (put-back incomplete: restore)${version(env)}\n`);
});

test("says HEAD stays behind when another session's change refuses the fast-forward", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "y.md", "base\n");
  git(env.A, "fetch", "-q", "origin");
  git(env.A, "merge", "-q", "--ff-only", `origin/${branch}`);
  writeFileSync(join(env.B, "y.md"), "B y\n");
  git(env.B, "add", "y.md");
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "y.md"), "other session\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const r = runAs(env, env.A, "s2", "x.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, `push blocked: dirty tree x.md (y.md) (HEAD stays behind the remote: another session's change)${version(env, "s2")}\n`);
  assert.notEqual(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(readFileSync(join(env.A, "y.md"), "utf8"), "other session\n");
  assert.equal(saved(env, "x.md", "s2"), "A line one\nline two\n");
});

test("blocks before pushing another session's commit and pushes once that session has", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "y.md", "base\n");
  git(env.A, "fetch", "-q", "origin");
  git(env.A, "merge", "-q", "--ff-only", `origin/${branch}`);
  const s1Sha = keepCommit(env, env.A, "s1", "k.md", "k\n");
  writeFileSync(join(env.A, "y.md"), "S2\n");
  const blocked = runAs(env, env.A, "s2", "y.md");
  assert.equal(blocked.code, 1);
  assert.equal(blocked.stdout, `push blocked: another session's commit y.md (${shortSha(env.A, s1Sha)} is unpushed)${version(env, "s2")}\n`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), s1Sha);
  assert.equal(readFileSync(join(env.A, "y.md"), "utf8"), "base\n");
  assert.equal(saved(env, "y.md", "s2"), "S2\n");
  assert.ok(!originFiles(env).includes("k.md"));
  const s1 = runAs(env, env.A, "s1", "k.md");
  assert.equal(s1.code, 0, s1.stderr + s1.stdout);
  assert.equal(s1.stdout.trim(), "pushed: k.md");
  writeFileSync(join(env.A, "y.md"), saved(env, "y.md", "s2"));
  const s2 = runAs(env, env.A, "s2", "y.md");
  assert.equal(s2.code, 0, s2.stderr + s2.stdout);
  assert.equal(s2.stdout.trim(), "pushed: y.md");
  assert.equal(originFile(env, "k.md"), "k\n");
  assert.equal(originFile(env, "y.md"), "S2\n");
});

test("clears its save folder after a successful push", (t) => {

  const env = setup(t);
  mkdirSync(savedDir(env), { recursive: true });
  writeFileSync(join(savedDir(env), "stale.md"), "stale\n");
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(join(savedDir(env), "stale.md")));
});

for (const [step, pattern] of [["reset", "reset -q --soft"], ["merge --abort", "merge --abort"]]) {
  test(`names this session's own commit on top when the put-back ${step} fails`, (t) => {
    const env = setup(t);
    commitAndPush(env.B, "x.md", "B line one\nline two\n");
    writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
    const r = runWith(env, failingGit(env, pattern), "x.md");
    assert.equal(r.code, 1);
    assert.match(headBody(env.A), new RegExp(`^Memory-Session: ${session}$`, "m"));
    assert.equal(r.stdout, `push blocked: merge conflict x.md (x.md) (put-back incomplete: ${step}; your commit ${shortSha(env.A, "HEAD")} is on top)${version(env)}\n`);
  });
}

for (const pattern of ["commit -q --no-edit", "merge --no-commit"]) {
  test(`keeps the commit when the merge fails at ${pattern} and pushes it on the rerun`, (t) => {
    const env = setup(t);
    commitAndPush(env.B, "b.md", "b\n");
    const before = git(env.A, "rev-parse", "HEAD").trim();
    writeFileSync(join(env.A, "a.md"), "a\n");
    const r = runWith(env, failingGit(env, pattern), "a.md");
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "push blocked: merge failed a.md (fake failure)\n");
    assert.match(headBody(env.A), new RegExp(`^Memory-Session: ${session}$`, "m"));
    assert.equal(git(env.A, "rev-parse", "HEAD~1").trim(), before);
    assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
    assert.equal(readFileSync(join(env.A, "a.md"), "utf8"), "a\n");
    assert.equal(git(env.A, "status", "--porcelain"), "");
    assert.ok(!existsSync(savedDir(env)));
    const retry = run(env, env.A, "a.md");
    assert.equal(retry.code, 0, retry.stderr + retry.stdout);
    assert.equal(retry.stdout, "pushed: a.md\n");
    assert.equal(originFile(env, "a.md"), "a\n");
    assert.equal(originFile(env, "b.md"), "b\n");
  });
}

test("a merge commit refused by a hook after a clean fetch keeps the commit and the rerun pushes", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "b.md", "b\n");
  const before = git(env.A, "rev-parse", "HEAD").trim();
  const hook = join(env.A, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nif [ -e .git/MERGE_HEAD ]; then echo 'hook refused' >&2; exit 1; fi\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "a.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "push blocked: merge failed a.md (hook refused)\n");
  assert.match(headBody(env.A), new RegExp(`^Memory-Session: ${session}$`, "m"));
  assert.equal(git(env.A, "rev-parse", "HEAD~1").trim(), before);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  assert.equal(readFileSync(join(env.A, "a.md"), "utf8"), "a\n");
  rmSync(hook);
  const retry = run(env, env.A, "a.md");
  assert.equal(retry.code, 0, retry.stderr + retry.stdout);
  assert.equal(retry.stdout, "pushed: a.md\n");
  assert.equal(originFile(env, "a.md"), "a\n");
  assert.equal(originFile(env, "b.md"), "b\n");
});

test("a kill after the commit saves and drops it, and the re-applied run pushes and clears the folder", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "x.md"), "my x\n");
  writeFileSync(join(env.A, "n.md"), "n\n");
  const stdout = await killDuringFetch(env, "x.md", "n.md");
  assert.equal(stdout, `push blocked: interrupted x.md n.md${version(env)}\n`);
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(git(env.A, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(env.A, "x.md"), "utf8"), "line one\nline two\n");
  assert.ok(!existsSync(join(env.A, "n.md")));
  writeFileSync(join(env.A, "x.md"), saved(env, "x.md"));
  writeFileSync(join(env.A, "n.md"), saved(env, "n.md"));
  const next = run(env, env.A, "x.md", "n.md");
  assert.equal(next.code, 0, next.stderr + next.stdout);
  assert.equal(next.stdout, "pushed: x.md n.md\n");
  assert.equal(originFile(env, "x.md"), "my x\n");
  assert.equal(originFile(env, "n.md"), "n\n");
  assert.ok(!existsSync(savedDir(env)));
});

test("the copies a kill saved survive the session's later blocks", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.A, "x.md"), "my x\n");
  writeFileSync(join(env.A, "n.md"), "n\n");
  assert.equal(await killDuringFetch(env, "x.md", "n.md"), `push blocked: interrupted x.md n.md${version(env)}\n`);
  assert.equal(run(env, env.A, "x.md", "n.md").stdout, "push blocked: not a file x.md n.md (n.md)\n");
  assert.equal(run(env, env.A, "x.md").stdout, "push blocked: nothing staged x.md\n");
  assert.equal(saved(env, "x.md"), "my x\n");
  assert.equal(saved(env, "n.md"), "n\n");
});

test("a lock-held run keeps the copy a conflict saved", async (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  assert.equal(run(env, env.A, "x.md").stdout, `push blocked: merge conflict x.md (x.md)${version(env)}\n`);
  const lock = join(env.A, ".git", "memory-push.lock");
  await holdLock(t, lock);
  writeFileSync(join(env.A, "head.md"), "h\n");
  assert.equal(run(env, env.A, "head.md").stdout, `push blocked: lock held head.md (${lock})\n`);
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
});

test("a later save writes beside the copies already saved", (t) => {
  const env = setup(t);
  mkdirSync(savedDir(env), { recursive: true });
  writeFileSync(join(savedDir(env), "earlier.md"), "earlier\n");
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  assert.equal(run(env, env.A, "x.md").stdout, `push blocked: merge conflict x.md (x.md)${version(env)}\n`);
  assert.equal(readFileSync(join(savedDir(env), "earlier.md"), "utf8"), "earlier\n");
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
});

test("add failed names the offending path", (t) => {
  const env = setup(t);
  mkdirSync(join(env.A, ".git", "info"), { recursive: true });
  writeFileSync(join(env.A, ".git", "info", "exclude"), "ig.md\n");
  writeFileSync(join(env.A, "a.md"), "a\n");
  writeFileSync(join(env.A, "ig.md"), "ig\n");
  const r = run(env, env.A, "a.md", "ig.md");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "push blocked: add failed a.md ig.md (ig.md: The following paths are ignored by one of your .gitignore files:)\n");
});

function conflictOnY(env) {
  commitAndPush(env.B, "y.md", "y base\n");
  git(env.A, "fetch", "-q", "origin");
  git(env.A, "merge", "-q", "--ff-only", `origin/${branch}`);
  commitAndPush(env.B, "y.md", "remote y\n");
  writeFileSync(join(env.A, "y.md"), "my y\n");
  const r = run(env, env.A, "y.md");
  assert.equal(r.stdout, `push blocked: merge conflict y.md (y.md)${version(env)}\n`);
  return runDirs(env).at(-1);
}

test("a later conflict naming an unre-applied path keeps the earlier copy of the writer's version", (t) => {
  const env = setup(t);
  const first = conflictOnY(env);
  commitAndPush(env.B, "x.md", "remote x\n");
  writeFileSync(join(env.A, "x.md"), "my x\n");
  const r = run(env, env.A, "y.md", "x.md");
  assert.equal(r.stdout, `push blocked: merge conflict y.md x.md (x.md)${version(env)}\n`);
  assert.equal(runDirs(env).length, 2);
  assert.equal(readFileSync(join(first, "y.md"), "utf8"), "my y\n");
  assert.equal(saved(env, "x.md"), "my x\n");
});

test("a later dirty-tree block naming an unre-applied path keeps the earlier copy of the writer's version", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "z.md", "z base\n");
  const first = conflictOnY(env);
  writeFileSync(join(env.A, "z.md"), "other session z\n");
  commitAndPush(env.B, "z.md", "remote z\n");
  writeFileSync(join(env.A, "a.md"), "a\n");
  const r = run(env, env.A, "y.md", "a.md");
  assert.equal(r.stdout, `push blocked: dirty tree y.md a.md (z.md) (HEAD stays behind the remote: another session's change)${version(env)}\n`);
  assert.equal(runDirs(env).length, 2);
  assert.equal(readFileSync(join(first, "y.md"), "utf8"), "my y\n");
  assert.equal(saved(env, "a.md"), "a\n");
  assert.equal(readFileSync(join(env.A, "z.md"), "utf8"), "other session z\n");
});

test("a merge left in progress by a failed merge --abort is aborted at the start of the next run", (t) => {
  const env = setup(t);
  commitAndPush(env.B, "x.md", "B line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "A line one\nline two\n");
  const failing = failingGit(env, "merge --abort");
  const first = runWith(env, failing, "x.md");
  assert.match(first.stdout, /\(put-back incomplete: merge --abort; your commit [0-9a-f]+ is on top\)/);
  assert.ok(existsSync(join(env.A, ".git", "MERGE_HEAD")));
  const stuck = runWith(env, failing, "x.md");
  assert.equal(stuck.stdout, "push blocked: merge failed x.md (merge --abort: fake failure)\n");
  assert.ok(existsSync(join(env.A, ".git", "MERGE_HEAD")));
  const rerun = run(env, env.A, "x.md");
  assert.equal(rerun.stdout, `push blocked: merge conflict x.md (x.md)${version(env)}\n`);
  assert.ok(!existsSync(join(env.A, ".git", "MERGE_HEAD")));
  assert.equal(git(env.A, "rev-parse", "HEAD").trim(), originTip(env));
  assert.equal(git(env.A, "status", "--porcelain"), "");
  assert.equal(saved(env, "x.md"), "A line one\nline two\n");
  writeFileSync(join(env.A, "x.md"), "B line one\nline two\nA appended\n");
  const last = run(env, env.A, "x.md");
  assert.equal(last.stdout, "pushed: x.md\n");
  assert.equal(originFile(env, "x.md"), "B line one\nline two\nA appended\n");
  assert.ok(!existsSync(savedDir(env)));
});
