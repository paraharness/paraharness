import type { APIRequestContext, BrowserContext } from '@playwright/test';

export type AccessHeaders = Record<string, string>;

export interface AccessOptions {
  accessHeaders: AccessHeaders;
}

export interface AccessRoute {
  socketFailures: () => string[];
  fetchFailures: () => string[];
}

export const NO_REDIRECTS: 0;
export const HIDDEN_ACCESS: '[access header]';
export const SOCKET_ABNORMAL_CLOSE: 1006;

export function routeAccessHeaders(context: BrowserContext, origins: readonly string[], headers: AccessHeaders): Promise<AccessRoute>;

export function requestAccessHeaders(api: APIRequestContext, origins: readonly string[], headers: AccessHeaders, baseURL: string): void;
