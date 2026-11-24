CREATE TABLE "discord_conversations" (
	"world_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"player_entity_id" uuid NOT NULL,
	"npc_id" uuid,
	"last_source_id" text NOT NULL,
	CONSTRAINT "discord_conversations_world_id_context_id_player_entity_id_pk" PRIMARY KEY("world_id","context_id","player_entity_id"),
	CONSTRAINT "discord_conversation_source" CHECK ("discord_conversations"."last_source_id" ~ '^[1-9][0-9]{16,19}$')
);
--> statement-breakpoint
ALTER TABLE "npc_scene_speech_policies" ADD COLUMN "raon_session_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_conversations" ADD CONSTRAINT "discord_conversation_context_fk" FOREIGN KEY ("world_id","context_id") REFERENCES "public"."interaction_contexts"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_conversations" ADD CONSTRAINT "discord_conversation_player_fk" FOREIGN KEY ("world_id","player_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_conversations" ADD CONSTRAINT "discord_conversation_npc_fk" FOREIGN KEY ("world_id","npc_id") REFERENCES "public"."entities"("world_id","id") ON DELETE no action ON UPDATE no action;