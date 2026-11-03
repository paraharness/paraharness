#!/usr/bin/env node
// The live walks' accounts (CD-278; CD-178 made them by hand, CD-272 kept them
// in a file on wb). They are no longer stored anywhere: each password is
// derived from one key, WALK_SEED_KEY, which the owner sets as a GitHub Actions
// repository secret:
//
//   password = base64url(HMAC-SHA256(WALK_SEED_KEY, email))   (43 characters)
//
// for the three fixed emails walk-cf+{1,2,3}@crookedduke.com. The first two are
// the walk pool, the last is the smoke walk's. `apps/app/e2e/live/walk-accounts.ts`
// derives the same (a test holds the two equal).
//
// `--seed` is what the `release` workflow runs against dev before it promotes
// anything (owner, 7 Oct: the release job seeds, nothing else does; a failed
// seed never fails the release; CD-285: the smoke walk runs on dev). Dev sits
// behind Cloudflare Access, so every request carries the service token's headers
// when CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are set
// (`access-headers.mjs`). Per account, in turn, the smoke walk's first since the
// walk needs it (authThrottle counts the requests), the CD-272 rules:
//   - it signs in (`POST /api/v1/auth/login`): kept;
//   - a 401 with auth.invalid_credentials: it is registered;
//     - 409 auth.email_taken on that registration: the email belongs to an
//       account the key does not sign into (a rotated key); skipped, reported;
//   - any other answer (429, 5xx, a 401 without that code, the network): the run
//     stops there, nothing further is tried.
// Exit 0 when every account signs in or was registered, 1 otherwise, 2 for a
// usage error or a missing/short key. The key and the passwords are never
// printed, nor put in an error; only emails and counts are.
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { accessHeaders } from './access-headers.mjs';

export const WALK_SEED_KEY = 'WALK_SEED_KEY';
export const MIN_KEY_LENGTH = 32;
export const WALK_EMAILS = Object.freeze([1, 2, 3].map((n) => `walk-cf+${String(n)}@crookedduke.com`));
export const POOL_SIZE = WALK_EMAILS.length - 1;
const REQUEST_TIMEOUT_MS = 15_000;

export class WalkKeyError extends Error {}

export function walkPassword(key, email) {
  return createHmac('sha256', key).update(email).digest('base64url');
}

// The three accounts, pool first, the smoke walk's last. The error names the
// key's variable and the rule, never the key.
export function walkAccountsFromKey(key) {
  if (typeof key !== 'string' || key === '') throw new WalkKeyError(`${WALK_SEED_KEY} is not set`);
  if (key.length < MIN_KEY_LENGTH) throw new WalkKeyError(`${WALK_SEED_KEY} is shorter than ${String(MIN_KEY_LENGTH)} characters`);
  return WALK_EMAILS.map((email) => ({ email, password: walkPassword(key, email) }));
}

export async function errorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

// One sign-in: true when it signs in, false when the API refuses it as wrong
// credentials (401 with auth.invalid_credentials, both); anything else is not
// an answer about the account and throws.
export async function signsIn({ api, account, fetch }) {
  const response = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (response.ok) return true;
  if (response.status === 401 && (await errorCode(response)) === 'auth.invalid_credentials') return false;
  throw new Error(`sign-in check for ${account.email} → ${String(response.status)}`);
}

// 'added' on 2xx, 'taken' on 409 auth.email_taken; anything else throws.
async function register({ api, account, displayName, fetch }) {
  const response = await fetch(`${api}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...account, displayName }),
  });
  if (response.ok) return 'added';
  if (response.status === 409 && (await errorCode(response)) === 'auth.email_taken') return 'taken';
  throw new Error(`register ${account.email} → ${String(response.status)}`);
}

export async function seedWalkAccounts({ api: origin, key, fetch = globalThis.fetch, log = console.log }) {
  const accounts = walkAccountsFromKey(key);
  const api = origin.replace(/\/$/, '');
  const counts = { kept: 0, added: 0, skipped: 0 };
  let failure;
  // The smoke walk's account (the last) first: the walk needs it.
  for (const account of [accounts.at(-1), ...accounts.slice(0, -1)]) {
    try {
      if (await signsIn({ api, account, fetch })) {
        counts.kept += 1;
        continue;
      }
      const result = await register({ api, account, displayName: `Walk CF ${String(accounts.indexOf(account) + 1)}`, fetch });
      if (result === 'added') {
        counts.added += 1;
        log(`walk account added: ${account.email}`);
      } else {
        counts.skipped += 1;
        log(`walk account skipped: ${account.email} is registered, and WALK_SEED_KEY does not sign into it`);
      }
    } catch (error) {
      failure = error;
      break;
    }
  }
  const usable = counts.kept + counts.added;
  log(`walk accounts: ${String(usable)} of ${String(accounts.length)} sign in at ${api} (kept ${String(counts.kept)}, added ${String(counts.added)}, skipped ${String(counts.skipped)})${failure ? `; stopped: ${failure.message}` : ''}`);
  return { ...counts, ok: !failure && usable === accounts.length };
}

// Every request gives up after REQUEST_TIMEOUT_MS, so a hung API never holds the release, and
// carries the Access headers it is given.
export const timedFetch =
  (fetch = globalThis.fetch, ms = REQUEST_TIMEOUT_MS, access = {}) =>
  (url, init = {}) =>
    fetch(url, { ...init, headers: { ...access, ...init.headers }, signal: AbortSignal.timeout(ms) });

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

export async function main(args, env, { fetch = timedFetch(globalThis.fetch, REQUEST_TIMEOUT_MS, accessHeaders(env)), log = console.log, err = console.error } = {}) {
  const api = option(args, '--api');
  if (!args.includes('--seed') || !api) {
    err('usage: live-walk-accounts.mjs --seed --api <origin>   (the key is read from WALK_SEED_KEY)');
    return 2;
  }
  try {
    return (await seedWalkAccounts({ api, key: env[WALK_SEED_KEY], fetch, log })).ok ? 0 : 1;
  } catch (error) {
    err(`live-walk-accounts: ${error.message}`);
    return error instanceof WalkKeyError ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
