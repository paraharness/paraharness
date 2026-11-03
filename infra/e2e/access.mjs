export const NO_REDIRECTS = 0;
export const MOST_SAME_ORIGIN_HOPS = 10;
export const HIDDEN_ACCESS = '[access header]';
export const SOCKET_ABNORMAL_CLOSE = 1006;

const sendsAny = (headers) => Object.keys(headers).length > 0;

const OFFLINE = 'internetdisconnected';
const CONNECTION_RESET = /ECONNRESET|socket hang up/;
const RESPONSE_DISPOSED = /Fetch response has been disposed/;
const TARGET_CLOSED = /Target page, context or browser has been closed|Request context disposed/;
const SOCKET_SCHEMES = { 'http:': 'ws:', 'https:': 'wss:' };
const NORMAL_CLOSE = 1000;
const APPLICATION_CLOSES = { from: 3000, to: 4999 };
const NO_FAILURES = Object.freeze({ socketFailures: () => [], fetchFailures: () => [] });

function trackOffline(context) {
  const state = { offline: false, sockets: new Set() };
  const setOffline = context.setOffline.bind(context);
  context.setOffline = async (offline) => {
    state.offline = offline;
    if (offline) for (const drop of [...state.sockets]) drop();
    return setOffline(offline);
  };
  return state;
}

async function fulfilUnlessDisposed(route, response) {
  try {
    await route.fulfill({ response });
  } catch (error) {
    if (!RESPONSE_DISPOSED.test(String(error?.message))) throw error;
  }
}

const FOLLOWED_METHODS = ['GET', 'HEAD'];
const isRedirect = (status) => status >= 300 && status < 400;

function sameOriginLocation(response, from) {
  const location = response.headers()['location'];
  if (!isRedirect(response.status()) || !location) return null;
  const next = new URL(location, from);
  return next.origin === new URL(from).origin ? next.href : null;
}

async function fetchRetryingReset(route, request, options, hide) {
  try {
    return await route.fetch(options);
  } catch (error) {
    const cause = causeOf(error);
    if (!FOLLOWED_METHODS.includes(request.method()) || !CONNECTION_RESET.test(cause)) throw error;
    console.warn(hide(`access retry: ${request.method()} ${withoutQuery(options.url ?? request.url())}: ${cause}`));
    return route.fetch(options);
  }
}

async function fetchWithinOrigin(route, request, headers, hide) {
  const sent = { headers: { ...request.headers(), ...headers }, maxRedirects: NO_REDIRECTS };
  let response = await fetchRetryingReset(route, request, sent, hide);
  if (!isRedirect(response.status()) || !FOLLOWED_METHODS.includes(request.method())) return response;
  let at = request.url();
  for (let hop = 0; hop < MOST_SAME_ORIGIN_HOPS; hop += 1) {
    const next = sameOriginLocation(response, at);
    if (next === null) return response;
    at = next;
    response = await fetchRetryingReset(route, request, { ...sent, url: at }, hide);
  }
  return response;
}

const causeOf = (error) => String(error?.message ?? error).split('\n')[0];

function fetchFailureRecorder(hide) {
  const failures = [];
  return {
    record: (request, error) => {
      const cause = causeOf(error);
      if (!TARGET_CLOSED.test(cause)) failures.push(hide(`${request.method()} ${withoutQuery(request.url())}: ${cause}`));
    },
    fetchFailures: () => [...failures],
  };
}

export async function routeAccessHeaders(context, origins, headers) {
  if (!sendsAny(headers)) return NO_FAILURES;
  const network = trackOffline(context);
  const hide = hider(headers);
  const fetches = fetchFailureRecorder(hide);
  await context.route(
    (url) => origins.includes(url.origin),
    async (route) => {
      if (network.offline) return route.abort(OFFLINE);
      const request = route.request();
      const response = await fetchWithinOrigin(route, request, headers, hide).catch((error) => fetches.record(request, error));
      return response ? fulfilUnlessDisposed(route, response) : route.abort();
    },
  );
  const sockets = await bridgeSockets(context, origins, headers, network);
  return { ...sockets, fetchFailures: fetches.fetchFailures };
}

const socketOrigin = (origin) => {
  const url = new URL(origin);
  return `${SOCKET_SCHEMES[url.protocol] ?? url.protocol}//${url.host}`;
};

const withoutQuery = (address) => {
  const url = new URL(address);
  return `${url.origin}${url.pathname}`;
};

const sendableClose = (code) => code === NORMAL_CLOSE || (code >= APPLICATION_CLOSES.from && code <= APPLICATION_CLOSES.to);

const frame = (data) => (typeof data === 'string' ? data : Buffer.from(data));

function serverOpened(server) {
  return new Promise((settle) => {
    server.addEventListener('open', () => settle(true), { once: true });
    server.addEventListener('error', () => settle(false), { once: true });
    server.addEventListener('close', () => settle(false), { once: true });
  });
}

async function bridgeSockets(context, origins, headers, network) {
  const bridged = origins.map(socketOrigin);
  const failures = [];
  await context.routeWebSocket(
    (url) => bridged.includes(url.origin),
    async (page) => {
      if (network.offline) return page.close({ code: SOCKET_ABNORMAL_CLOSE });
      const server = new WebSocket(page.url(), { headers });
      server.binaryType = 'arraybuffer';
      if (!(await serverOpened(server))) {
        failures.push(`${withoutQuery(page.url())}: the handshake through the Access bridge failed`);
        return page.close({ code: SOCKET_ABNORMAL_CLOSE });
      }
      const drop = () => {
        server.close();
        void page.close({ code: SOCKET_ABNORMAL_CLOSE });
      };
      network.sockets.add(drop);
      page.onMessage((message) => server.send(message));
      page.onClose((code, reason) => (sendableClose(code) ? server.close(code, reason) : server.close()));
      server.addEventListener('message', (event) => page.send(frame(event.data)));
      server.addEventListener('close', (event) => {
        network.sockets.delete(drop);
        void page.close({ code: event.code, reason: event.reason });
      });
    },
  );
  return { socketFailures: () => [...failures] };
}

function hider(headers) {
  const values = Object.values(headers).filter((value) => value.length > 0);
  return (text) => values.reduce((hidden, value) => hidden.replaceAll(value, HIDDEN_ACCESS), text);
}

function hideInError(error, hide) {
  if (!(error instanceof Error)) return error;
  error.message = hide(error.message);
  if (error.stack) error.stack = hide(error.stack);
  return error;
}

function hideInLog(response, hide) {
  const log = response._fetchLog?.bind(response);
  if (log) response._fetchLog = async () => (await log()).map(hide);
  return response;
}

export function requestAccessHeaders(api, origins, headers, baseURL) {
  if (!sendsAny(headers)) return;
  const send = api._innerFetch?.bind(api);
  if (!send) throw new Error('@playwright/test no longer sends requests through APIRequestContext._innerFetch; the Access token cannot be kept to its origins');
  const hide = hider(headers);
  api._innerFetch = async (options = {}) => {
    const url = new URL(options.url ?? options.request?.url() ?? '', baseURL);
    const sent = origins.includes(url.origin)
      ? { ...options, headers: { ...(options.headers ?? options.request?.headers()), ...headers }, maxRedirects: NO_REDIRECTS }
      : options;
    try {
      return hideInLog(await send(sent), hide);
    } catch (error) {
      throw hideInError(error, hide);
    }
  };
}
