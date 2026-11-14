import { describe, expect, it, vi } from "vitest";
import { postFirstReplyOnce } from "./dev-first-reply-transport.js";

const target = {
  guildId:"1777777777777777701",
  parentId:"1777777777777777702",
  threadId:"1777777777777777703",
  sourceMessageId:"1888888888888888999",
  playerId:"1888888888888888005",
  botId:"1566909036899868712",
  attemptId:"04c94057-30dc-463e-b996-bb9178714316",
};
const nonce = target.attemptId.replaceAll("-","").slice(0,24);
const token = "fake_credential_only_not_a_real_token";
const allBits = String((1n<<10n)|(1n<<16n)|(1n<<38n));

function response(data: unknown, status=200) {
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json"},
  });
}
function fakeHttp(options: {
  perms?: string;
  badParent?: boolean;
  sourceText?: string;
  postStatus?: number;
  badAck?: boolean;
  thrownPost?: boolean;
} = {}) {
  const calls: Array<{url:string;method:string;body?:string}> = [];
  const http = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const method = String(init.method);
    calls.push({url,method, ...(init.body?{body:String(init.body)}:{})});
    if (method === "POST") {
      if (options.thrownPost) throw Error("sensitive transport error");
      if (options.postStatus)
        return response({message:"private error"}, options.postStatus);
      return response({
        id:"1888888888888888666",
        guild_id:target.guildId,
        channel_id:target.threadId,
        content:"Acknowledged. Standing by.",
        author:{id:options.badAck?"1888888888888888008":target.botId},
        nonce,
        message_reference:{message_id:target.sourceMessageId},
      });
    }
    if (url.endsWith("/users/@me"))
      return response({id:target.botId});
    if (url.endsWith("/channels/"+target.parentId))
      return response({
        id:target.parentId,
        guild_id: options.badParent ? "1777777777777777755" : target.guildId,
        type:0,
      });
    if (url.endsWith("/channels/"+target.threadId))
      return response({
        id:target.threadId,guild_id:target.guildId,parent_id:target.parentId,
        type:11,thread_metadata:{archived:false,locked:false},
      });
    if (url.includes("/permissions/member/"))
      return response({permissions:options.perms??allBits});
    if (url.endsWith("/messages/"+target.sourceMessageId))
      return response({
        id:target.sourceMessageId,
        guild_id:target.guildId,
        channel_id:target.threadId,
        content:options.sourceText ?? "<@"+target.botId+"> [Sentinel] Report readiness.",
        author:{id:target.playerId},
        mentions:[{id:target.botId}],
        type:0,
      });
    throw Error("Unexpected endpoint");
  });
  return {http,calls};
}

describe("M2.15O no-retry Discord bot HTTP send boundary", () => {
  it("does not POST in preclaim read-only ACL/source dry-run", async () => {
    const fake = fakeHttp();
    const fence = vi.fn().mockResolvedValue(true);
    const result = await postFirstReplyOnce(target, {
      ...fake,token,dryRun:true,revalidateAtBoundary:fence,
    });
    expect(result).toMatchObject({
      status:"prechecked",attempts:0,canRetry:false,
    });
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls.filter(x=>x.method==="POST")).toHaveLength(0);
    expect(fence).toHaveBeenCalledOnce();
  });

  it("posts EXACT fixed text once with no mentions and source reference", async () => {
    const fake = fakeHttp();
    const result = await postFirstReplyOnce(target, {
      http:fake.http,token,revalidateAtBoundary:async()=>true,
    });
    expect(result).toMatchObject({
      status:"acknowledged",attempts:1,canRetry:false,
      messageId:"1888888888888888666",
    });
    const post = fake.calls.filter(x=>x.method==="POST");
    expect(post).toHaveLength(1);
    expect(post[0]?.url).toBe(
      "https://discord.com/api/v10/channels/"+target.threadId+"/messages",
    );
    const body = JSON.parse(post[0]!.body!);
    expect(body).toEqual({
      content:"Acknowledged. Standing by.",
      nonce,
      enforce_nonce:true,
      allowed_mentions:{parse:[],users:[],roles:[],replied_user:false},
      message_reference:{
        type:0,message_id:target.sourceMessageId,
        channel_id:target.threadId,guild_id:target.guildId,
        fail_if_not_exists:true,
      },
    });
  });

  it.each([
    ["missing thread permission", {perms:String((1n<<10n)|(1n<<16n))}],
    ["wrong parent guild", {badParent:true}],
    ["mismatched source message", {sourceText:"wrong message"}],
  ])("fails closed before POST on %s", async (_label, bad) => {
    const fake = fakeHttp(bad);
    const fence = vi.fn().mockResolvedValue(true);
    const result = await postFirstReplyOnce(target, {
      http:fake.http,token,revalidateAtBoundary:fence,
    });
    expect(result).toMatchObject({status:"blocked",attempts:0,canRetry:false});
    expect(fake.calls.filter(x=>x.method==="POST")).toHaveLength(0);
    expect(fence).not.toHaveBeenCalled();
  });

  it("refuses POST when action-time DB fence is revoked", async () => {
    const fake = fakeHttp();
    const result = await postFirstReplyOnce(target, {
      http:fake.http,token,revalidateAtBoundary:async()=>false,
    });
    expect(result).toMatchObject({status:"blocked",attempts:0});
    expect(fake.calls.filter(x=>x.method==="POST")).toHaveLength(0);
  });

  it.each([
    ["429 terminal", {postStatus:429}],
    ["5xx terminal", {postStatus:502}],
    ["lost ACK", {thrownPost:true}],
    ["incorrect ACK author", {badAck:true}],
  ])("%s is never retried", async (_label, bad) => {
    const fake = fakeHttp(bad);
    const result = await postFirstReplyOnce(target,{
      http:fake.http,token,revalidateAtBoundary:async()=>true,
    });
    expect(result).toMatchObject({status:"uncertain",attempts:1,canRetry:false});
    expect(fake.calls.filter(x=>x.method==="POST")).toHaveLength(1);
  });

  it("does not call any network without a valid exact target", async () => {
    const fake = fakeHttp();
    const fence = vi.fn();
    const result = await postFirstReplyOnce({...target, threadId:"bad"},{
      http:fake.http,token,revalidateAtBoundary:fence,
    });
    expect(result.status).toBe("blocked");
    expect(fake.calls).toHaveLength(0);
  });
});
