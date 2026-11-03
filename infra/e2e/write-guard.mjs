export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_REFUSED = 405;
const DEFAULT_METHOD = 'GET';
const AUTHORIZATION = 'authorization';

export const refuseWrite = (route) =>
  route.fulfill({
    status: WRITE_REFUSED,
    json: { error: { code: 'refused', message: 'The interaction check sends no writes.' } },
  });

const parsed = (text) => {
  if (typeof text !== 'string') return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const authorizationOf = (headers = {}) =>
  Object.entries(headers).find(([name]) => name.toLowerCase() === AUTHORIZATION)?.[1];

function browserWrite(request) {
  let body = null;
  try {
    body = request.postDataJSON();
  } catch {
    body = null;
  }
  return { method: request.method(), url: new URL(request.url()), body, authorization: authorizationOf(request.headers()) };
}

function apiWrite(options, baseURL) {
  const request = options.request;
  return {
    method: (options.method ?? request?.method() ?? DEFAULT_METHOD).toUpperCase(),
    url: new URL(options.url ?? request?.url() ?? '', baseURL),
    body: options.data !== undefined ? parsed(options.data) : request ? browserWrite(request).body : null,
    authorization: authorizationOf(options.headers ?? request?.headers()),
  };
}

export async function guardBrowserWrites(context, { judge, describe }) {
  const refused = [];
  const reached = [];
  const allowed = new WeakSet();
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (READ_METHODS.has(request.method())) return route.fallback();
    const refusal = await judge(browserWrite(request));
    if (refusal === null) {
      allowed.add(request);
      return route.fallback();
    }
    refused.push(refusal);
    return refuseWrite(route);
  });
  context.on('response', (response) => {
    const request = response.request();
    if (READ_METHODS.has(request.method()) || allowed.has(request)) return;
    const write = browserWrite(request);
    reached.push(response.serverAddr().then((address) => (address === null ? null : `${describe(write)} reached the server`)));
  });
  return {
    refused: async () => [...refused, ...(await Promise.all(reached)).filter((write) => write !== null)],
  };
}

export function guardApiWrites(api, baseURL, { judge }) {
  const send = api._innerFetch?.bind(api);
  if (!send) throw new Error('@playwright/test no longer sends requests through APIRequestContext._innerFetch; the write guard cannot see them');
  const refused = [];
  api._innerFetch = async (options = {}) => {
    const write = apiWrite(options, baseURL);
    if (!READ_METHODS.has(write.method)) {
      const refusal = await judge(write);
      if (refusal !== null) {
        refused.push(refusal);
        throw new Error(`The journeys may not send ${refusal}`);
      }
    }
    return send(options);
  };
  return { refused: () => [...refused] };
}
