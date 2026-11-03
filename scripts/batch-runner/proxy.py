import argparse
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

from run import DEFAULT_MAX_BATCH_USD, MAX_BATCH_REQUESTS, PRICES, Runner, read_keys, require_cap

DEFAULT_BATCH_REQUESTS = 1000
DEFAULT_BATCH_SECONDS = 60.0
ERROR_STATUS = {
    "invalid_request_error": 400,
    "authentication_error": 401,
    "billing_error": 402,
    "permission_error": 403,
    "not_found_error": 404,
    "request_too_large": 413,
    "rate_limit_error": 429,
    "api_error": 500,
    "overloaded_error": 529,
}
NOT_SUBMITTED = "the proxy submitted no batch for this call: every key's credit is exhausted"
HELD_BACK = "the proxy held this call back: its batch would pass the spend cap; retry once the operator raises it"


def error_body(error_type, message):
    return {"type": "error", "error": {"type": error_type, "message": message}}


class Call:
    def __init__(self, params):
        self.custom_id = uuid.uuid4().hex
        self.params = params
        self.status = None
        self.body = None
        self.done = threading.Event()

    def answer(self, status, body):
        self.status = status
        self.body = body
        self.done.set()


def answer_with_result(call, result):
    if result is None:
        call.answer(402, error_body("billing_error", NOT_SUBMITTED))
    elif result["type"] == "succeeded":
        call.answer(200, result["message"])
    elif result["type"] == "errored":
        error = result["error"].get("error", result["error"])
        call.answer(ERROR_STATUS.get(error.get("type"), 500), {"type": "error", "error": error})
    else:
        call.answer(500, error_body("api_error", f"the batch request was {result['type']}"))


class Proxy:
    def __init__(self, runner, batch_requests=DEFAULT_BATCH_REQUESTS, batch_seconds=DEFAULT_BATCH_SECONDS,
                 clock=time.monotonic, log=print):
        self.runner = runner
        self.batch_requests = min(batch_requests, MAX_BATCH_REQUESTS)
        self.batch_seconds = batch_seconds
        self.clock = clock
        self.log = log
        self.queue = []
        self.first = None
        self.stopped = False
        self.condition = threading.Condition()

    def submit(self, params):
        call = Call(params)
        with self.condition:
            if not self.queue:
                self.first = self.clock()
            self.queue.append(call)
            self.condition.notify_all()
        return call

    def stop(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()

    def take(self):
        with self.condition:
            while not self.stopped:
                if not self.queue:
                    self.condition.wait()
                    continue
                remaining = self.first + self.batch_seconds - self.clock()
                if len(self.queue) >= self.batch_requests or remaining <= 0:
                    taken = self.queue[:self.batch_requests]
                    self.queue = self.queue[self.batch_requests:]
                    self.first = self.clock() if self.queue else None
                    return taken
                self.condition.wait(remaining)
            return None

    def flush(self, calls):
        requests = [{"custom_id": call.custom_id, "params": call.params} for call in calls]
        try:
            self.runner.run(requests)
        except Exception as error:
            self.log(f"batch failed: {type(error).__name__}")
            for call in calls:
                call.answer(500, error_body("api_error", f"the batch failed: {type(error).__name__}"))
            return
        wanted = {call.custom_id for call in calls}
        results = {entry["custom_id"]: entry["result"] for entry in self.runner.read_results()
                   if entry["custom_id"] in wanted}
        for call in calls:
            if call.custom_id in self.runner.held:
                call.answer(500, error_body("api_error", HELD_BACK))
            else:
                answer_with_result(call, results.get(call.custom_id))

    def work(self):
        while (calls := self.take()) is not None:
            self.flush(calls)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    proxy = None

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def parsed(self):
        if self.path.split("?")[0] != "/v1/messages":
            return None, (404, error_body("not_found_error", "the proxy serves POST /v1/messages only"))
        try:
            params = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        except ValueError:
            return None, (400, error_body("invalid_request_error", "the body is not JSON"))
        if not isinstance(params, dict) or not isinstance(params.get("model"), str):
            return None, (400, error_body("invalid_request_error", "the body is not a Messages API request with a model"))
        if params.get("stream"):
            return None, (400, error_body("invalid_request_error", "the proxy answers from batches and cannot stream"))
        if self.proxy.runner.max_usd is not None and params["model"] not in PRICES:
            return None, (400, error_body("invalid_request_error", f"the spend cap needs a price for {params['model']}"))
        return {name: value for name, value in params.items() if name != "stream"}, None

    def do_POST(self):
        params, refusal = self.parsed()
        if refusal is not None:
            self.reply(*refusal)
            return
        call = self.proxy.submit(params)
        call.done.wait()
        self.reply(call.status, call.body)

    def log_message(self, *_):
        pass


def make_server(proxy, host, port):
    server = ThreadingHTTPServer((host, port), type("BoundHandler", (Handler,), {"proxy": proxy}))
    server.daemon_threads = True
    return server


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir")
    parser.add_argument("--max-usd", type=float)
    parser.add_argument("--max-batch-usd", type=float, default=DEFAULT_MAX_BATCH_USD)
    parser.add_argument("--batch-requests", type=int, default=DEFAULT_BATCH_REQUESTS)
    parser.add_argument("--batch-seconds", type=float, default=DEFAULT_BATCH_SECONDS)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args(argv)
    require_cap(args.max_usd)

    keys = read_keys(Path.home() / ".env")
    clients = {n: anthropic.Anthropic(api_key=key) for n, key in enumerate(keys, start=1)}
    runner = Runner(clients, args.run_dir, max_usd=args.max_usd, max_batch_usd=args.max_batch_usd)
    proxy = Proxy(runner, batch_requests=args.batch_requests, batch_seconds=args.batch_seconds)
    server = make_server(proxy, args.host, args.port)
    threading.Thread(target=proxy.work, daemon=True).start()
    print(f"proxy on http://{args.host}:{server.server_port}, run dir {args.run_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        proxy.stop()
        server.server_close()
        print(runner.summary(len(runner.read_results())))


if __name__ == "__main__":
    main()
