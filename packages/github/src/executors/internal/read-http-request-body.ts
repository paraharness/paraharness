import type { IncomingMessage } from 'node:http';
import { DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES } from '../../builders/internal/github-builder-defaults.constants.js';
import type { HttpRequestBodyReadState } from './http-request-body-read-state.js';

/**
 * Reads a Node `IncomingMessage` body up to `maxBytes`, returning `undefined` if the limit is exceeded.
 *
 * Detaches all stream listeners upon settling and rejects if the socket closes before `'end'`.
 *
 * @param {IncomingMessage} req                                              - Node HTTP incoming request stream.
 * @param {number}          [maxBytes=DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES] - Maximum allowed body size in bytes.
 *
 * @returns {Promise<Buffer | undefined>} Complete body buffer, or `undefined` if `maxBytes` was exceeded.
 *
 * @throws {Error} If the request stream emits an error or closes prematurely before completion.
 */
export function readHttpRequestBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES,
): Promise<Buffer | undefined> {
  const state: HttpRequestBodyReadState = {
    chunks: [],
    totalBytes: 0,
    settled: false,
  };
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
      fn();
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      state.totalBytes += buf.length;
      if (state.totalBytes <= maxBytes) {
        state.chunks.push(buf);
        return;
      }
      state.chunks.length = 0;
      req.pause();
      settle(() => resolve(undefined));
    };
    const onEnd = (): void => settle(() => resolve(Buffer.concat(state.chunks)));
    const onError = (err: Error): void => settle(() => reject(err));
    const onClose = (): void => {
      if (!req.complete) {
        settle(() =>
          reject(new Error('GitHub webhook HTTP request closed prematurely before body completed.')),
        );
      }
    };
    req.on('data', onData).on('end', onEnd).on('error', onError).on('close', onClose);
  });
}
