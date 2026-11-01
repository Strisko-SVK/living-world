// Discord assigns this ID to the SDK Message, independently of user content.
// https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx#snowflakes
// Decoding an arbitrary caller-provided number does not authenticate an event:
// only trusted adapter/repository inputs may supply sourceMessageId.
export function discordMessageCreatedAt(id: string | null): number | null {
  if (!id || !/^[1-9][0-9]{0,19}$/u.test(id)) return null;
  const snowflake = BigInt(id);
  if (snowflake > (1n << 64n) - 1n) return null;
  return Number((snowflake >> 22n) + 1420070400000n);
}
