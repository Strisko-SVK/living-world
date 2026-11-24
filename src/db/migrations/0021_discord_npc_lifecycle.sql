CREATE TABLE "discord_campaign_members" (
	"world_id" uuid NOT NULL,
	"discord_user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "discord_campaign_members_world_id_discord_user_id_pk" PRIMARY KEY("world_id","discord_user_id"),
	CONSTRAINT "discord_member_entity_unique" UNIQUE("world_id","entity_id"),
	CONSTRAINT "discord_campaign_member_role" CHECK ("discord_campaign_members"."role" in ('admin','dm','player'))
);
--> statement-breakpoint
CREATE TABLE "discord_campaigns" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"category_id" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "discord_campaigns_world_id_unique" UNIQUE("world_id"),
	CONSTRAINT "discord_campaign_scope" UNIQUE("guild_id","world_id")
);
--> statement-breakpoint
CREATE TABLE "discord_npc_registry" (
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"home_location_id" uuid NOT NULL,
	CONSTRAINT "discord_npc_registry_world_id_npc_id_pk" PRIMARY KEY("world_id","npc_id"),
	CONSTRAINT "discord_registry_template_unique" UNIQUE("world_id","template_key")
);
--> statement-breakpoint
CREATE TABLE "discord_rp_channels" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"world_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"base_npc_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"webhook_id" text,
	CONSTRAINT "discord_rp_channels_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "discord_native_source" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "npc_scene_speech_policies" ADD COLUMN "discord_native_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_campaign_members" ADD CONSTRAINT "discord_member_world_fk" FOREIGN KEY ("world_id","entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_campaigns" ADD CONSTRAINT "discord_campaigns_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_npc_registry" ADD CONSTRAINT "discord_registry_npc_fk" FOREIGN KEY ("world_id","npc_id") REFERENCES "public"."entities"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_npc_registry" ADD CONSTRAINT "discord_registry_home_fk" FOREIGN KEY ("world_id","home_location_id") REFERENCES "public"."entities"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_rp_channels" ADD CONSTRAINT "discord_rp_campaign_fk" FOREIGN KEY ("guild_id","world_id") REFERENCES "public"."discord_campaigns"("guild_id","world_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_rp_channels" ADD CONSTRAINT "discord_rp_npc_fk" FOREIGN KEY ("world_id","base_npc_id") REFERENCES "public"."discord_npc_registry"("world_id","npc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_rp_channels" ADD CONSTRAINT "discord_rp_location_fk" FOREIGN KEY ("world_id","location_id") REFERENCES "public"."entities"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_rp_one_active_base" ON "discord_rp_channels" USING btree ("world_id","base_npc_id") WHERE "discord_rp_channels"."active" and "discord_rp_channels"."base_npc_id" is not null;