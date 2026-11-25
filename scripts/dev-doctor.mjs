import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function localInferenceTarget(env = process.env) {
  const provider = env.LW_NPC_INFERENCE_PROVIDER ?? "raon";
  if (!["raon", "local"].includes(provider))
    throw new Error("unsupported local inference provider");
  const rawUrl =
    provider === "local"
      ? (env.LOCAL_BASE_URL ?? "http://127.0.0.1:18000")
      : (env.RAON_BASE_URL ?? "http://127.0.0.1:18000");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid local inference endpoint");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("inference endpoint must be loopback-only");
  }
  const model =
    env.LW_NPC_INFERENCE_MODEL ??
    env.LLM_MODEL ??
    (provider === "raon" ? "Raon-1-nano" : undefined);
  if (!model || !/^[a-zA-Z0-9._:-]{1,120}$/.test(model))
    throw new Error("explicit local model alias is required");
  return { endpoint: url.origin, provider, model };
}

export function containsExpectedModel(payload, model) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    Array.isArray(payload.data) &&
    payload.data.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        entry.id === model,
    )
  );
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("DEV doctor cannot run in production.");
    process.exitCode = 1;
    return;
  }
  const db = spawnSync(
    process.execPath,
    ["--env-file=.env.gateway-dev.local", "--import", "tsx", "src/admin/gateway-dev-db.ts", "check"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISCORD_ENABLED: "false",
        DISCORD_OUTBOUND_ENABLED: "false",
        LLM_PROVIDER: "disabled",
      },
      timeout: 15_000,
      stdio: "pipe",
    },
  );
  if (db.status === 0) console.info("DEV database identity: PASS");
  else {
    console.error("DEV database identity: FAIL (inspect Docker, DB role and local environment).");
    process.exitCode = 1;
  }
  let target;
  try {
    target = localInferenceTarget();
  } catch {
    console.error("Inference configuration: FAIL (loopback URL or model alias).");
    process.exitCode = 1;
    return;
  }
  try {
    const health = await fetch(target.endpoint + "/health", {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!health.ok) throw new Error("model unavailable");
    const response = await fetch(target.endpoint + "/v1/models", {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok || !containsExpectedModel(await response.json(), target.model))
      throw new Error("model alias mismatch");
    console.info("Private inference health and model alias: PASS");
  } catch {
    console.error("Private inference: FAIL (check SSH tunnel, service health and model alias).");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("DEV doctor failed without exposing environment secrets.");
    process.exitCode = 1;
  });
}
