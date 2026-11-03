# batch-runner

Runs a JSONL file of Messages API requests through Anthropic's Message Batches API.

## Setup

```sh
cd scripts/batch-runner
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Put the keys in `~/.env` as one comma-separated variable, used in the order listed (whitespace around a key and empty entries are ignored):

```
ANTHROPIC_API_KEYS=<key 1>,<key 2>,<key 3>
```

`ANTHROPIC_API_KEY` is read the same way when `ANTHROPIC_API_KEYS` is absent. If `~/.env` is missing, has neither, or lists no key, `run.py` and `proxy.py` print one line saying which and exit with status 1.

## Usage

```sh
.venv/bin/python run.py requests.jsonl runs/first --max-usd 50 [--max-batch-usd 2] [--batch-size 1000]
```

Each line of `requests.jsonl` is `{"custom_id": "...", "params": {...Messages API params...}}`.

- Batches are submitted one at a time (at most 100,000 requests or 250 MB each, or `--batch-size`), each polled until it ends and its results appended to `<run-dir>/results.jsonl` as `{"custom_id", "key", "result"}`.
- Key 1 is used until the API reports its credit exhausted, then key 2, and so on. A rate limit waits and retries on the same key. Keys appear only as key-1, key-2, ...
- `<run-dir>/state.json` records each batch, the key that submitted it and whether its results are in. Re-running the same command collects unfinished batches with their own key and submits only requests that were never submitted. Before each submission the runner writes `<run-dir>/pending.json` (the batch's custom ids and the time) and deletes it once `state.json` records the batch. A run that starts with `pending.json` present looks among the key's 20 most recent batches for those created at or after its time less 600 seconds (`CLOCK_SKEW_SECONDS`, for a local clock ahead of the API's) with the same request count, waits for each to end, and records in `state.json` the one whose results hold exactly its custom ids, so a crash between the API accepting a batch and the state file saving it does not pay for that batch twice; then it deletes `pending.json`. A run without `pending.json` lists no batches. The API lists a batch without its custom ids, so they are read from its results once it has ended.
- A system prompt with no `cache_control` gets `{"type": "ephemeral", "ttl": "1h"}` on its last block.
- Before a group of requests is submitted, each distinct cache-marked system prompt in it (per model and exact system text) not warmed within the last 55 minutes on the key in use is sent as one request in a batch of its own; the runner waits for it to end and records its result, then submits the rest of the group, so the rest read the cache instead of each writing it. Warmings (key, model, prefix hash, time) are kept in `state.json`, so a resumed run does not warm again within the window.
- `--max-usd` is checked before each batch against the spend from the results so far plus the batch's worst-case cost: each request's input tokens (its JSON bytes divided by 3, which overstates them) and `max_tokens` at the prices in `PRICES` (half the standard prices), every uncached system prompt priced as a 1-hour cache write and every warm one as a cache read. When the total would pass the limit, only the leading requests that fit are submitted, one line says how many were held back, and the run stops; re-run with a higher cap to submit the rest. Spend itself uses the same prices with every cache write at the 1-hour rate.
- `--max-usd` is required: `run.py` and `proxy.py` print one line and exit with status 1 without it.
- Trial batch: for each distinct (model, cache-marked prefix) not yet measured, after the warming the runner submits at most 10 requests of it (requests with no cache-marked prefix are grouped by model alone), waits for them to end and records their mean cost per request in `state.json` under `trials` (key: model and prefix hash). No other request of that (model, prefix) is submitted until its trial has ended. Then one line per (model, prefix) prints the measured mean cost per request, the number queued and their projected cost at that mean. A resumed run reads its trials from `state.json` and does not repeat them.
- `--max-batch-usd` (default 2.0) is a per-batch ceiling. After a trial a batch's estimate is its request count times twice the measured mean of its (model, prefix); before it, the worst-case estimate above applies. A group whose estimate passes the ceiling is split into consecutive batches each under it, submitted one after another, each waiting for the previous to end so it reads the warm cache (a single request over the ceiling goes alone). `--max-usd` still holds back every batch that would cross the cap.
- The summary prints requests done, failed and not run, tokens per key (uncached input, cache writes, cache reads, output) and the spend.

## Proxy

```sh
.venv/bin/python proxy.py runs/proxy --max-usd 50 [--max-batch-usd 2] [--batch-requests 1000] [--batch-seconds 60] [--port 8787]
```

A local server that takes Messages API calls (`POST /v1/messages`, the API's JSON, no key) one at a time and answers them from batches, so a client that calls the API concurrently runs on batches unchanged: point it at `http://127.0.0.1:8787` with any key and a timeout as long as a batch takes (up to 24 hours).

- Held calls are submitted through the runner as one batch when `--batch-requests` are queued or `--batch-seconds` have passed since the first; one batch is in flight at a time, and calls that arrive meanwhile wait for the next.
- The runner's rules apply: key rotation, the 1-hour cache on the system prompt and `--max-usd`, checked before each batch against its worst-case cost. The trial batch and the per-batch ceiling apply (`--max-batch-usd`). Calls the cap holds back are answered with 500 `api_error`, so a caller retries once the operator raises the cap; once every key is exhausted, calls are answered with 402 `billing_error`.
- A succeeded request is answered with its message; an errored one with its error and the matching status. Streaming is refused.
- `<run-dir>` holds the runner's `state.json` and `results.jsonl`; restarting on the same directory collects a batch left in flight before submitting the next.
- `fake_backend.py <run-dir> <replies.json>` serves the same proxy on a fake batch backend that answers each call with the next string of the JSON array, for a dry run without the API.

## Tests

```sh
.venv/bin/python -m unittest -v
```
