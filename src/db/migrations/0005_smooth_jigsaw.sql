CREATE TYPE "public"."communication_mode" AS ENUM('local', 'remote', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."interaction_context_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."interaction_context_type" AS ENUM('direct', 'scene', 'npc_primary', 'group', 'system');--> statement-breakpoint
CREATE TYPE "public"."interaction_status" AS ENUM('received', 'processing', 'responded', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."interaction_type" AS ENUM('direct_question', 'social', 'immediate_action_request', 'deferred_task_request', 'system');--> statement-breakpoint
CREATE TABLE "interaction_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"context_type" "interaction_context_type" NOT NULL,
	"external_provider" text,
	"external_guild_id" text,
	"external_channel_id" text,
	"external_thread_id" text,
	"linked_location_entity_id" uuid,
	"status" "interaction_context_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"speaker_entity_id" uuid,
	"interaction_type" "interaction_type" NOT NULL,
	"intent_type" "interaction_type",
	"communication_mode" "communication_mode" NOT NULL,
	"request_text" text NOT NULL,
	"response_text" text,
	"status" "interaction_status" DEFAULT 'received' NOT NULL,
	"source_message_id" text,
	"response_message_id" text,
	"trace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "interaction_contexts" ADD CONSTRAINT "interaction_contexts_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_contexts" ADD CONSTRAINT "interaction_contexts_linked_location_entity_id_entities_id_fk" FOREIGN KEY ("linked_location_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_context_id_interaction_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."interaction_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_speaker_entity_id_entities_id_fk" FOREIGN KEY ("speaker_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_contexts_world_id_idx" ON "interaction_contexts" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "interaction_contexts_external_ref_idx" ON "interaction_contexts" USING btree ("world_id","external_provider","external_channel_id","external_thread_id");--> statement-breakpoint
CREATE INDEX "interactions_world_npc_idx" ON "interactions" USING btree ("world_id","npc_id");--> statement-breakpoint
CREATE INDEX "interactions_world_npc_status_idx" ON "interactions" USING btree ("world_id","npc_id","status");--> statement-breakpoint
CREATE INDEX "interactions_trace_id_idx" ON "interactions" USING btree ("trace_id");