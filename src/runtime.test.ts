import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  check: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  database: vi.fn(),
  adapter: vi.fn(),
}));
vi.mock("./db/client.js", () => ({
  createDatabaseClient: mocks.database,
  checkDatabaseConnection: mocks.check,
}));
vi.mock("./adapters/discord/client.js", () => ({
  createDiscordAdapter: (...args: unknown[]) => {
    mocks.adapter(...args);
    return { start: mocks.start, stop: mocks.stop };
  },
}));
import { startApplication } from "./runtime.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.database.mockReturnValue({ db: {}, close: mocks.close });
  mocks.check.mockResolvedValue(true);
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
});
describe("application lifecycle", () => {
  it("does not create database or Discord connections when disabled", async () => {
    const runtime = await startApplication({}, vi.fn());
    await runtime.stop();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("validates configuration before creating resources", async () => {
    await expect(
      startApplication({ DISCORD_ENABLED: "true" }, vi.fn()),
    ).rejects.toThrow("DISCORD_TOKEN");
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("wires strict intake instead of the legacy primary/operator fallback", async () => {
    const runtime = await startApplication(
      { DISCORD_ENABLED: "true", DISCORD_TOKEN: "synthetic" },
      vi.fn(),
    );
    try {
      const [config, intake] = mocks.adapter.mock.calls[0];
      expect(config).not.toHaveProperty("intakeAllowlist");
      expect(
        await intake(
          {
            sourceMessageId: "id",
            authorId: "author",
            guildId: "guild",
            channelId: "channel",
            threadId: null,
            mentionedUserIds: [],
            content: "Hello",
          },
          "123",
        ),
      ).toBe("invalid_trigger");
    } finally {
      await runtime.stop();
    }
  });
  it("starts after database health check and shuts down once with signal cleanup", async () => {
    const before = process.listenerCount("SIGTERM");
    const runtime = await startApplication(
      { DISCORD_ENABLED: "true", DISCORD_TOKEN: "test-token" },
      vi.fn(),
    );
    expect(mocks.check.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0],
    );
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0],
    );
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
  it.each(["check", "start"] as const)(
    "cleans up after %s failure without leaking credentials",
    async (failing) => {
      mocks[failing].mockRejectedValue(new Error("secret-token"));
      await expect(
        startApplication(
          { DISCORD_ENABLED: "true", DISCORD_TOKEN: "test-token" },
          vi.fn(),
        ),
      ).rejects.toThrow("Application startup failed.");
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );
});
