/**
 * Builds a Node child-process `argv` array that prints JSON metadata about its `cwd`, `env`, and `stdin`.
 *
 * Used by `local-runner-and-command.test.ts` to deterministically verify working directory isolation,
 * all 9 `GIT_*` environment overrides, `EnvRef` resolution, and `stdin` handling.
 *
 * @returns {readonly string[]} Node `argv` array printing `{ cwd, env, stdin }` as JSON.
 */
export function buildEnvAndStdinProbeArgv(): readonly string[] {
  const script = [
    'const chunks = [];',
    'process.stdin.on("data", (c) => chunks.push(c));',
    'process.stdin.on("end", () => {',
    '  const stdin = Buffer.concat(chunks).toString("utf8");',
    '  console.log(JSON.stringify({ cwd: process.cwd(), env: process.env, stdin }));',
    '});',
  ].join(' ');
  return Object.freeze([process.execPath, '-e', script]);
}

/**
 * Builds a Node child-process `argv` array simulating a streaming test suite that emits a failure stack trace.
 *
 * Prints initial passing output, emits a multi-line `FAIL packages/api/foo.test.ts\n  ● suite failure`
 * banner across `stdout` and `stderr` followed by 35 numbered stack trace lines, and then sleeps until killed.
 *
 * @returns {readonly string[]} Node `argv` array simulating a failing streaming test runner.
 */
export function buildFailingStreamSuiteArgv(): readonly string[] {
  const script = [
    'process.on("SIGTERM", () => process.exit(0));',
    'process.stderr.write("FAIL packages/api/broken.test.ts\\n", () => {',
    '  setTimeout(() => {',
    '    process.stdout.write("  ● broken test case\\n");',
    '    for (let i = 1; i <= 35; i += 1) {',
    '      process.stdout.write("    trace-line-" + i + "\\n");',
    '    }',
    '  }, 5);',
    '});',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  return Object.freeze([process.execPath, '-e', script]);
}

/**
 * Builds a Node child-process `argv` array that binds TCP listeners on `ports`, prints a readiness banner, and waits.
 *
 * Simulates a multi-port local daemon (`local-pg` or `browser-sandbox`) that listens on all allocated
 * `127.0.0.1` TCP ports and emits a multi-line readiness banner across `stdout` and `stderr`.
 *
 * @param {readonly number[]} ports      - Allocated TCP port numbers to bind on `127.0.0.1`.
 * @param {string}            bannerText - Readiness banner emitted once all TCP listeners are bound.
 *
 * @returns {readonly string[]} Node `argv` array for the simulated TCP daemon.
 */
export function buildSampleTcpDaemonArgv(
  ports: readonly number[],
  bannerText: string,
): readonly string[] {
  const script = [
    'const net = require("node:net");',
    'process.on("SIGTERM", () => process.exit(0));',
    `const ports = ${JSON.stringify(ports)};`,
    `const banner = ${JSON.stringify(bannerText)};`,
    'Promise.all(ports.map((p) => new Promise((res) => {',
    '  const srv = net.createServer((sock) => sock.end("ok"));',
    '  srv.listen(p, "127.0.0.1", res);',
    '}))).then(() => {',
    '  process.stdout.write(banner + "\\n");',
    '});',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  return Object.freeze([process.execPath, '-e', script]);
}

/**
 * Builds a Node child-process `argv` array simulating an interactive REPL (`psql` or `cdp>`) with prompt framing.
 *
 * Prints an initial startup banner ending with `promptStr`, then processes each line of `stdin`:
 * if a line starts with `SLOW:`, delays before responding; if `HANG`, never prints the prompt;
 * otherwise prints `RESULT:<line>` followed by `promptStr` without echoing the raw input.
 *
 * @param {string} promptStr - Prompt delimiter string emitted after the startup banner and each turn.
 *
 * @returns {readonly string[]} Node `argv` array for the simulated interactive REPL.
 */
export function buildSampleInteractiveReplArgv(promptStr: string): readonly string[] {
  const script = [
    'const readline = require("node:readline");',
    'process.on("SIGTERM", () => process.exit(0));',
    `const promptStr = ${JSON.stringify(promptStr)};`,
    'process.stdout.write("Welcome to sample interactive REPL v1.0\\n" + promptStr);',
    'const rl = readline.createInterface({ input: process.stdin, terminal: false });',
    'rl.on("line", (line) => {',
    '  if (line === "IS_TTY") { process.stdout.write("STDIN_TTY=" + String(Boolean(process.stdin.isTTY)) + ":STDOUT_TTY=" + String(Boolean(process.stdout.isTTY)) + "\\n" + promptStr); return; }',
    '  if (line === "HANG") { process.stdout.write("hanging..."); return; }',
    '  if (line.startsWith("DELAY:")) {',
    '    const parts = line.split(":");',
    '    setTimeout(() => { process.stdout.write("DELAYED:" + parts[2] + "\\n" + promptStr); }, Number(parts[1]));',
    '    return;',
    '  }',
    '  process.stdout.write("OUT:" + line.toUpperCase() + "\\n" + promptStr);',
    '});',
  ].join(' ');
  return Object.freeze([process.execPath, '-e', script]);
}
