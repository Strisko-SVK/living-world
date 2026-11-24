import { expect, it } from "vitest";
import { parseMentionCommand } from "./runtime.js";
import type { IncomingMessage } from "../intake/discord-intake.js";

const botId = "1700000000000000010";
const event: IncomingMessage = {
  authorId: "1700000000000000011",
  channelId: "1700000000000000012",
  guildId: "1700000000000000013",
  sourceMessageId: "1700000000000000014",
  threadId: null,
  content: "",
  mentionedUserIds: [botId],
};

it("authenticates literal command mentions and selects only complete deterministic operations", () => {
  const parse = (content: string, mentioned = true) =>
    parseMentionCommand(
      { ...event, content, mentionedUserIds: mentioned ? [botId] : [] },
      botId,
    );
  expect(parse("<@" + botId + "> [Quartermaster] {enable}")).toEqual({
    action: "enable",
    alias: "quartermaster",
  });
  expect(parse("<@!" + botId + "> {register-here}")).toEqual({
    action: "register-here",
  });
  expect(parse("<@" + botId + "> [Quartermaster] {enable} extra")).toEqual({
    action: "invalid",
  });
  expect(parse("<@" + botId + "> [Quartermaster] {enable}", false)).toBeNull();
  expect(
    parse("<@" + event.authorId + "> [Quartermaster] {enable}"),
  ).toBeNull();
  expect(
    parse("<@" + botId + "> [Quartermaster] What does enable do?"),
  ).toBeNull();
});
