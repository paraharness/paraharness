/**
 * Mutable accumulator state for a single `readHttpRequestBody` stream read operation.
 *
 * Avoids mutating outer `let` variables across nested event listener closures per Rule 3.1.
 */
export interface HttpRequestBodyReadState {
  /** Buffered body chunks accumulated so far. */
  readonly chunks: Buffer[];
  /** Total byte length accumulated across `chunks`. */
  totalBytes: number;
  /** True once the promise has settled via end, size-limit rejection, error, or close. */
  settled: boolean;
}
