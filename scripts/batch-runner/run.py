import argparse
import copy
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import anthropic

MAX_BATCH_REQUESTS = 100_000
MAX_BATCH_BYTES = 250 * 1024 * 1024
POLL_SECONDS = 60
RATE_LIMIT_SECONDS = 60
TRANSIENT_ERRORS = (anthropic.APIConnectionError, anthropic.InternalServerError, anthropic.RateLimitError)
CACHE_CONTROL = {"type": "ephemeral", "ttl": "1h"}

PRICES = {
    "claude-fable-5-1": (10.0, 20.0, 0.25, 50.0),
    "claude-mythos-5-1": (10.0, 20.0, 0.25, 50.0),
    "claude-fable-5": (10.0, 20.0, 1.0, 50.0),
    "claude-mythos-5": (10.0, 20.0, 1.0, 50.0),
    "claude-opus-5-5": (4.0, 8.0, 0.20, 20.0),
    "claude-opus-5": (5.0, 10.0, 0.50, 25.0),
    "claude-opus-4-8": (5.0, 10.0, 0.50, 25.0),
    "claude-opus-4-7": (5.0, 10.0, 0.50, 25.0),
    "claude-opus-4-6": (5.0, 10.0, 0.50, 25.0),
    "claude-opus-4-5": (5.0, 10.0, 0.50, 25.0),
    "claude-sonnet-5-5": (2.0, 4.0, 0.10, 10.0),
    "claude-sonnet-5": (2.0, 4.0, 0.20, 10.0),
    "claude-sonnet-4-6": (3.0, 6.0, 0.30, 15.0),
    "claude-sonnet-4-5": (3.0, 6.0, 0.30, 15.0),
    "claude-haiku-5-5": (0.10, 0.20, 0.01, 0.50),
    "claude-haiku-4-5": (1.0, 2.0, 0.10, 5.0),
}
LONG_PROMPT_PRICES = {"claude-haiku-5-5": (100_000, (0.50, 1.0, 0.05, 2.50))}
BATCH_DISCOUNT = 0.5
WARM_SECONDS = 55 * 60
BYTES_PER_TOKEN = 3
TRIAL_REQUESTS = 10
CEILING_FACTOR = 2
DEFAULT_MAX_BATCH_USD = 2.0
TOKEN_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
RECENT_BATCHES = 20
CLOCK_SKEW_SECONDS = 600


def read_keys(env_path):
    if not env_path.is_file():
        sys.exit("no ~/.env file: create it with ANTHROPIC_API_KEYS=<key 1>,<key 2>,...")
    value = None
    for line in env_path.read_text().splitlines():
        match = re.match(r"\s*(?:export\s+)?ANTHROPIC_API_KEYS?\s*=\s*(.*)$", line)
        if match:
            value = match.group(1).strip().strip("'\"")
    if value is None:
        sys.exit("no ANTHROPIC_API_KEYS in ~/.env: add ANTHROPIC_API_KEYS=<key 1>,<key 2>,...")
    keys = [key.strip() for key in value.split(",") if key.strip()]
    if not keys:
        sys.exit("ANTHROPIC_API_KEYS in ~/.env lists no key: set it to <key 1>,<key 2>,...")
    return keys


def require_cap(max_usd):
    if max_usd is None:
        sys.exit("--max-usd is required: pass the most this run may spend, in USD")


def with_cache_control(params):
    system = params.get("system")
    if not system:
        return params
    blocks = [{"type": "text", "text": system}] if isinstance(system, str) else copy.deepcopy(system)
    if any("cache_control" in block for block in blocks):
        return params
    blocks[-1]["cache_control"] = dict(CACHE_CONTROL)
    return {**params, "system": blocks}


def chunk(requests, max_requests):
    batches, current, size = [], [], 0
    for request in requests:
        request_size = len(json.dumps(request).encode())
        if current and (len(current) >= max_requests or size + request_size > MAX_BATCH_BYTES):
            batches.append(current)
            current, size = [], 0
        current.append(request)
        size += request_size
    if current:
        batches.append(current)
    return batches


def prefix_of(params):
    system = params.get("system")
    if not isinstance(system, list) or not any("cache_control" in block for block in system):
        return None
    return params["model"], hashlib.sha256(json.dumps(system, sort_keys=True).encode()).hexdigest()


def credit_exhausted(error):
    return isinstance(error, anthropic.APIStatusError) and (
        error.status_code == 402
        or error.type == "billing_error"
        or "credit balance" in str(error.message).lower()
    )


def retry_after(error):
    try:
        return float(error.response.headers.get("retry-after", RATE_LIMIT_SECONDS))
    except ValueError:
        return RATE_LIMIT_SECONDS


def cost(model, usage):
    tokens = [usage.get(field) or 0 for field in TOKEN_FIELDS]
    prices = PRICES[model]
    if model in LONG_PROMPT_PRICES and sum(tokens[:3]) > LONG_PROMPT_PRICES[model][0]:
        prices = LONG_PROMPT_PRICES[model][1]
    return sum(count * price for count, price in zip(tokens, prices)) * BATCH_DISCOUNT / 1_000_000


class Runner:
    def __init__(self, clients, run_dir, max_usd=None, batch_size=MAX_BATCH_REQUESTS,
                 max_batch_usd=DEFAULT_MAX_BATCH_USD, poll_seconds=POLL_SECONDS, sleep=time.sleep, log=print,
                 clock=time.time):
        self.clients = clients
        self.run_dir = Path(run_dir)
        self.max_usd = max_usd
        self.batch_size = batch_size
        self.max_batch_usd = max_batch_usd
        self.poll_seconds = poll_seconds
        self.sleep = sleep
        self.log = log
        self.clock = clock
        self.held = set()
        self.capped = False
        self.state_path = self.run_dir / "state.json"
        self.pending_path = self.run_dir / "pending.json"
        self.results_path = self.run_dir / "results.jsonl"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {"key": 1, "batches": []}
        self.state.setdefault("warmings", [])
        self.state.setdefault("trials", {})

    def save(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=1))
        tmp.replace(self.state_path)

    def read_results(self):
        if not self.results_path.exists():
            return []
        return [json.loads(line) for line in self.results_path.read_text().splitlines() if line.strip()]

    def spend(self):
        return sum(
            cost(entry["result"]["message"]["model"], entry["result"]["message"]["usage"])
            for entry in self.read_results()
            if entry["result"]["type"] == "succeeded"
        )

    def is_warm(self, prefix):
        return any(
            w["key"] == self.state["key"] and (w["model"], w["prefix"]) == prefix
            and self.clock() - w["time"] < WARM_SECONDS
            for w in self.state["warmings"]
        )

    def record_warming(self, key, prefix):
        self.state["warmings"] = [
            w for w in self.state["warmings"] if (w["key"], w["model"], w["prefix"]) != (key, *prefix)
        ]
        self.state["warmings"].append({"key": key, "model": prefix[0], "prefix": prefix[1], "time": self.clock()})
        self.save()

    def cold_prefixes(self, group):
        cold = {}
        for request in group:
            prefix = prefix_of(request["params"])
            if prefix is not None and prefix not in cold and not self.is_warm(prefix):
                cold[prefix] = request
        return cold

    def estimate(self, request):
        params = request["params"]
        prices = PRICES[params["model"]]
        total = len(json.dumps(request).encode()) / BYTES_PER_TOKEN
        system = len(json.dumps(params["system"]).encode()) / BYTES_PER_TOKEN if params.get("system") else 0
        if params["model"] in LONG_PROMPT_PRICES and total > LONG_PROMPT_PRICES[params["model"]][0]:
            prices = LONG_PROMPT_PRICES[params["model"]][1]
        uncached, write, read, output = prices
        prefix = prefix_of(params)
        system_price = read if prefix is not None and self.is_warm(prefix) else write
        usd = (total - system) * uncached + system * system_price + params["max_tokens"] * output
        return usd * BATCH_DISCOUNT / 1_000_000

    def affordable(self, requests):
        if self.max_usd is None:
            return len(requests)
        budget = self.max_usd - self.spend()
        for count, request in enumerate(requests):
            budget -= self.estimate(request)
            if budget < 0:
                return count
        return len(requests)

    def collect(self, batch):
        client = self.clients[batch["key"]]
        written = {entry["custom_id"] for entry in self.read_results()}
        while True:
            try:
                while client.messages.batches.retrieve(batch["id"]).processing_status != "ended":
                    self.sleep(self.poll_seconds)
                with self.results_path.open("a") as out:
                    for entry in client.messages.batches.results(batch["id"]):
                        if entry.custom_id not in written:
                            out.write(json.dumps({"custom_id": entry.custom_id, "key": batch["key"],
                                                  "result": entry.result.to_dict(mode="json")}) + "\n")
                            written.add(entry.custom_id)
                break
            except TRANSIENT_ERRORS as error:
                self.log(f"key-{batch['key']}: {type(error).__name__} while collecting {batch['id']}; retrying")
                self.sleep(self.poll_seconds)
        batch["done"] = True
        self.save()
        self.log(f"batch {batch['id']} done (key-{batch['key']})")

    def accepted_ids(self, client, batch_id):
        while client.messages.batches.retrieve(batch_id).processing_status != "ended":
            self.sleep(self.poll_seconds)
        return sorted(entry.custom_id for entry in client.messages.batches.results(batch_id))

    def adopt(self, pending):
        key = self.state["key"]
        if key not in self.clients:
            return
        client = self.clients[key]
        ids = pending["custom_ids"]
        known = {batch["id"] for batch in self.state["batches"]}
        for listed in client.messages.batches.list(limit=RECENT_BATCHES).data:
            counts = listed.request_counts
            total = counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired
            if (listed.id in known or listed.created_at.timestamp() < pending["time"] - CLOCK_SKEW_SECONDS or total != len(ids)
                    or self.accepted_ids(client, listed.id) != sorted(ids)):
                continue
            self.state["batches"].append({"id": listed.id, "key": key, "custom_ids": ids, "done": False})
            self.save()
            self.log(f"adopted batch {listed.id} with {len(ids)} requests (key-{key}): "
                     f"the API accepted it before the last run stopped")
            return

    def mark_pending(self, requests):
        tmp = self.pending_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"custom_ids": [r["custom_id"] for r in requests], "time": self.clock()}))
        tmp.replace(self.pending_path)

    def submit(self, requests):
        self.mark_pending(requests)
        while True:
            key = self.state["key"]
            if key not in self.clients:
                self.pending_path.unlink()
                return None
            try:
                created = self.clients[key].messages.batches.create(requests=requests)
            except anthropic.RateLimitError as error:
                self.log(f"key-{key} rate limited; waiting")
                self.sleep(retry_after(error))
                continue
            except anthropic.APIStatusError as error:
                if not credit_exhausted(error):
                    raise
                self.log(f"key-{key} credit exhausted; moving to key-{key + 1}")
                self.state["key"] = key + 1
                self.save()
                continue
            batch = {"id": created.id, "key": key, "custom_ids": [r["custom_id"] for r in requests], "done": False}
            self.state["batches"].append(batch)
            self.save()
            self.pending_path.unlink()
            self.log(f"submitted batch {created.id} with {len(requests)} requests (key-{key})")
            return batch

    def submit_capped(self, requests):
        fit = self.affordable(requests)
        if fit < len(requests):
            self.capped = True
            self.log(f"spend cap ${self.max_usd}: holding back {len(requests) - fit} of {len(requests)} requests")
        if fit == 0:
            return None, 0
        return self.submit(requests[:fit]), fit

    def trial_key(self, request):
        prefix = prefix_of(request["params"])
        return request["params"]["model"], prefix[1] if prefix else ""

    def measured(self, key):
        return self.state["trials"].get(":".join(key))

    def batch_estimate(self, request):
        mean = self.measured(self.trial_key(request))
        return self.estimate(request) if mean is None else mean * CEILING_FACTOR

    def split(self, requests, estimate):
        parts, current, total = [], [], 0.0
        for request in requests:
            usd = estimate(request)
            if current and total + usd > self.max_batch_usd:
                parts.append(current)
                current, total = [], 0.0
            current.append(request)
            total += usd
        if current:
            parts.append(current)
        return parts

    def send(self, requests, estimate, on_submitted=None):
        for part in self.split(requests, estimate):
            batch, fit = self.submit_capped(part)
            if batch is None:
                return False
            if on_submitted is not None:
                on_submitted(batch, part[:fit])
            self.collect(batch)
            if fit < len(part):
                return False
        return True

    def trial_requests(self, group):
        taken, trial = {}, []
        for request in group:
            key = self.trial_key(request)
            if self.measured(key) is None and taken.get(key, 0) < TRIAL_REQUESTS:
                taken[key] = taken.get(key, 0) + 1
                trial.append(request)
        return trial

    def record_trials(self, trial, group):
        keys = {request["custom_id"]: self.trial_key(request) for request in trial}
        costs = {}
        for entry in self.read_results():
            key = keys.get(entry["custom_id"])
            if key is not None and entry["result"]["type"] == "succeeded":
                message = entry["result"]["message"]
                costs.setdefault(key, []).append(cost(message["model"], message["usage"]))
        for key, values in sorted(costs.items()):
            mean = sum(values) / len(values)
            self.state["trials"][":".join(key)] = mean
            queued = sum(1 for request in group
                         if request["custom_id"] not in keys and self.trial_key(request) == key)
            label = f"{key[0]} {key[1][:12]}" if key[1] else f"{key[0]} (no cached prefix)"
            self.log(f"trial {label}: mean ${mean:.6f} per request, {queued} queued, "
                     f"projected ${mean * queued:.2f}")
        self.save()

    def run_group(self, group):
        cold = self.cold_prefixes(group)
        if cold:
            warming = list(cold.values())
            prefixes = {request["custom_id"]: prefix for prefix, request in cold.items()}

            def record(batch, sent):
                for request in sent:
                    self.record_warming(batch["key"], prefixes[request["custom_id"]])

            if not self.send(warming, self.estimate, record):
                return False
            sent = {request["custom_id"] for request in warming}
            group = [request for request in group if request["custom_id"] not in sent]
        trial = self.trial_requests(group)
        if trial:
            sent = self.send(trial, self.estimate)
            self.record_trials(trial, group)
            if not sent:
                return False
            ids = {request["custom_id"] for request in trial}
            group = [request for request in group if request["custom_id"] not in ids]
        return not group or self.send(group, self.batch_estimate)

    def run(self, requests):
        self.run_dir.mkdir(parents=True, exist_ok=True)
        if self.pending_path.exists():
            self.adopt(json.loads(self.pending_path.read_text()))
            self.pending_path.unlink()
        for batch in self.state["batches"]:
            if not batch["done"]:
                self.collect(batch)
        submitted = {cid for batch in self.state["batches"] for cid in batch["custom_ids"]}
        pending = [
            {"custom_id": r["custom_id"], "params": with_cache_control(r["params"])}
            for r in requests if r["custom_id"] not in submitted
        ]
        self.held = set()
        self.capped = False
        for group in chunk(pending, self.batch_size):
            if not self.run_group(group):
                if self.capped:
                    sent = {cid for batch in self.state["batches"] for cid in batch["custom_ids"]}
                    self.held = {r["custom_id"] for r in pending if r["custom_id"] not in sent}
                else:
                    self.log("every key's credit is exhausted; submitting no more batches")
                return False
        return True

    def summary(self, total):
        results = self.read_results()
        done = sum(1 for entry in results if entry["result"]["type"] == "succeeded")
        lines = [f"requests: {total}, done: {done}, failed: {len(results) - done}, not run: {total - len(results)}"]
        per_key = {}
        for entry in results:
            if entry["result"]["type"] == "succeeded":
                usage = entry["result"]["message"]["usage"]
                sums = per_key.setdefault(entry["key"], [0, 0, 0, 0])
                for i, field in enumerate(TOKEN_FIELDS):
                    sums[i] += usage.get(field) or 0
        for key in sorted(per_key):
            uncached, writes, reads, output = per_key[key]
            lines.append(f"key-{key}: uncached input {uncached}, cache writes {writes}, cache reads {reads}, output {output}")
        if all(entry["result"]["message"]["model"] in PRICES for entry in results if entry["result"]["type"] == "succeeded"):
            lines.append(f"spend: ${self.spend():.2f}")
        return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("requests")
    parser.add_argument("run_dir")
    parser.add_argument("--max-usd", type=float)
    parser.add_argument("--max-batch-usd", type=float, default=DEFAULT_MAX_BATCH_USD)
    parser.add_argument("--batch-size", type=int, default=MAX_BATCH_REQUESTS)
    args = parser.parse_args(argv)
    require_cap(args.max_usd)

    requests = [json.loads(line) for line in Path(args.requests).read_text().splitlines() if line.strip()]
    unknown = sorted({r["params"]["model"] for r in requests} - set(PRICES))
    if unknown:
        sys.exit(f"--max-usd needs a price for: {', '.join(unknown)}")
    keys = read_keys(Path.home() / ".env")
    clients = {n: anthropic.Anthropic(api_key=key) for n, key in enumerate(keys, start=1)}
    runner = Runner(clients, args.run_dir, max_usd=args.max_usd, batch_size=min(args.batch_size, MAX_BATCH_REQUESTS),
                    max_batch_usd=args.max_batch_usd)
    runner.run(requests)
    print(runner.summary(len(requests)))


if __name__ == "__main__":
    main()
