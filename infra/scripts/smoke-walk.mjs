#!/usr/bin/env node
/**
 * The release's walks (CD-203, CD-285, ARCHITECTURE §20): a few minutes of plain
 * requests and one browser load that say a deploy can be played.
 *
 *   node infra/scripts/smoke-walk.mjs [--env production|dev] [--api <origin>] [--web <origin>]
 *                                     [--sha <verified sha>] [--web-sha <deploy/web tip>]
 *                                     [--browser] [--no-move] [--quick]
 *
 * Each release walks dev in full after promoting to it (`--env dev --browser`), and
 * only then promotes to production, whose check is `--quick`: health with the
 * build and the web with its build, no account, no browser, no move. --env
 * picks the stack's addresses (production by default; dev is
 * dev.crookedduke.com for both, its API being same-origin), and --api / --web, else
 * SMOKE_API_URL / SMOKE_WEB_URL, override them.
 *
 * Dev sits behind Cloudflare Access: with CF_ACCESS_CLIENT_ID and
 * CF_ACCESS_CLIENT_SECRET set, every request the walk sends carries the service
 * token's headers (`access-headers.mjs`), and so does every request the browser
 * makes to the walked web and API origins, by route (`infra/e2e/access.mjs`),
 * and every WebSocket it opens to them, which that file opens from Node with the
 * headers and bridges to the page: no other origin a page loads, and no
 * redirect, gets them. The release hands the secrets to the dev walk only.
 * Neither value is printed.
 *
 * In order, one line each, `smoke: ok <check>` or `smoke: FAILED <check>`:
 *   health   `/api/v1/health` is ok and, with --sha, reports that build
 *   web      `/` is the app's HTML and `/build.json` names a commit (--web-sha: waits up to 120 s for that one)
 *   sign-in  the walk account signs in with its password (`/auth/login`)
 *   home     what Home reads answers for it: `/me` and `/games?status=active`
 *   browser  (--browser) Chromium signs in at `/login` and Home's screen renders
 *   move     a game move through the server's engine: an unrated bot game, a pass
 *            on the walk account's turn (the seq moves on), then a resign so the
 *            account is left with no open game. The stacks run with DEV_MODE off,
 *            so the simulator's scenario routes are not there; the pass is the one
 *            move a script can make without knowing the rack. A 429 on the new
 *            game whose retry-after is at most 5 s (a limiter that cannot answer,
 *            CD-360) is waited out and the game asked for once more.
 * The first failure stops the walk: what follows it depends on it. Every 429
 * prints `smoke: 429 <check> — <method> <path>, retry-after <s|none>, attempt <n>`.
 *
 * The walk account is the last of the live-walk accounts, whose passwords are
 * derived from WALK_SEED_KEY (CD-278, `live-walk-accounts.mjs`; the release
 * seeds them on dev before it promotes anything), so a live walk, which uses the
 * others, is not disturbed. Only its email is printed. --quick needs no account.
 *
 * Exit: 0 every check passed, 1 a check failed, 2 the walk cannot start (no or a
 * short WALK_SEED_KEY without --quick, a usage error). `release.yml` rolls the
 * stack it walked back on 1 or 2.
 */
import { fileURLToPath } from 'node:url';

import { routeAccessHeaders } from '../e2e/access.mjs';

import { accessHeaders } from './access-headers.mjs';
import { WALK_SEED_KEY, WalkKeyError, walkAccountsFromKey } from './live-walk-accounts.mjs';

export const STACKS = {
  production: { api: 'https://api.crookedduke.com', web: 'https://crookedduke.com' },
  dev: { api: 'https://dev.crookedduke.com', web: 'https://dev.crookedduke.com' },
};
export const BOT_GAME = { gameType: 'wordgrid', lang: 'en', rulesetId: 'bubble', seats: [{ kind: 'bot', botProfileId: 'pebble' }], rated: false };
export const EXIT_PASS = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANNOT_START = 2;
export const RETRY_AFTER_MAX_SECONDS = 5;
const TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1_000;

export class CheckFailed extends Error {}
export class CannotStart extends Error {}

export const walkAccount = ({ env }) => {
  try {
    return walkAccountsFromKey(env[WALK_SEED_KEY]).at(-1);
  } catch (error) {
    if (error instanceof WalkKeyError) throw new CannotStart(`no walk account: ${error.message} (the live-walk accounts are derived from it, CD-278)`);
    throw error;
  }
};

export const parseArgs = (argv, env = {}) => {
  const options = { env: 'production', browser: false, move: true, quick: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--browser') options.browser = true;
    else if (flag === '--no-move') options.move = false;
    else if (flag === '--quick') options.quick = true;
    else if (['--env', '--api', '--web', '--sha', '--web-sha'].includes(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new CannotStart(`${flag} needs a value`);
      options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else throw new CannotStart(`unknown flag ${flag}`);
  }
  const stack = STACKS[options.env];
  if (!stack) throw new CannotStart(`--env is production or dev, not ${options.env}`);
  options.api = (options.api || env.SMOKE_API_URL || stack.api).replace(/\/$/, '');
  options.web = (options.web || env.SMOKE_WEB_URL || stack.web).replace(/\/$/, '');
  return options;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryAfterSeconds = (value) => (value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null);

export const client = ({ fetchImpl, headers: access = {}, timeoutMs = 20_000, wait = sleep, check, warn }) => {
  const send = async (method, url, { token, body }) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          ...access,
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'cache-control': 'no-cache',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CheckFailed(`${method} ${new URL(url).pathname} did not answer (${error.name})`);
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json, text, type: response.headers.get('content-type') ?? '', retryAfter: response.headers.get('retry-after') };
  };
  const call = async (method, url, { token, body, retryShortRefusal = false } = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      const answer = await send(method, url, { token, body });
      if (answer.status !== TOO_MANY_REQUESTS) return answer;
      const seconds = retryAfterSeconds(answer.retryAfter);
      const retrying = retryShortRefusal && attempt === 1 && seconds !== null && seconds <= RETRY_AFTER_MAX_SECONDS;
      warn(`smoke: 429 ${check} — ${method} ${new URL(url).pathname}, retry-after ${answer.retryAfter ?? 'none'}, attempt ${attempt}${retrying ? ', retrying once' : ''}`);
      if (!retrying) return answer;
      await wait(seconds * MS_PER_SECOND);
    }
  };
  return { call };
};

const expectOk = (answer, what) => {
  if (!answer.ok) {
    const code = answer.json?.error?.code ?? answer.json?.code ?? '';
    const failure = new CheckFailed(`${what} answered ${answer.status}${code ? ` (${code})` : ''}`);
    failure.status = answer.status;
    throw failure;
  }
  return answer.json;
};

export const checks = {
  async health({ http, options }) {
    const body = expectOk(await http.call('GET', `${options.api}/api/v1/health`), 'health');
    if (body?.status !== 'ok') throw new CheckFailed(`health status is ${String(body?.status)}`);
    if (options.sha && body.build?.sha !== options.sha) throw new CheckFailed(`health reports build ${String(body.build?.sha)}, not ${options.sha}`);
    return `build ${String(body.build?.short ?? body.build?.sha)}`;
  },

  async web({ http, options, buildEveryMs = 5_000, buildTries = 25 }) {
    const page = await http.call('GET', `${options.web}/`);
    if (!page.ok || !page.type.includes('text/html') || !/<div id="root"|<html/i.test(page.text)) {
      throw new CheckFailed(`/ answered ${page.status} ${page.type || 'without a type'}`);
    }
    // The edge may still serve the previous build.json a moment after promote saw the new one (CD-270): with --web-sha, wait for it.
    const tries = options.webSha ? buildTries : 1;
    let build;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let reason;
      try {
        build = expectOk(await http.call('GET', `${options.web}/build.json`), '/build.json');
        if (typeof build?.sha !== 'string' || build.sha.length < 7) throw new CheckFailed('/build.json names no commit');
        if (!options.webSha || build.sha === options.webSha) break;
        reason = `/build.json names ${build.sha}, not ${options.webSha} after ${Math.round(((tries - 1) * buildEveryMs) / 1000)}s`;
      } catch (error) {
        // Without --web-sha there is one read and its failure stands; with it, a transient answer is retried.
        if (!(error instanceof CheckFailed) || !options.webSha) throw error;
        reason = error.message;
      }
      if (attempt === tries) throw new CheckFailed(reason);
      await sleep(buildEveryMs);
    }
    return `serves ${build.sha.slice(0, 7)}`;
  },

  async signIn({ http, options, state }) {
    const body = expectOk(
      await http.call('POST', `${options.api}/api/v1/auth/login`, { body: { email: state.account.email, password: state.account.password } }),
      'sign-in',
    );
    if (typeof body?.accessToken !== 'string') throw new CheckFailed('sign-in returned no access token');
    state.token = body.accessToken;
    state.userId = body.user?.id;
    return state.account.email;
  },

  async home({ http, options, state }) {
    const me = expectOk(await http.call('GET', `${options.api}/api/v1/me`, { token: state.token }), '/me');
    const games = expectOk(await http.call('GET', `${options.api}/api/v1/games?status=active`, { token: state.token }), '/games');
    if (!Array.isArray(games?.items)) throw new CheckFailed('/games has no items list');
    state.userId ??= me?.id;
    return `${games.items.length} active game(s)`;
  },

  async browser({ options, state, openBrowser, headers }) {
    return openBrowser({ web: options.web, api: options.api, account: state.account, headers, sameOrigin: options.env === 'dev' });
  },

  async move({ http, options, state, pollEveryMs = 2_000, pollTries = 30 }) {
    const created = expectOk(await http.call('POST', `${options.api}/api/v1/games`, { token: state.token, body: BOT_GAME, retryShortRefusal: true }), 'new bot game');
    state.gameId = created?.id;
    if (!state.gameId) throw new CheckFailed('the new game has no id');
    let game = created;
    for (let attempt = 0; !game.myTurn && attempt < pollTries; attempt += 1) {
      await sleep(pollEveryMs);
      game = expectOk(await http.call('GET', `${options.api}/api/v1/games/${state.gameId}`, { token: state.token }), 'the game');
    }
    if (!game.myTurn) throw new CheckFailed(`it never became the walk account's turn in game ${state.gameId}`);
    const moved = expectOk(
      await http.call('POST', `${options.api}/api/v1/games/${state.gameId}/moves`, { token: state.token, body: { move: { type: 'pass' }, seq: game.seq } }),
      'the pass',
    );
    const after = moved?.game?.seq;
    if (typeof after !== 'number' || after <= game.seq) throw new CheckFailed(`the pass left seq at ${String(after)} (was ${game.seq})`);
    return `passed in ${state.gameId} (seq ${game.seq} → ${after})`;
  },
};

export const cleanUp = async ({ http, options, state }) => {
  if (!state.gameId || !state.token) return null;
  const resigned = await http.call('POST', `${options.api}/api/v1/games/${state.gameId}/resign`, { token: state.token, body: { confirm: true } }).catch(() => null);
  return resigned?.ok ? `resigned ${state.gameId}` : `could not resign ${state.gameId} (${resigned ? resigned.status : 'no answer'}); the walk account keeps it open`;
};

const chromiumLaunch = async () => {
  try {
    const { chromium } = await import('@playwright/test');
    return () => chromium.launch();
  } catch {
    throw new CheckFailed('Playwright is not installed here (pnpm install first)');
  }
};

export const playwrightBrowser = async ({ web, api, account, headers = {}, sameOrigin = false, launch, signInTimeoutMs = 45_000 }) => {
  const browser = await (launch ?? (await chromiumLaunch()))();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await routeAccessHeaders(context, [...new Set([web, api].map((address) => new URL(address).origin))], headers);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${web}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByTestId('login-email').fill(account.email, { timeout: 45_000 });
    await page.getByTestId('login-password').fill(account.password);
    const login = `${api}/api/v1/auth/login`;
    const answered = page
      .waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST', { timeout: signInTimeoutMs })
      .catch(() => null);
    await page.getByTestId('login-submit').click();
    const answer = await answered;
    if (!answer) throw new CheckFailed(`the page never asked ${login}: it talks to another API, or Access stopped it`);
    const asked = new URL(answer.url()).origin;
    if (sameOrigin && asked !== new URL(web).origin) {
      throw new CheckFailed(`the page signed in at ${asked}, not at its own origin ${new URL(web).origin}: dev serves its API, /api and /ws, on the web app's own origin`);
    }
    if (!answer.url().startsWith(login)) throw new CheckFailed(`the page signed in at ${asked}, not at ${api}`);
    if (!answer.ok()) throw new CheckFailed(`the page's sign-in at ${login} answered ${answer.status()}`);
    await page.getByTestId('home-screen').waitFor({ state: 'attached', timeout: 45_000 });
    if (errors.length > 0) throw new CheckFailed(`Home rendered with ${errors.length} page error(s): ${errors[0].slice(0, 160)}`);
    return 'Home rendered at 390×844';
  } catch (error) {
    if (error instanceof CheckFailed) throw error;
    throw new CheckFailed(`Home did not render: ${String(error.message).split('\n')[0].slice(0, 160)}`);
  } finally {
    await browser.close();
  }
};

export const walk = async ({ options, account, headers = {}, fetchImpl, wait, openBrowser = playwrightBrowser, out, err, pollEveryMs, pollTries, buildEveryMs, buildTries }) => {
  const httpFor = (check) => client({ fetchImpl, headers, wait, check, warn: err });
  const state = { account };
  const order = [
    ['health', checks.health],
    ['web', checks.web],
    ...(options.quick
      ? []
      : [
          ['sign-in', checks.signIn],
          ['home', checks.home],
          ...(options.browser ? [['browser', checks.browser]] : []),
          ...(options.move ? [['move', checks.move]] : []),
        ]),
  ];
  let code = EXIT_PASS;
  for (const [name, check] of order) {
    try {
      out(`smoke: ok ${name} — ${await check({ http: httpFor(name), options, state, openBrowser, headers, pollEveryMs, pollTries, buildEveryMs, buildTries })}`);
    } catch (error) {
      if (!(error instanceof CheckFailed)) throw error;
      err(`smoke: FAILED ${name} — ${error.message}`);
      code = EXIT_FAILED;
      break;
    }
  }
  const cleaned = await cleanUp({ http: httpFor('clean-up'), options, state });
  if (cleaned) out(`smoke: ${cleaned}`);
  return code;
};

export const run = async (argv, env, { fetchImpl = fetch, wait, openBrowser, out = console.log, err = console.error, pollEveryMs, pollTries, buildEveryMs, buildTries } = {}) => {
  let options;
  let account;
  try {
    options = parseArgs(argv, env);
    account = options.quick ? null : walkAccount({ env });
  } catch (error) {
    if (!(error instanceof CannotStart)) throw error;
    err(`smoke: cannot start — ${error.message}`);
    return EXIT_CANNOT_START;
  }
  const headers = accessHeaders(env);
  const access = Object.keys(headers).length > 0 ? ', with the Access service token' : '';
  out(`smoke: ${options.quick ? 'quick check of ' : ''}${options.env}: ${options.web} and ${options.api}${options.sha ? ` at ${options.sha.slice(0, 7)}` : ''}${access}`);
  const code = await walk({ options, account, headers, fetchImpl, wait, openBrowser, out, err, pollEveryMs, pollTries, buildEveryMs, buildTries });
  out(`smoke: ${code === EXIT_PASS ? 'PASSED' : 'FAILED'}`);
  return code;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
