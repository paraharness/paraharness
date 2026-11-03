// The dev stack sits behind Cloudflare Access (CD-285): a request reaches dev.crookedduke.com or
// its API under /api and /ws, only with the service token's two headers, which the release reads from
// the GitHub secrets CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET. Both set: both headers; else
// none, so a check of production (which the release never hands the secrets) sends nothing extra.
// The values are never printed.
export const ACCESS_ID = 'CF_ACCESS_CLIENT_ID';
export const ACCESS_SECRET = 'CF_ACCESS_CLIENT_SECRET';

export function accessHeaders(env = process.env) {
  const id = env[ACCESS_ID]?.trim();
  const secret = env[ACCESS_SECRET]?.trim();
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {};
}
