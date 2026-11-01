CREATE TYPE "public"."npc_intake_policy" AS ENUM('disabled', 'mapped_players');--> statement-breakpoint
CREATE TABLE "context_intake_policy_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"previous_policy" "npc_intake_policy" NOT NULL,
	"target_policy" "npc_intake_policy" NOT NULL,
	"database_role" text DEFAULT current_user NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interaction_contexts" ADD COLUMN "npc_intake_policy" "npc_intake_policy" DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_intake_policy_audit" ADD CONSTRAINT "context_intake_policy_audit_context_world_fk" FOREIGN KEY ("world_id","context_id") REFERENCES "public"."interaction_contexts"("world_id","id") ON DELETE restrict ON UPDATE no action;