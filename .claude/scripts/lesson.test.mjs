import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "lesson.sh");
const repo = join(here, "..", "..");
const branch = "memory";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete gitEnv.MEMORY_DIR;
delete gitEnv.MEMORY_SESSION;
delete gitEnv.CLAUDE_CODE_SESSION_ID;

const header = "Read by every role as its first step.\nGood: - B3: An example line, because it shows the form.\n\n";
const A1 = "Push the memory checkout only with the push script, because a blanket add sweeps other sessions' files into your commit.";
const B1 = "Read the architecture doc of the area before changing it, because its invariants are not visible in the files you touch.";
const B2 = "Run the covering tests before the push, because CI runs only what the import graph reaches.";
const NONE_OK = "NONE\nFORM         ok\n";
const candidate = "Name the journeys run in READY, because the head signs off only on a run it can find.";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function identify(clone) {
  git(clone, "config", "user.name", "Test");
  git(clone, "config", "user.email", "test@example.com");
}

function lessonsFile(lines) {
  return header + lines.map((line) => `${line}\n`).join("");
}

function setup(t, builder = [`- B1: ${B1}`, `- B2: ${B2}`]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lesson-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const memory = join(root, "memory");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", "-b", branch, memory);
  identify(memory);
  mkdirSync(join(memory, "lessons"));
  writeFileSync(join(memory, "LESSONS.md"), lessonsFile([`- A1: ${A1}`]));
  writeFileSync(join(memory, "lessons", "BUILDER.md"), lessonsFile(builder));
  writeFileSync(join(memory, "lessons", "HEAD.md"), lessonsFile([]));
  git(memory, "add", "-A");
  git(memory, "commit", "-q", "-m", "seed");
  git(memory, "remote", "add", "origin", origin);
  git(memory, "push", "-q", "-u", "origin", `${branch}:${branch}`);
  git(origin, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nprintf '%s\\0' "$@" > "${root}/args"\ncat > "${root}/prompt"\ncat "${root}/answer"\ncat "${root}/stderr" >&2 2>/dev/null\nexit "$(cat "${root}/status" 2>/dev/null || echo 0)"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return { root, origin, memory, bin };
}

function answer(env, text, status = 0, stderr = "") {
  writeFileSync(join(env.root, "answer"), text);
  writeFileSync(join(env.root, "status"), String(status));
  writeFileSync(join(env.root, "stderr"), stderr);
}

function scriptEnv(env) {
  return { ...gitEnv, PATH: `${env.bin}:${process.env.PATH}`, MEMORY_DIR: env.memory, MEMORY_SESSION: "s1", CLAUDE_HARNESS_DIR: join(env.root, "harness") };
}

function lesson(env, ...args) {
  const result = spawnSync("bash", [script, ...args], { cwd: repo, env: scriptEnv(env), encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function builderFile(env) {
  return readFileSync(join(env.memory, "lessons", "BUILDER.md"), "utf8");
}

function originFile(env, file) {
  return git(env.origin, "show", `${branch}:${file}`);
}

function originTip(env) {
  return git(env.origin, "rev-parse", branch).trim();
}

function called(env) {
  return existsSync(join(env.root, "prompt"));
}

test("every form refusal prints one line, exits 1, calls no agent and writes nothing", (t) => {
  const env = setup(t);
  const before = builderFile(env);
  const cases = [
    ["Do X, because Y", "NEXT         not one sentence ending in one period: write it as one sentence that ends in one period"],
    ["Do X, because Y..", "NEXT         not one sentence ending in one period: write it as one sentence that ends in one period"],
    ["Do X, because Y. Do Z, because W.", "NEXT         not one sentence ending in one period: write it as one sentence that ends in one period"],
    ["Do X, because Y\nand Z.", "NEXT         not one sentence ending in one period: write it as one sentence that ends in one period"],
    ["Do X, since Y bites.", "NEXT         no because: name the mechanism that bites after because"],
    ["Do X on 2026-10-21, because Y bites.", "NEXT         carries a date (2026-10-21): drop it"],
    ["Do X for CD-478, because Y bites.", "NEXT         carries a ticket id (CD-478): drop it"],
    ["Do X for TIC-37, because Y bites.", "NEXT         carries a ticket id (TIC-37): drop it"],
    ["Do X as in #393, because Y bites.", "NEXT         carries a PR number (#393): drop it"],
    ['Do "X", because Y bites.', "NEXT         carries quotation marks: drop them"],
    ["Do “X”, because Y bites.", "NEXT         carries quotation marks: drop them"],
    [`Do ${"x".repeat(479)}, because Y bites.`, "NEXT         500 characters, 500 or more: cut it under 500"],
  ];
  for (const [sentence, line] of cases) {
    const r = lesson(env, "BUILDER", sentence);
    assert.equal(r.stdout, `${line}\n`, sentence);
    assert.equal(r.code, 1, sentence);
  }
  assert.equal(called(env), false);
  assert.equal(builderFile(env), before);
});

test("an apostrophe, an em dash and 499 characters pass the form", (t) => {
  const env = setup(t);
  answer(env, NONE_OK);
  const start = "Read the session's file — ";
  const end = ", because Y bites.";
  const sentence = `${start}${"x".repeat(499 - start.length - end.length)}${end}`;
  assert.equal(sentence.length, 499);
  const r = lesson(env, "BUILDER", sentence);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B3\nPUSHED lessons/BUILDER.md\n");
});

test("an unknown file or a malformed flag prints the usage and exits 2", (t) => {
  const env = setup(t);
  for (const args of [["BUILDERS", candidate], ["BUILDER"], ["BUILDER", "--replace", "Q1", candidate], ["BUILDER", "--distinct", "B1,", candidate], ["BUILDER", "--replace", "B1", "--distinct", "B2", candidate], ["BUILDER", "--force", "B1", candidate], ["BUILDER", "--remove", "B1", candidate], ["BUILDER", "--remove"]]) {
    const r = lesson(env, ...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, 'NEXT         wrong arguments: run pnpm lesson <FILE> [--replace <id> | --distinct <id>[,<id>…]] "<sentence>" or pnpm lesson <FILE> --remove <id>\n');
  }
});

test("the next id is one past the highest the file ever held, so a removed id is never reused", (t) => {
  const env = setup(t, [`- B1: ${B1}`, `- B2: ${B2}`, "- B7: A later lesson, because it was removed."]);
  writeFileSync(join(env.memory, "lessons", "BUILDER.md"), lessonsFile([`- B1: ${B1}`, `- B2: ${B2}`]));
  git(env.memory, "commit", "-q", "-am", "remove B7");
  git(env.memory, "push", "-q");
  answer(env, NONE_OK);
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B8\nPUSHED lessons/BUILDER.md\n");
  assert.equal(builderFile(env), lessonsFile([`- B1: ${B1}`, `- B2: ${B2}`, `- B8: ${candidate}`]));
});

test("shared writes LESSONS.md with the letter A", (t) => {
  const env = setup(t);
  answer(env, NONE_OK);
  const r = lesson(env, "shared", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN LESSONS.md A2\nPUSHED LESSONS.md\n");
  assert.equal(originFile(env, "LESSONS.md"), lessonsFile([`- A1: ${A1}`, `- A2: ${candidate}`]));
});

test("a file with no lesson yet starts at 1", (t) => {
  const env = setup(t);
  answer(env, NONE_OK);
  const r = lesson(env, "HEAD", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN HEAD H1\nPUSHED lessons/HEAD.md\n");
});

test("--replace on an id the file does not hold is refused before the agent", (t) => {
  const env = setup(t);
  const r = lesson(env, "BUILDER", "--replace", "B9", candidate);
  assert.equal(r.stdout, "NEXT         no B9 in BUILDER: name an id the file holds\n");
  assert.equal(r.code, 1);
  const shared = lesson(env, "BUILDER", "--replace", "A1", candidate);
  assert.equal(shared.stdout, "NEXT         no A1 in BUILDER: name an id the file holds\n");
  assert.equal(called(env), false);
});

test("a match across two files prints each hit, the form, a merge per id and the shared line in one column, writes nothing and exits 2", (t) => {
  const env = setup(t);
  const before = builderFile(env);
  const tip = originTip(env);
  answer(
    env,
    [
      "SIMILAR B1",
      "WHY          both read the area's doc before a change, because invariants hide",
      "  SIMILAR A1",
      "WHY both stage named files only",
      "FORM         the because restates the rule",
      "MERGE B1     Read the area's doc and its tests before changing it, because its invariants are not visible in the files you touch.",
      "MERGE A1     Push only the files you name, because a blanket add sweeps other sessions' files into your commit.",
      "SHARED       Read and push only what you name, because the rest belongs to other sessions.",
      "",
    ].join("\n"),
  );
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(
    r.stdout,
    [
      `SIMILAR B1   ${B1}`,
      "WHY          both read the area's doc before a change, because invariants hide",
      `SIMILAR A1   ${A1}`,
      "WHY          both stage named files only",
      "FORM         the because restates the rule",
      "MERGE B1     Read the area's doc and its tests before changing it, because its invariants are not visible in the files you touch.",
      "MERGE A1     Push only the files you name, because a blanket add sweeps other sessions' files into your commit.",
      "SHARED       Read and push only what you name, because the rest belongs to other sessions.",
      'NEXT         write nothing; re-run with --replace <id> "<the widened sentence>" or --distinct B1,A1 "<sentence>"',
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 2);
  assert.equal(builderFile(env), before);
  assert.equal(originTip(env), tip);
});

test("a match in one file prints its merge with no shared line and exits 2", (t) => {
  const env = setup(t);
  answer(env, "SIMILAR B2\nWHY          both run the covering tests before a push\nFORM         ok\nMERGE B2     Run the covering tests before every push, because CI runs only what the import graph reaches.\n");
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(
    r.stdout,
    [
      `SIMILAR B2   ${B2}`,
      "WHY          both run the covering tests before a push",
      "FORM         ok",
      "MERGE B2     Run the covering tests before every push, because CI runs only what the import graph reaches.",
      'NEXT         write nothing; re-run with --replace <id> "<the widened sentence>" or --distinct B2 "<sentence>"',
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 2);
});

test("NONE with a form fault prints the form and the rewrite and still writes the candidate as given", (t) => {
  const env = setup(t);
  answer(env, "NONE\nFORM         a hedge\nREWRITE      Name the journeys run in READY, because the head signs off only on a run it can find.\n");
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(
    r.stdout,
    [
      "FORM         a hedge",
      "REWRITE      Name the journeys run in READY, because the head signs off only on a run it can find.",
      "WRITTEN BUILDER B3",
      "PUSHED lessons/BUILDER.md",
      "",
    ].join("\n"),
  );
  assert.equal(r.code, 0);
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([`- B1: ${B1}`, `- B2: ${B2}`, `- B3: ${candidate}`]));
});

test("NONE appends the line and pushes it; the system prompt is the agent text and every file, the message the form rules and the candidate", (t) => {
  const env = setup(t);
  answer(env, NONE_OK);
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B3\nPUSHED lessons/BUILDER.md\n");
  assert.equal(r.code, 0);
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([`- B1: ${B1}`, `- B2: ${B2}`, `- B3: ${candidate}`]));
  const agentText = readFileSync(join(repo, ".claude", "agents", "lesson-check.md"), "utf8").split("---\n").slice(2).join("---\n");
  const system = [
    agentText,
    "## LESSONS.md",
    `- A1: ${A1}`,
    "",
    "## lessons/HEAD.md",
    "",
    "## lessons/CONSULTANT.md",
    "",
    "## lessons/BUILDER.md",
    `- B1: ${B1}`,
    `- B2: ${B2}`,
    "",
    "## lessons/REVIEWER.md",
    "",
    "## lessons/VERIFIER.md",
    "",
    "## lessons/JUDGE.md",
    "",
    "## lessons/DESIGNER.md",
    "",
    "## lessons/HOTFIX.md",
    "",
    "## lessons/EXPLORE.md",
    "",
    "## lessons/SCRIBE.md",
  ].join("\n");
  assert.deepEqual(readFileSync(join(env.root, "args"), "utf8").split("\0"), ["-p", "--model", "claude-haiku-5-5", "--tools", "", "--system-prompt", system, ""]);
  assert.equal(
    readFileSync(join(env.root, "prompt"), "utf8"),
    [
      "## Form rules of lessons/BUILDER.md",
      "Read by every role as its first step.",
      "Good: An example line, because it shows the form.",
      "",
      "Candidate for lessons/BUILDER.md:",
      candidate,
      "",
    ].join("\n"),
  );
});

test("a malformed answer, an unknown id or a failed agent writes nothing and exits 1", (t) => {
  const env = setup(t);
  const before = builderFile(env);
  const why = "WHY          same";
  const m1 = "MERGE B1     Read the doc, because it bites.";
  const failed = (first) => `NEXT         lesson check failed (${first}): rerun`;
  const cases = [
    ["I think it matches B1.\n", 0, "", failed("I think it matches B1.")],
    ["NONE\n", 0, "", failed("NONE")],
    ["FORM         ok\n", 0, "", failed("FORM         ok")],
    [`MATCHES\nSIMILAR B1\n${why}\nFORM         ok\n${m1}\n`, 0, "", failed("MATCHES")],
    [`SIMILAR B1: same\n${why}\nFORM         ok\n${m1}\n`, 0, "", failed("SIMILAR B1: same")],
    [`SIMILAR B1\nFORM         ok\n${m1}\n`, 0, "", failed("SIMILAR B1")],
    [`SIMILAR B5\n${why}\nFORM         ok\nMERGE B5     Do X, because Y.\n`, 0, "", failed("SIMILAR B5")],
    [`SIMILAR B1\n${why}\n${m1}\n`, 0, "", failed("SIMILAR B1")],
    [`SIMILAR B1\n${why}\nFORM         ok\n`, 0, "", failed("SIMILAR B1")],
    [`SIMILAR B1\n${why}\nFORM         ok\nMERGE B2     Do X, because Y.\n`, 0, "", failed("SIMILAR B1")],
    [`SIMILAR B1\n${why}\nSIMILAR A1\n${why}\nFORM         ok\n${m1}\nMERGE A1     Do X, because Y.\n`, 0, "", failed("SIMILAR B1")],
    [`SIMILAR B1\n${why}\nFORM         ok\n${m1}\nSHARED       Do X, because Y.\n`, 0, "", failed("SIMILAR B1")],
    [`SIMILAR B1\n${why}\nFORM: ok\n${m1}\n`, 0, "", failed("SIMILAR B1")],
    ["NONE\nFORM         a hedge\n", 0, "", failed("NONE")],
    ["NONE\nFORM         ok\nREWRITE      Do X, because Y.\n", 0, "", failed("NONE")],
    [`NONE\nSIMILAR B1\n${why}\nFORM         ok\n`, 0, "", failed("NONE")],
    ["NONE\nFORM         ok\nMERGE B1     Do X, because Y.\n", 0, "", failed("NONE")],
    ["API Error: overloaded\n", 1, "", failed("API Error: overloaded")],
    ["", 1, "Error: not logged in\n", failed("Error: not logged in")],
  ];
  for (const [text, status, stderr, line] of cases) {
    answer(env, text, status, stderr);
    const r = lesson(env, "BUILDER", candidate);
    assert.equal(r.stdout, `${line}\n`, text);
    assert.equal(r.code, 1, text);
  }
  assert.equal(builderFile(env), before);
});

test("--remove deletes that line, calls no agent, pushes, and the next write never reuses its id", (t) => {
  const env = setup(t);
  const removed = lesson(env, "BUILDER", "--remove", "B2");
  assert.equal(removed.stdout, "REMOVED BUILDER B2\nPUSHED lessons/BUILDER.md\n");
  assert.equal(removed.code, 0);
  assert.equal(called(env), false);
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([`- B1: ${B1}`]));
  answer(env, NONE_OK);
  const written = lesson(env, "BUILDER", candidate);
  assert.equal(written.stdout, "FORM         ok\nWRITTEN BUILDER B3\nPUSHED lessons/BUILDER.md\n");
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([`- B1: ${B1}`, `- B3: ${candidate}`]));
});

test("--remove of the last lesson a file holds still pushes the file", (t) => {
  const env = setup(t, [`- B1: ${B1}`]);
  const r = lesson(env, "BUILDER", "--remove", "B1");
  assert.equal(r.stdout, "REMOVED BUILDER B1\nPUSHED lessons/BUILDER.md\n");
  assert.equal(r.code, 0);
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([]));
});

test("--remove on an id the file does not hold is refused", (t) => {
  const env = setup(t);
  const before = builderFile(env);
  const r = lesson(env, "BUILDER", "--remove", "B9");
  assert.equal(r.stdout, "NEXT         no B9 in BUILDER: name an id the file holds\n");
  assert.equal(r.code, 1);
  assert.equal(builderFile(env), before);
});

test("--replace rewrites that line in place, keeps its id, calls no agent and pushes", (t) => {
  const env = setup(t);
  const widened = "Read the architecture doc of the area and its tests before changing it, because its invariants are not visible in the files you touch.";
  const r = lesson(env, "BUILDER", "--replace", "B1", widened);
  assert.equal(r.stdout, "REPLACED BUILDER B1\nPUSHED lessons/BUILDER.md\n");
  assert.equal(r.code, 0);
  assert.equal(called(env), false);
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([`- B1: ${widened}`, `- B2: ${B2}`]));
});

test("--distinct appends the line as new, prints distinct from and pushes", (t) => {
  const env = setup(t);
  const r = lesson(env, "BUILDER", "--distinct", "B1,A1", candidate);
  assert.equal(r.stdout, "WRITTEN BUILDER B3\nDISTINCT B1,A1\nPUSHED lessons/BUILDER.md\n");
  assert.equal(r.code, 0);
  assert.equal(called(env), false);
  assert.equal(originFile(env, "lessons/BUILDER.md"), lessonsFile([`- B1: ${B1}`, `- B2: ${B2}`, `- B3: ${candidate}`]));
});

test("a write past twenty lessons prints the advisory and still exits 0", (t) => {
  const twenty = Array.from({ length: 20 }, (_, i) => `- B${i + 1}: Lesson ${i + 1}, because it bites.`);
  const env = setup(t, twenty);
  answer(env, NONE_OK);
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B21\nOVER BUILDER 21  the consultant widens\nPUSHED lessons/BUILDER.md\n");
  assert.equal(r.code, 0);
});

test("a warning the agent prints on stderr does not spoil its answer", (t) => {
  const env = setup(t);
  answer(env, NONE_OK, 0, "Permission allow rule: a warning\n");
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B3\nPUSHED lessons/BUILDER.md\n");
});

test("a write that reaches twenty prints no advisory", (t) => {
  const nineteen = Array.from({ length: 19 }, (_, i) => `- B${i + 1}: Lesson ${i + 1}, because it bites.`);
  const env = setup(t, nineteen);
  answer(env, NONE_OK);
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B20\nPUSHED lessons/BUILDER.md\n");
});

test("a blocked memory push is the last line and its exit code", (t) => {
  const env = setup(t);
  const hook = join(env.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  answer(env, NONE_OK);
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, "FORM         ok\nWRITTEN BUILDER B3\nNEXT         push blocked: push rejected twice lessons/BUILDER.md: follow running.md § The memory push\n");
  assert.equal(r.code, 1);
});

test("a second run while one holds the lesson lock is refused and writes nothing", async (t) => {
  const env = setup(t);
  const before = builderFile(env);
  const lock = join(env.memory, ".git", "lesson.lock");
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
  answer(env, NONE_OK);
  const r = lesson(env, "BUILDER", candidate);
  assert.equal(r.stdout, `NEXT         another lesson run holds ${lock}: rerun when it ends\n`);
  assert.equal(r.code, 1);
  assert.equal(builderFile(env), before);
});
