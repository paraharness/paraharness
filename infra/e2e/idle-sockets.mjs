export const NO_IDLE_TIMEOUT = 0;

export function keepIdleSocketsOpen(server) {
  server.keepAliveTimeout = NO_IDLE_TIMEOUT;
  return server;
}
