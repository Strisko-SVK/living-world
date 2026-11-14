import {describe,expect,it,vi} from "vitest";
import {
  parseFirstReplyInboundArguments,
  validateFirstReplyInboundEnvironment,
  runFirstReplyInboundCommand,
} from "./dev-first-reply-inbound.js";

const route={
  guildId:"1777777777777777701",
  channelId:"1777777777777777702",
  threadId:"1777777777777777703",
};
const secret="a".repeat(64);
const env:NodeJS.ProcessEnv={
  LW_GATEWAY_DEV_ADMIN_PASSWORD:"b".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD:secret,
  DATABASE_URL:"postgresql://lw_gateway_dev:"+secret+
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED:"false",
  DISCORD_OUTBOUND_ENABLED:"false",
  LLM_PROVIDER:"disabled",
  DISCORD_TOKEN:"synthetic_no_real_token_123456789",
  LW_DEV_BOT_USER_ID:"1566909036899868712",
  LW_DEV_GUILD_ID:route.guildId,
  LW_DEV_PARENT_CHANNEL_ID:"1777777777777777711",
  LW_DEV_THREAD_ID:"1777777777777777712",
  LW_PILOT_PARENT_CHANNEL_ID:"1777777777777777713",
  LW_PILOT_THREAD_ID:"1777777777777777714",
  LW_NPC_E2E_PARENT_CHANNEL_ID:"1777777777777777715",
  LW_NPC_E2E_THREAD_ID:"1777777777777777716",
  LW_FIRST_REPLY_WORLD_KEY:"lw-dev-first-reply-001",
  LW_FIRST_REPLY_GUILD_ID:route.guildId,
  LW_FIRST_REPLY_PARENT_ID:route.channelId,
  LW_FIRST_REPLY_THREAD_ID:route.threadId,
  LW_FIRST_REPLY_PLAYER_ID:"1777777777777777755",
};
const flags=[
  "--connect","--confirm-world","lw-dev-first-reply-001",
  "--confirm-guild",route.guildId,"--confirm-parent",route.channelId,
  "--confirm-thread",route.threadId,
  "--confirm-database","living_world_gateway_dev",
  "--inbound-only","--one-message",
];

describe("M2.15O new one-shot SDK inbound",()=>{
  it("is read-only by default and requires exact new route flags",()=>{
    expect(parseFirstReplyInboundArguments([],route)).toBe("preflight");
    expect(parseFirstReplyInboundArguments(["--preflight"],route)).toBe("preflight");
    expect(parseFirstReplyInboundArguments(flags,route)).toBe("connect");
    expect(parseFirstReplyInboundArguments(
      [...flags,"--confirm-message-content-intent"],route,
    )).toBe("connect_content");
    for(const bad of [
      ["--connect"], ["--send"], ["--apply"], ["--disable"],
      flags.slice(0,-1), [...flags,"--send"], 
      flags.map(v=>v===route.threadId?"1777777777777777790":v),
      flags.map(v=>v==="lw-dev-first-reply-001"?"lw-dev-npc-e2e-001":v),
    ]) expect(()=>parseFirstReplyInboundArguments(bad,route)).toThrow();
  });

  it("requires separate live Gateway and privileged content approval",()=>{
    expect(validateFirstReplyInboundEnvironment(env,"preflight").route).toEqual(route);
    expect(()=>validateFirstReplyInboundEnvironment(env,"connect")).toThrow();
    expect(validateFirstReplyInboundEnvironment(
      {...env,LW_FIRST_REPLY_GATEWAY_APPROVED:"true"},"connect",
    ).route).toEqual(route);
    expect(()=>validateFirstReplyInboundEnvironment({
      ...env,LW_FIRST_REPLY_GATEWAY_APPROVED:"true",
    },"connect_content")).toThrow();
    expect(validateFirstReplyInboundEnvironment({
      ...env,LW_FIRST_REPLY_GATEWAY_APPROVED:"true",
      LW_FIRST_REPLY_PRIVILEGED_CONTENT_APPROVED:"true",
    },"connect_content").route).toEqual(route);
  });

  it("rejects wrong human, guild, credentials, and runtime before connection",async()=>{
    const connect=vi.fn();
    for(const bad of [
      {LW_FIRST_REPLY_PLAYER_ID:"bad"},
      {LW_FIRST_REPLY_PLAYER_ID:"1566909036899868712"},
      {LW_FIRST_REPLY_PARENT_ID:env.LW_NPC_E2E_PARENT_CHANNEL_ID},
      {LW_FIRST_REPLY_GUILD_ID:"1777777777777777790"},
      {DISCORD_ENABLED:"true"},
      {LLM_PROVIDER:"openai"},
      {DATABASE_URL:env.DATABASE_URL?.replace("55432","5432")},
      {DISCORD_TOKEN:undefined},
    ]) await expect(runFirstReplyInboundCommand(
      ["--preflight"],{...env,...bad},connect as never,
    )).rejects.toThrow();
    await expect(runFirstReplyInboundCommand(
      ["--send"],env,connect as never,
    )).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
