import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  renderGatewayDevConfig,
  writeGatewayDevConfig,
  validateGatewayDevDatabaseEnv,
  verifyGatewayDevDatabase,
} from "./gateway-dev-db.js";

const adminPassword = "a".repeat(64);
const rolePassword = "b".repeat(64);
const valid = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: adminPassword,
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL: `postgresql://lw_gateway_dev:${rolePassword@127.0.0.1:55432/living_world_gateway_dev`,
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
};

describe("isolated DEV database setup safety", () => {
  it("generates private credentials but no Discord IDs or enabled clients", () => {
    const config = renderGatewayDevConfig(adminPassword, rolePassword);
    expect(config).toContain("DATABASE_URL=postgresql://lw_gateway_dev:");
    expect(config).toContain("@127.0.0.1:55432/living_world_gateway_dev");
    expect(config).toContain("LW_DEV_GUILD_ID=\n");
    expect(config).toContain("DISCORD_ENABLED=false");
    expect(config).toContain("DISCORD_OUTBOUND_ENABLED=false");
    expect(config).toContain("LLM_PROVIDER=disabled");
    expect(() => renderGatewayDevConfig("weak", rolePassword)).toThrow();
  });

  it("creates a mode-0600 file and refuses to overwrite credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-gateway-dev-"));
    const path = join(dir, ".env.gateway-dev.local");
    try {
      await writeGatewayDevConfig(path, () => Buffer.alloc(32, 0xab));
      const config = await readFile(path, "utf8");
      expect(config).toContain("DATABASE_URL=postgresql://lw_gateway_dev:");
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      await expect(writeGatewayDevConfig(path)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires exactly the expected loopback endpoint and disabled modes", () => {
    expect(() => validateGatewayDevDatabaseEnv(valid)).not.toThrow();
    for (const override of [
      { DATABASE_URL: valid.DATABASE_URL.replace("127.0.0.1", "remote.example.com") },
      { DATABASE_URL: valid.DATABASE_URL.replace("55432", "5432") },
      { DATABASE_URL: valid.DATABASE_URL.replace("living_world_gateway_dev", "living_world") },
      { DATABASE_URL: valid.DATABASE_URL.replace("lw_gateway_dev", "postgres") },
      { DATABASE_URL: valid.DATABASE_URL.replace(rolePassword, "different") },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
    ]) {
      expect(() => validateGatewayDevDatabaseEnv({ ...valid, ...override })).toThrow();
    }
  });

  it("rejects privileged database roles before migrations", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      rows: [{
        database: "living_world_gateway_dev",
        db_role: "lw_gateway_dev",
        db_owner: "lw_gateway_dev",
        version: 170008,
        superuser: false,
        createdb: true,
        createrole: false,
      }],
    });
    const transaction = vi.fn().mockImplementation(
      async (callback: (tx: { execute: typeof execute }) => Promise<void>) =>
        callback({ execute }),
    );
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      verifyGatewayDevDatabase(
        valid,
        connect as unknown as Parameters<typeof verifyGatewayDevDatabase>[1],
      ),
    ).rejects.toThrow("not approved");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
