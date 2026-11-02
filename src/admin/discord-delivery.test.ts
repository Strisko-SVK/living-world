import { describe, expect, it, vi } from "vitest";
import {
  parseDeliveryArguments,
  runDeliveryCommand,
} from "./discord-delivery.js";
const args = [
  "--world",
  "00000000-0000-4000-8000-000000000001",
  "--npc",
  "00000000-0000-4000-8000-000000000002",
  "--interaction",
  "00000000-0000-4000-8000-000000000003",
  "--guild",
  "323456789012345678",
  "--channel",
  "423456789012345678",
  "--thread",
  "523456789012345678",
];
describe("trusted operator entry point", () => {
  it("defaults to dry-run and requires a separate exact execute flag", () => {
    expect(parseDeliveryArguments(args).execute).toBe(false);
    expect(parseDeliveryArguments([...args, "--dry-run"]).execute).toBe(false);
    expect(parseDeliveryArguments([...args, "--execute"]).execute).toBe(true);
  });
  it("accepts an explicit parent-only target without inventing a thread", () => {
    const input = [...args];
    input[11] = "none";
    expect(parseDeliveryArguments(input).target.threadId).toBeNull();
  });
  it.each(
    [
      args.slice(0, 10),
      [...args, "--execute", "--dry-run"],
      [...args, "--operator-admin"],
      [...args.slice(0, 10), "--thread", "*"],
      [
        ...args.slice(0, 8),
        "--channel",
        "https://evil.invalid",
        ...args.slice(10),
      ],
    ].map((input) => [input] as [string[]]),
  )("rejects invalid/broad/claimed-authority arguments %#", (input) =>
    expect(() => parseDeliveryArguments(input)).toThrow("blocked"),
  );
  it.each(
    [[], args, [...args, "--execute"]].map((input) => [input] as [string[]]),
  )("blocks absent enablement before DB/HTTP %#", async (input) => {
    const connect = vi.fn(() => {
      throw Error("Should not connect");
    });
    const http = vi.fn();
    const result = await runDeliveryCommand(input, {}, { connect, http });
    expect(result.status).toBe("blocked");
    expect(connect).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(args[1]);
  });
  it("does not echo hostile credential/URL values in configuration errors", async () => {
    const secret = "secret_should_not_appear_in_diagnostics";
    const result = await runDeliveryCommand([...args, "--execute"], {
      DISCORD_OUTBOUND_ENABLED: "true",
      DISCORD_OUTBOUND_ALLOWLIST: secret,
      DISCORD_OUTBOUND_CREDENTIALS: secret,
    });
    expect(result.reason).toBe("invalid_configuration");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
