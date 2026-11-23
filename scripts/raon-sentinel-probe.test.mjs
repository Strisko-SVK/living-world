/* global Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localEndpoint,
  parseSpeech,
  runRaonSentinelProbe,
} from "./raon-sentinel-probe.mjs";

test("only a local loopback endpoint can be used", () => {
  assert.equal(localEndpoint(), "http://127.0.0.1:8000/v1/chat/completions");
  for (const bad of [
    "https://127.0.0.1:8000",
    "http://example.com:8000",
    "http://127.0.0.1:8000/another-path",
    "http://user:pass@127.0.0.1:8000",
  ]) {
    assert.throws(() => localEndpoint(bad));
  }
});

test("requires a single, nonempty speech key", () => {
  assert.equal(
    parseSpeech({
      choices: [{ message: { content: '{"speech":"Standing by."}' } }],
    }),
    "Standing by.",
  );
  for (const content of [
    "nope",
    "{}",
    '{"speech":""}',
    '{"speech":"Hi","action":1}',
  ]) {
    assert.throws(() => parseSpeech({ choices: [{ message: { content } }] }));
  }
});

test("offline fake transport sends bounded, role-separated requests and logs only metrics", async () => {
  const calls = [];
  const logs = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"speech":"Standing by."}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await runRaonSentinelProbe({
    fetchFn,
    log: (x) => logs.push(JSON.parse(x)),
    cases: [{ id: "test", text: "Hello" }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].scenario, "test");
  assert.equal(result[0].inputTokens, 50);
  assert.equal(result[0].speech, undefined);
  assert.equal(logs[0].speech, undefined);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/chat/completions");
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, "Raon-1-nano");
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[1].role, "user");
  assert.equal(payload.messages[1].content, "Hello");
  assert.equal(payload.response_format.type, "json_object");
});
