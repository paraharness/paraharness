import argparse
import json
import threading
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from proxy import Proxy, make_server
from run import Runner

USAGE = {"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 5}


class Result:
    def __init__(self, data):
        self.data = data

    def to_dict(self, **_):
        return self.data


def message(params, text):
    return {"id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": params["model"],
            "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
            "usage": dict(USAGE)}


def errored(error_type, text):
    return {"type": "errored", "error": {"type": "error", "error": {"type": error_type, "message": text}}}


class FakeBatches:
    def __init__(self, respond):
        self.respond = respond
        self.created = {}
        self.created_at = {}
        self.lock = threading.Lock()

    def create(self, requests):
        with self.lock:
            batch_id = f"batch-{len(self.created) + 1}"
            self.created[batch_id] = requests
            self.created_at[batch_id] = datetime.now(timezone.utc)
        return SimpleNamespace(id=batch_id)

    def list(self, limit):
        with self.lock:
            created = list(self.created.items())
        batches = [SimpleNamespace(id=batch_id, created_at=self.created_at[batch_id], request_counts=SimpleNamespace(
            processing=0, succeeded=len(requests), errored=0, canceled=0, expired=0))
            for batch_id, requests in reversed(created)]
        return SimpleNamespace(data=batches[:limit])

    def retrieve(self, batch_id):
        return SimpleNamespace(processing_status="ended")

    def results(self, batch_id):
        entries = []
        for request in self.created[batch_id]:
            outcome = self.respond(request["params"])
            if isinstance(outcome, str):
                outcome = {"type": "succeeded", "message": message(request["params"], outcome)}
            entries.append(SimpleNamespace(custom_id=request["custom_id"], result=Result(outcome)))
        return entries


def start(run_dir, respond, max_usd=None, port=0, **proxy_options):
    batches = FakeBatches(respond)
    clients = {1: SimpleNamespace(messages=SimpleNamespace(batches=batches))}
    runner = Runner(clients, run_dir, max_usd=max_usd, poll_seconds=0, log=lambda _: None)
    proxy = Proxy(runner, log=lambda _: None, **proxy_options)
    server = make_server(proxy, "127.0.0.1", port)
    threading.Thread(target=proxy.work, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return SimpleNamespace(proxy=proxy, server=server, batches=batches,
                           url=f"http://127.0.0.1:{server.server_port}")


def stop(started):
    started.proxy.stop()
    started.server.shutdown()
    started.server.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir")
    parser.add_argument("replies")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--batch-requests", type=int, default=1000)
    parser.add_argument("--batch-seconds", type=float, default=1.0)
    args = parser.parse_args(argv)
    replies = json.loads(open(args.replies).read())
    counter = iter(range(1 << 62))
    started = start(args.run_dir, lambda _: replies[next(counter) % len(replies)], port=args.port,
                    batch_requests=args.batch_requests, batch_seconds=args.batch_seconds)
    print(f"fake proxy on {started.url}", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
