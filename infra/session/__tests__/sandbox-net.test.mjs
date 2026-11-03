/**
 * The hook that puts a Claude Code web sandbox on the tailnet, driven against
 * stub `tailscaled` / `tailscale` binaries: no network, no daemon, and an auth
 * key that is worth nothing. What has to hold is the contract it has with the
 * session — at most one short line, never the key, exit 0 whatever happened,
 * and silence when there was nothing to say — plus an ssh config that survives
 * being written twice with the rest of the file intact.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../sandbox-net.sh', import.meta.url));
const AUTH_KEY = 'tskey-test-abc';
const BEGIN = '# >>> sandbox-net (managed) >>>';
const END = '# <<< sandbox-net (managed) <<<';

let root;
let tsDir;
let stateDir;
let sshDir;
let stubDir;

/**
 * Stubs that record their argv. `tailscale status --json` answers from a state
 * file this test owns and fails while that file is missing, the way the real
 * one fails before the daemon opens its socket; `up` writes `Running` into it,
 * the way a login that worked would. The daemon stub exits at once — nothing
 * here needs a live one, and a sleeping stub would outlive the test.
 */
const writeStubs = () => {
  writeFileSync(
    join(tsDir, 'tailscale'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${stubDir}/tailscale.argv"
state="$(cat "${stubDir}/state" 2>/dev/null)"
case " $* " in
  *' status '*) [ -n "$state" ] || exit 1; printf '{"BackendState":"%s"}\\n' "$state" ;;
  *' up '*) printf 'Running' >"${stubDir}/state" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(tsDir, 'tailscaled'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${stubDir}/tailscaled.argv"
exit 0
`,
    { mode: 0o755 },
  );
};

/** One run of the hook, with every path pointed at this test's temp dirs. */
const run = (env = {}) =>
  spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      CLAUDE_CODE_REMOTE: 'true',
      WB_TS_DIR: tsDir,
      WB_TS_STATE_DIR: stateDir,
      WB_SSH_DIR: sshDir,
      WB_NET_WAIT_SECS: '2',
      // The real probe is `nc` through the SOCKS port; here it is whatever the
      // test wants the answer to be.
      WB_PROBE_CMD: 'true',
      // No daemon unless the test says so: the machine's own tailscaled, or its
      // absence, must never decide a test (row 261).
      WB_PGREP_CMD: 'false',
      ...env,
    },
  });

const readConfig = () => readFileSync(join(sshDir, 'config'), 'utf8');
const readLog = () =>
  existsSync(join(stateDir, 'hook.log')) ? readFileSync(join(stateDir, 'hook.log'), 'utf8') : '';
const occurrences = (text, needle) => text.split(needle).length - 1;

const waitFor = async (ok, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

/** A `pgrep` that finds nothing — what a VM with no tailscaled of its own looks like. */
const blindPgrep = () => {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}`, WB_PGREP_CMD: join(bin, 'pgrep') };
};

/**
 * A `pgrep` that answers `-x tailscaled` with a pid this test chose, instead
 * of whatever this machine's own tailscaled (if any) actually is — the
 * healing path is driven against a placeholder process the test owns and can
 * safely kill, never a real daemon that might share this box.
 */
const daemonPgrep = (pid) => {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'pgrep'),
    `#!/usr/bin/env bash
case " $* " in
  *' -x tailscaled '*) echo ${pid} ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${process.env.PATH}`, WB_PGREP_CMD: join(bin, 'pgrep') };
};

/**
 * Stands in for the supervisor loop: a real, killable process whose cmdline
 * names `supervise.sh` the way the real loop's does (`exec -a` sets argv[0]),
 * so `supervisor_pid()` accepts it as one instead of a stray pid to leave alone.
 */
const spawnFakeSupervisor = () => {
  const script = join(root, 'fake-supervisor.sh');
  writeFileSync(script, '#!/bin/bash\nexec -a supervise.sh tail -f /dev/null\n', { mode: 0o755 });
  return spawn(script, [], { stdio: 'ignore' });
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const freshSandbox = () => {
  root = mkdtempSync(join(tmpdir(), 'sandbox-net-'));
  tsDir = join(root, 'ts');
  stubDir = join(root, 'stub');
  // Neither of these is created here: whether the script makes them is part of
  // what is being tested.
  stateDir = join(root, 'state');
  sshDir = join(root, 'ssh');
  mkdirSync(tsDir);
  mkdirSync(stubDir);
  writeStubs();
  writeFileSync(join(stubDir, 'state'), 'Running');
};

const clearSandbox = () => {
  // On a machine with no tailscaled of its own a run leaves a detached
  // supervisor behind. `setsid` made it a session leader, so the group goes.
  try {
    const pid = Number(readFileSync(join(stateDir, 'supervise.pid'), 'utf8').trim());
    // Never this process's own group: one test writes that pid on purpose.
    if (pid > 0 && pid !== process.pid) process.kill(-pid, 'SIGKILL');
  } catch {
    // Nothing was started, or it is already gone.
  }
  rmSync(root, { recursive: true, force: true });
};

beforeEach(freshSandbox);
afterEach(clearSandbox);

describe('when it must not act at all', () => {
  it('leaves a local checkout completely alone, and says the setup script never ran when the binaries are not there', () => {
    const local = run({ CLAUDE_CODE_REMOTE: '' });

    expect.soft(local.status, 'local').toBe(0);
    expect.soft(local.stdout, 'local').toBe('');
    expect.soft(existsSync(stateDir), 'local').toBe(false);
    expect.soft(existsSync(sshDir), 'local').toBe(false);

    const empty = join(root, 'empty');
    mkdirSync(empty);
    const missing = run({ WB_TS_DIR: empty });

    expect.soft(missing.status, 'binaries missing').toBe(0);
    expect.soft(missing.stdout, 'binaries missing').toBe(
      `sandbox-net: tailscale binaries missing in ${empty} (cloud environment setup script not run)\n`,
    );
  });
});

describe('the ssh config', () => {
  it('writes all three hosts through the SOCKS proxy, 0600, without touching the rest, and leaves exactly one managed block however often it runs', () => {
    mkdirSync(sshDir);
    writeFileSync(join(sshDir, 'config'), 'Host other\n  HostName example.com\n');

    run();
    const config = readConfig();

    expect.soft(config).toContain('Host other\n  HostName example.com');
    expect.soft(config).toContain('Host wb\n  HostName 100.66.213.38\n  User tornike\n');
    expect.soft(config).toContain('Host wb-root\n  HostName 100.66.213.38\n  User root\n');
    expect.soft(config).toContain('Host wb2\n  HostName 100.89.147.117\n  User root\n');
    expect.soft(occurrences(config, 'ProxyCommand nc -x localhost:1055 %h %p')).toBe(3);
    expect.soft(occurrences(config, 'StrictHostKeyChecking accept-new')).toBe(3);
    expect.soft(occurrences(config, 'ConnectTimeout 25')).toBe(3);
    expect.soft(occurrences(config, 'ServerAliveInterval 30')).toBe(3);
    expect.soft(occurrences(config, 'BatchMode yes')).toBe(3);
    expect.soft(statSync(join(sshDir, 'config')).mode & 0o777).toBe(0o600);
    expect.soft(statSync(sshDir).mode & 0o777).toBe(0o700);

    run();
    const second = readConfig();

    expect.soft(second, 'second run').toBe(config);
    expect.soft(occurrences(second, BEGIN), 'second run').toBe(1);
    expect.soft(occurrences(second, END), 'second run').toBe(1);
    expect.soft(occurrences(second, 'Host other'), 'second run').toBe(1);
  });

  it('reads the server, the port, the hostname and the wb2 address from the environment', () => {
    run({ WB_SERVER_IP: '100.0.0.9', WB_SOCKS_PORT: '2055' });
    const moved = readConfig();
    expect.soft(occurrences(moved, 'HostName 100.0.0.9'), 'WB_SERVER_IP').toBe(2);
    expect.soft(occurrences(moved, 'ProxyCommand nc -x localhost:2055 %h %p'), 'WB_SOCKS_PORT').toBe(3);

    anotherSandbox();
    run({ WB2_SERVER_IP: '100.0.0.7' });
    const wb2 = readConfig();
    expect.soft(wb2, 'WB2_SERVER_IP').toContain('Host wb2\n  HostName 100.0.0.7\n  User root\n');
    expect.soft(occurrences(wb2, 'HostName 100.66.213.38'), 'WB2_SERVER_IP').toBe(2);
  });
});

const loginArgv = () => readFileSync(join(stubDir, 'tailscale.argv'), 'utf8');
const anotherSandbox = () => {
  clearSandbox();
  freshSandbox();
};
const backend = (state) => {
  if (state === undefined) rmSync(join(stubDir, 'state'));
  else writeFileSync(join(stubDir, 'state'), state);
};

describe('logging in', () => {
  it('uses TS_AUTHKEY when the backend needs one under the hostname WB_TS_HOSTNAME names, and never lets the key out', () => {
    backend('NeedsLogin');
    const result = run({ TS_AUTHKEY: AUTH_KEY });

    const up = loginArgv()
      .split('\n')
      .find((line) => line.includes(' up '));
    expect.soft(up).toContain(`--auth-key=${AUTH_KEY}`);
    expect.soft(up).toContain('--hostname=claude-sandbox');
    expect.soft(up).toContain('--accept-dns=false');
    expect.soft(result.stdout).not.toContain('tskey');
    expect.soft(readLog()).not.toContain('tskey');
    expect.soft(result.status).toBe(0);

    anotherSandbox();
    backend('NeedsLogin');
    run({ TS_AUTHKEY: AUTH_KEY, WB_TS_HOSTNAME: 'other-sandbox' });
    expect.soft(loginArgv(), 'WB_TS_HOSTNAME').toContain('--hostname=other-sandbox');
  });

  it('asks for the key rather than guessing when there is none', () => {
    writeFileSync(join(stubDir, 'state'), 'NeedsLogin');

    const result = run();

    expect(result.stdout).toBe(
      'sandbox-net: not logged in and TS_AUTHKEY is not set (add it to the cloud environment variables)\n',
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(stubDir, 'tailscale.argv'), 'utf8')).not.toContain(' up ');
  });

  it('waits out a Starting backend instead of logging in over it', () => {
    // A daemon that loaded existing state and is still connecting is already
    // authenticated; `up --auth-key` would log the node in a second time.
    writeFileSync(join(stubDir, 'state'), 'Starting');

    const result = run({ TS_AUTHKEY: AUTH_KEY });

    expect(readFileSync(join(stubDir, 'tailscale.argv'), 'utf8')).not.toContain(' up ');
    expect(result.stdout).toContain('sandbox-net: tailscale is not running (state Starting)');
    expect(result.status).toBe(0);
  });

  it('does not try to log in through a daemon that never answered', () => {
    rmSync(join(stubDir, 'state'));

    const result = run({ TS_AUTHKEY: AUTH_KEY });

    expect(result.stdout).toContain('sandbox-net: tailscale is not running (state unreachable)');
    expect(readFileSync(join(stubDir, 'tailscale.argv'), 'utf8')).not.toContain(' up ');
  });
});

describe('what it reports once the tailnet is up', () => {
  it('confirms wb the first time, and then says nothing at all', () => {
    const first = run();
    const second = run();

    expect(first.stdout).toBe('sandbox-net: wb reachable over tailscale\n');
    // Nothing changed and nothing is broken: a healthy prompt costs no context.
    expect(second.stdout).toBe('');
    expect(second.status).toBe(0);
  });

  it('names the check that a live tailnet with no route to wb points at', () => {
    const result = run({ WB_PROBE_CMD: 'false' });

    expect(result.stdout).toBe(
      'sandbox-net: tailnet up but wb:22 unreachable (Tailscale SSH check/ACL?)\n',
    );
    expect(result.status).toBe(0);
  });
});

async function stopSupervisorStartedByRun() {
  const log = join(stateDir, 'hook.log');
  const started = existsSync(log) && readFileSync(log, 'utf8').includes('started the supervisor');
  if (!started) return;
  const recorded = join(stateDir, 'supervise.pid');
  expect(await waitFor(() => existsSync(recorded))).toBe(true);
  const pid = Number(readFileSync(recorded, 'utf8').trim());
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    process.kill(pid, 'SIGKILL');
  }
  rmSync(recorded, { force: true });
  rmSync(join(stubDir, 'tailscaled.argv'), { force: true });
}

describe('the supervisor', () => {
  it('is written with the flags a userspace daemon needs, every run', () => {
    run();
    const supervisor = join(stateDir, 'supervise.sh');
    const text = readFileSync(supervisor, 'utf8');

    expect(text).toContain('--tun=userspace-networking');
    expect(text).toContain('--socks5-server=localhost:1055');
    expect(text).toContain('--outbound-http-proxy-listen=localhost:1056');
    expect(text).toContain(`--state="${stateDir}/tailscaled.state"`);
    expect(text).toContain(`--socket="${stateDir}/tailscaled.sock"`);
    // The stale socket goes before every attempt, and the loop never gives up.
    expect(text).toContain(`rm -f "${stateDir}/tailscaled.sock"`);
    expect(text).toContain('sleep 3');
    expect(spawnSync('bash', ['-n', supervisor]).status).toBe(0);

    const inode = statSync(supervisor).ino;
    run();
    // Renamed into place, never truncated: bash reads a running script by
    // offset, so a loop already executing this file keeps the old inode.
    expect(statSync(supervisor).ino).not.toBe(inode);
    expect(existsSync(`${supervisor}.new`)).toBe(false);
  });

  it('is started once on a machine with no daemon of its own, and only once', () => {
    // The stub daemon is a shell script, so `pgrep -x tailscaled` sees the
    // interpreter and never the stub — which is also what a fresh VM looks
    // like, and the only case where the hook has to start anything.
    const blind = blindPgrep();

    const first = run(blind);
    const pid = readFileSync(join(stateDir, 'supervise.pid'), 'utf8').trim();
    const second = run(blind);

    expect(first.stdout).toBe('sandbox-net: wb reachable over tailscale\n');
    // A second supervisor would be two daemons over one socket and one state
    // file, so the live one is left to do its job — and there is nothing to say.
    expect(second.stdout).toBe('');
    expect(readFileSync(join(stateDir, 'supervise.pid'), 'utf8').trim()).toBe(pid);
  });

  it('is started anyway when the pid file points at some other live process', async () => {
    // Pids are reused. Believing a live pid that is not the supervisor would
    // leave the session with no tunnel and nothing on its way to one.
    const blind = blindPgrep();
    mkdirSync(stateDir, { recursive: true });
    const pidFile = join(stateDir, 'supervise.pid');
    writeFileSync(pidFile, `${process.pid}\n`);

    run(blind);

    expect(await waitFor(() => readFileSync(pidFile, 'utf8').trim() !== String(process.pid))).toBe(
      true,
    );
    // The supervisor rewrites its pid file BEFORE it starts the daemon, so the
    // argv the stub writes can land a few ms after the pid changed: wait for
    // it the same way, or a loaded box fails this for no reason (verify, 2026-09-14).
    expect(await waitFor(() => existsSync(join(stubDir, 'tailscaled.argv')))).toBe(true);
  });

  it('runs the daemon with those flags and records the pid that supervises it', async () => {
    run();
    await stopSupervisorStartedByRun();
    const child = spawn('bash', [join(stateDir, 'supervise.sh')], {
      detached: true,
      stdio: 'ignore',
    });
    const argv = join(stubDir, 'tailscaled.argv');

    try {
      expect(await waitFor(() => existsSync(argv))).toBe(true);
      expect(readFileSync(argv, 'utf8')).toContain('--tun=userspace-networking');
      expect(await waitFor(() => existsSync(join(stateDir, 'supervise.pid')))).toBe(true);
      expect(Number(readFileSync(join(stateDir, 'supervise.pid'), 'utf8').trim())).toBe(child.pid);
    } finally {
      process.kill(-child.pid, 'SIGKILL');
    }
  });
});

describe('healing a daemon with a stale proxy', () => {
  // Placeholders for the real tailscaled and its supervisor: real, killable
  // processes so the test never has to touch an actual daemon. `bystander`
  // stands in for another sandbox's tailscaled sharing this box — proof that
  // the fix kills by pid, never by name or pattern (a pattern kill took down
  // a verify run mid-suite on 2026-09-15, hence the rule this checks).
  let daemon;
  let supervisor;
  let bystander;

  beforeEach(() => {
    mkdirSync(stateDir, { recursive: true });
    daemon = spawn('tail', ['-f', '/dev/null'], {
      env: { PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:11111' },
      stdio: 'ignore',
    });
    supervisor = spawnFakeSupervisor();
    bystander = spawn('tail', ['-f', '/dev/null'], { stdio: 'ignore' });
    writeFileSync(join(stateDir, 'supervise.pid'), `${supervisor.pid}\n`);
    writeFileSync(join(stateDir, 'tailscaled.sock'), '');
  });

  afterEach(() => {
    for (const p of [daemon, supervisor, bystander]) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // Already gone, which for daemon/supervisor is the point of the test.
      }
    }
  });

  it('kills the old daemon and its supervisor by pid, clears the socket, restarts under the new proxy, and leaves an unrelated process alone', async () => {
    const result = run({
      ...daemonPgrep(daemon.pid),
      HTTPS_PROXY: 'http://127.0.0.1:22222',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'sandbox-net: tailscaled kept a stale proxy from before a restart; restarted it\n',
    );
    expect(await waitFor(() => !isAlive(daemon.pid))).toBe(true);
    expect(await waitFor(() => !isAlive(supervisor.pid))).toBe(true);
    expect(isAlive(bystander.pid)).toBe(true);
    expect(existsSync(join(stateDir, 'tailscaled.sock'))).toBe(false);
    expect(readLog()).toContain(
      "its HTTPS_PROXY was 'http://127.0.0.1:11111', now 'http://127.0.0.1:22222'",
    );
    // A fresh supervisor took over — a new pid that goes on to run the stub.
    expect(
      await waitFor(() => {
        try {
          return (
            readFileSync(join(stateDir, 'supervise.pid'), 'utf8').trim() !== String(supervisor.pid)
          );
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(await waitFor(() => existsSync(join(stubDir, 'tailscaled.argv')))).toBe(true);
  });

  it('leaves the daemon alone when its recorded proxy still matches', () => {
    const env = { ...daemonPgrep(daemon.pid), HTTPS_PROXY: 'http://127.0.0.1:11111' };
    // First run writes the ssh config, which alone would set CHANGED and print
    // — same as any other first run in a fresh sshDir. The steady state this
    // test is about is the second run, once that one-time write is done.
    run(env);

    const result = run(env);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(isAlive(daemon.pid)).toBe(true);
    expect(isAlive(supervisor.pid)).toBe(true);
    expect(readLog()).toContain('tailscaled is already running');
  });
});
