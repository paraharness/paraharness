#!/usr/bin/env node
// The admin's post-deploy check on dev (CD-291, ARCHITECTURE §24), run by `release.yml` after the api
// half reached dev. Without a token the admin must refuse (Access, then the Worker, fail closed); with
// the agents' service token (ADMIN_ACCESS_CLIENT_ID / ADMIN_ACCESS_CLIENT_SECRET, the release's GitHub
// secrets ADMIN_DEV_ACCESS_CLIENT_ID / _SECRET) `GET /api/me` must answer that token as a service
// identity and name the released build. A deploy check, not an e2e: it opens no browser.
//
//   node infra/scripts/admin-smoke.mjs --sha <40-hex> [--url <admin origin>] [--tries 12] [--every 5000]
//
// The origin is the dev admin's (packages/shared/src/admin/hosts.json) unless --url names another.
//
// Exit 0: both hold. 1: either fails after the tries. 3: the secrets are not set, so nothing was
// checked (a ::warning::, and the release goes on: the secrets are added once the admin-dev domain is
// attached, RUNBOOK "The admin"). The token's values are never printed.
import { pathToFileURL } from 'node:url';

import { adminOrigin } from './admin-hosts.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function smoke({ url, sha, id, secret, tries = 12, every = 5000, fetchImpl = fetch, log = console.log }) {
  const base = url.replace(/\/+$/, '');
  let last = 'not asked';
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const refused = await fetchImpl(`${base}/api/me`, { redirect: 'manual' });
      if (refused.status === 200) return { ok: false, why: 'the admin answered /api/me without any Access token' };
      const res = await fetchImpl(`${base}/api/me`, { headers: { 'cf-access-client-id': id, 'cf-access-client-secret': secret }, redirect: 'manual' });
      const body = await res.json().catch(() => null);
      if (res.status !== 200) last = `HTTP ${res.status}`;
      else if (body?.identity?.kind !== 'service' || body?.identity?.id !== id) last = `it answered as ${JSON.stringify(body?.identity ?? null)}, not the service token`;
      else if (body?.build !== sha) last = `it runs ${String(body?.build).slice(0, 7)}, not ${sha.slice(0, 7)}`;
      else return { ok: true, why: `${base} runs ${sha.slice(0, 7)} and admits the service token` };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    log(`admin-smoke: try ${attempt}/${tries}: ${last}`);
    if (attempt < tries) await sleep(every);
  }
  return { ok: false, why: last };
}

async function main(argv) {
  const at = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
  const url = at('--url', adminOrigin('dev'));
  const sha = at('--sha', '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha <40-hex> is required');
  const id = process.env.ADMIN_ACCESS_CLIENT_ID?.trim();
  const secret = process.env.ADMIN_ACCESS_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    console.log(`::warning::admin-smoke: ADMIN_ACCESS_CLIENT_ID / ADMIN_ACCESS_CLIENT_SECRET are not set: the admin at ${url} was not checked`);
    return 3;
  }
  const result = await smoke({ url, sha, id, secret, tries: Number(at('--tries', '12')), every: Number(at('--every', '5000')) });
  console.log(result.ok ? `admin-smoke: ok: ${result.why}` : `::error::admin-smoke: ${url}: ${result.why}`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code === 3 ? 0 : code),
    (error) => {
      console.error(`admin-smoke: ${error.message}`);
      process.exit(1);
    },
  );
}
