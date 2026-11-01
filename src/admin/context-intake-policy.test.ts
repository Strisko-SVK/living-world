import { describe, expect, it, vi } from "vitest";
import {
  parseContextPolicyArguments,
  runContextPolicyCommand,
} from "./context-intake-policy.js";

const world = "00000000-0000-4000-8000-000000000001";
const context = "00000000-0000-4000-8000-000000000002";
const args = ["--world", world, "--context", context, "--policy", "disabled"];

describe("local context policy command", () => {
  it.each(["disabled", "mapped_players"])(
    "requires explicit exact IDs and %s policy",
    (policy) => {
      expect(
        parseContextPolicyArguments([...args.slice(0, 5), policy]),
      ).toEqual({ worldId: world, contextId: context, policy });
    },
  );
  it.each(
    [
      [],
      args.slice(0, 4),
      [...args, "--operator", "admin"],
      [...args.slice(0, 5), "all"],
      [...args.slice(0, 5), ""],
      ["--world", "*", ...args.slice(2)],
      [
        "--world",
        world,
        "--context",
        "bad'; update worlds set status='archived'",
        "--policy",
        "mapped_players",
      ],
      ["--context", context, "--world", world, "--policy", "disabled"],
    ].map((invalid) => [invalid]),
  )(
    "rejects invalid or claimed-operator arguments before connecting: %j",
    async (invalid) => {
      const connect = vi.fn();
      await expect(runContextPolicyCommand(invalid, connect)).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
    },
  );
});
