import { describe, expect, it } from "vitest";
import { discordMessageCreatedAt } from "./discord-snowflake.js";

describe("Discord source message creation evidence", () => {
  it("decodes the official example with exact integer arithmetic", () => {
    expect(discordMessageCreatedAt("175928847299117063")).toBe(1462015105796);
  });
  it("uses only the timestamp bits", () => {
    const timestamp = 1793534400123n;
    const id = (timestamp - 1420070400000n) << 22n;
    expect(discordMessageCreatedAt(String(id))).toBe(Number(timestamp));
    expect(discordMessageCreatedAt(String(id + (1n << 22n) - 1n))).toBe(
      Number(timestamp),
    );
  });
  it.each([
    null,
    "",
    " 175928847299117063",
    "0175928847299117063",
    "1.5",
    "-1",
    "+1",
    "1e18",
    "18446744073709551616",
    "999999999999999999999",
    "forged-time",
  ])("fails closed for invalid IDs: %s", (id) => {
    expect(discordMessageCreatedAt(id)).toBeNull();
  });
});
