import { test } from "node:test";
import assert from "node:assert/strict";
import { containsExpectedModel, localInferenceTarget } from "./dev-doctor.mjs";

test("defaults to approved legacy RAON profile", () => {
  assert.deepEqual(localInferenceTarget({}), {
    endpoint: "http://127.0.0.1:18000",
    provider: "raon",
    model: "Raon-1-nano",
  });
});

test("accepts explicitly configured Qwen loopback model", () => {
  assert.deepEqual(
    localInferenceTarget({
      LW_NPC_INFERENCE_PROVIDER: "local",
      LW_NPC_INFERENCE_MODEL: "Qwen3.5-4B",
      LOCAL_BASE_URL: "http://127.0.0.1:18000",
    }),
    {
      endpoint: "http://127.0.0.1:18000",
      provider: "local",
      model: "Qwen3.5-4B",
    },
  );
});

test("fails closed on invalid endpoints, aliases or provider", () => {
  const invalid = [
    { LW_NPC_INFERENCE_PROVIDER: "external" },
    { LW_NPC_INFERENCE_PROVIDER: "local" },
    { RAON_BASE_URL: "http://localhost:18000" },
    { RAON_BASE_URL: "http://10.0.0.1:18000" },
    { RAON_BASE_URL: "https://127.0.0.1:18000" },
    { RAON_BASE_URL: "http://admin:secret@127.0.0.1:18000" },
    { RAON_BASE_URL: "http://127.0.0.1:18000/api" },
    { LW_NPC_INFERENCE_MODEL: "a name with spaces" },
    { LW_NPC_INFERENCE_MODEL: "../etc/passwd" },
  ];
  for (const env of invalid)
    assert.throws(() => localInferenceTarget(env), { name: "Error" });
});

test("requires the actual configured alias from /v1/models", () => {
  assert.equal(
    containsExpectedModel({ data: [{ id: "Qwen3.5-4B" }] }, "Qwen3.5-4B"),
    true,
  );
  assert.equal(
    containsExpectedModel({ data: [{ id: "Raon-1-nano" }] }, "Qwen3.5-4B"),
    false,
  );
  assert.equal(containsExpectedModel({ data: "invalid" }, "Qwen3.5-4B"), false);
});
