import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateCiUrl } from "./ci-db.mjs";
const env = {
  NODE_ENV: "test", DISCORD_ENABLED: "false", DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  DATABASE_URL: "postgresql://lw_gateway_ci:" + "a".repeat(64) + "@127.0.0.1:55432/living_world_ci",
};
describe("CI database fail-closed preflight", () => {
  it("accepts only isolated loopback CI role/database", () => assert.doesNotThrow(() => validateCiUrl(env)));
  for (const bad of [
    { DATABASE_URL:env.DATABASE_URL.replace("living_world_ci","living_world_gateway_dev") },
    { DATABASE_URL:env.DATABASE_URL.replace("lw_gateway_ci","lw_gateway_dev") },
    { DATABASE_URL:env.DATABASE_URL.replace("127.0.0.1","localhost") },
    { DISCORD_ENABLED:"true" }, { NODE_ENV:"production" }, { LLM_PROVIDER:"local" }
  ]) it("rejects unsafe target and runtime config", () => assert.throws(() => validateCiUrl({...env,...bad})));
});
