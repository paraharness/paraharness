import { readFileSync } from 'node:fs';

export const ADMIN_HOSTS = JSON.parse(readFileSync(new URL('../../packages/shared/src/admin/hosts.json', import.meta.url), 'utf8'));

export const adminOrigin = (stack) => `https://${ADMIN_HOSTS[stack].host}`;
