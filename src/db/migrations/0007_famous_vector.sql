CREATE TYPE "public"."discord_context_mapping_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."discord_context_mapping_type" AS ENUM('scene', 'npc_primary', 'direct', 'system');--> statement-breakpoint
CREATE TYPE "public"."discord_identity_mapping_type" AS ENUM('player_character', 'npc_operator', 'observer', 'other');--> statement-breakpoint
CREATE TYPE "public"."discord_identity_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "discord_context_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"npc_id" uuid,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"mapping_type" "discord_context_mapping_type" NOT NULL,
	"status" "discord_context_mapping_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"discord_user_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"mapping_type" "discord_identity_mapping_type" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" "discord_identity_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_context_mappings" ADD CONSTRAINT "discord_context_mappings_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_context_mappings" ADD CONSTRAINT "discord_context_mappings_context_id_interaction_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."interaction_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_context_mappings" ADD CONSTRAINT "discord_context_mappings_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_identities" ADD CONSTRAINT "discord_identities_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_identities" ADD CONSTRAINT "discord_identities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_context_mappings_location_idx" ON "discord_context_mappings" USING btree ("world_id","guild_id","channel_id","thread_id");--> statement-breakpoint
CREATE INDEX "discord_context_mappings_world_context_idx" ON "discord_context_mappings" USING btree ("world_id","context_id");--> statement-breakpoint
CREATE INDEX "discord_context_mappings_world_npc_idx" ON "discord_context_mappings" USING btree ("world_id","npc_id","status");--> statement-breakpoint
CREATE INDEX "discord_identities_world_user_idx" ON "discord_identities" USING btree ("world_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "discord_identities_world_user_primary_idx" ON "discord_identities" USING btree ("world_id","discord_user_id","is_primary");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_identities_duplicate_mapping_idx" ON "discord_identities" USING btree ("world_id","discord_user_id","entity_id","mapping_type");