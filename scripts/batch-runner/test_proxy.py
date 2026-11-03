import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import anthropic

import fake_backend
import proxy

MODEL = "claude-haiku-5-5"


def echo(params):
    return f"echo: {params['messages'][0]['content']}"


def post(url, body, path="/v1/messages"):
    request = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def params(content, **extra):
    return {"model": MODEL, "max_tokens": 10, "messages": [{"role": "user", "content": content}], **extra}


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.run_dir = Path(self.dir.name) / "run"
        self.started = None

    def tearDown(self):
        if self.started is not None:
            fake_backend.stop(self.started)
        self.dir.cleanup()

    def start(self, respond=echo, **options):
        self.started = fake_backend.start(self.run_dir, respond, **options)
        return self.started

    def concurrently(self, bodies):
        replies = [None] * len(bodies)

        def call(index):
            replies[index] = post(self.started.url, bodies[index])

        threads = [threading.Thread(target=call, args=(index,)) for index in range(len(bodies))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        return replies

    def test_the_proxy_refuses_to_start_without_a_cap(self):
        with self.assertRaises(SystemExit) as raised:
            proxy.main([str(self.run_dir)])
        self.assertEqual(str(raised.exception), "--max-usd is required: pass the most this run may spend, in USD")

    def test_a_queue_with_a_shared_prompt_goes_out_warmed_then_trialled_then_whole(self):
        self.start(batch_requests=15, batch_seconds=60, max_usd=1000.0)
        replies = self.concurrently([params(f"p{index}", system="long prompt") for index in range(15)])
        self.assertEqual([status for status, _ in replies], [200] * 15)
        self.assertEqual([len(requests) for requests in self.started.batches.created.values()], [1, 10, 4])

    def test_a_full_queue_goes_out_as_one_batch_and_each_call_gets_its_own_result(self):
        self.start(batch_requests=4, batch_seconds=60)
        replies = self.concurrently([params(f"p{index}") for index in range(4)])
        self.assertEqual([status for status, _ in replies], [200] * 4)
        self.assertEqual([body["content"][0]["text"] for _, body in replies], [f"echo: p{index}" for index in range(4)])
        self.assertEqual([len(requests) for requests in self.started.batches.created.values()], [4])

    def test_a_partial_queue_goes_out_when_the_time_passes(self):
        self.start(batch_requests=100, batch_seconds=0.3)
        started = time.monotonic()
        status, body = post(self.started.url, params("alone"))
        self.assertEqual((status, body["content"][0]["text"]), (200, "echo: alone"))
        self.assertGreaterEqual(time.monotonic() - started, 0.3)
        self.assertEqual(len(self.started.batches.created), 1)

    def test_calls_past_the_batch_size_go_out_in_the_next_batch(self):
        self.start(batch_requests=2, batch_seconds=0.2)
        replies = self.concurrently([params(f"p{index}") for index in range(3)])
        self.assertEqual([status for status, _ in replies], [200] * 3)
        self.assertEqual(sorted(len(requests) for requests in self.started.batches.created.values()), [1, 2])

    def test_the_system_prompt_gets_the_runners_cache_control_and_stream_false_is_dropped(self):
        self.start(batch_requests=1)
        post(self.started.url, params("hi", system="be brief", stream=False))
        sent = next(iter(self.started.batches.created.values()))[0]["params"]
        self.assertEqual(sent["system"], [{"type": "text", "text": "be brief",
                                           "cache_control": {"type": "ephemeral", "ttl": "1h"}}])
        self.assertNotIn("stream", sent)

    def test_calls_held_back_by_the_spend_cap_get_a_500(self):
        self.start(batch_requests=1, max_usd=6e-6)
        self.assertEqual(post(self.started.url, params("first"))[0], 200)
        status, body = post(self.started.url, params("second"))
        self.assertEqual((status, body["error"]["type"]), (500, "api_error"))
        self.assertEqual(len(self.started.batches.created), 1)

    def test_a_model_without_a_price_is_refused_under_a_spend_cap(self):
        self.start(batch_requests=1, max_usd=10.0)
        status, body = post(self.started.url, {**params("hi"), "model": "claude-unknown"})
        self.assertEqual((status, body["error"]["type"]), (400, "invalid_request_error"))
        self.assertEqual(self.started.batches.created, {})

    def test_an_errored_request_answers_with_its_status_and_error(self):
        self.start(lambda _: fake_backend.errored("invalid_request_error", "max_tokens is too large"), batch_requests=1)
        status, body = post(self.started.url, params("hi"))
        self.assertEqual(status, 400)
        self.assertEqual(body, {"type": "error", "error": {"type": "invalid_request_error",
                                                           "message": "max_tokens is too large"}})

    def test_streaming_and_other_paths_are_refused(self):
        self.start(batch_requests=1)
        self.assertEqual(post(self.started.url, params("hi", stream=True))[0], 400)
        self.assertEqual(post(self.started.url, params("hi"), path="/v1/complete")[0], 404)
        self.assertEqual(self.started.batches.created, {})

    def test_the_anthropic_sdk_runs_unchanged_against_the_proxy(self):
        self.start(batch_requests=1)
        client = anthropic.Anthropic(base_url=self.started.url, api_key="unused", max_retries=0)
        reply = client.messages.create(**params("sdk"))
        self.assertEqual(reply.content[0].text, "echo: sdk")
        self.assertEqual(reply.model, MODEL)


if __name__ == "__main__":
    unittest.main()
