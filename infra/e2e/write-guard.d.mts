import type { APIRequestContext, BrowserContext, Route } from '@playwright/test';

export const READ_METHODS: Set<string>;
export function refuseWrite(route: Route): Promise<void>;

export interface Write {
  method: string;
  url: URL;
  body: unknown;
  authorization: string | undefined;
}

export type Refusal = string | null;

export interface WriteJudge {
  judge: (write: Write) => Refusal | Promise<Refusal>;
}

export interface BrowserWriteJudge extends WriteJudge {
  describe: (write: Write) => string;
}

export interface BrowserWriteGuard {
  refused: () => Promise<string[]>;
}

export interface ApiWriteGuard {
  refused: () => string[];
}

export function guardBrowserWrites(context: BrowserContext, judge: BrowserWriteJudge): Promise<BrowserWriteGuard>;

export function guardApiWrites(api: APIRequestContext, baseURL: string, judge: WriteJudge): ApiWriteGuard;
