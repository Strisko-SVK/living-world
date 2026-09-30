CREATE TYPE "public"."task_report_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."task_report_type" AS ENUM('progress', 'blocked', 'completion', 'failure', 'cancellation', 'other');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('proposed', 'accepted', 'active', 'blocked', 'completed', 'failed', 'abandoned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_urgency" AS ENUM('low', 'normal', 'high', 'critical');--> statement-breakpoint
CREATE TABLE "task_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"recipient_entity_id" uuid,
	"context_id" uuid,
	"report_type" "task_report_type" NOT NULL,
	"report_text" text NOT NULL,
	"delivery_status" "task_report_delivery_status" DEFAULT 'pending' NOT NULL,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"assignee_entity_id" uuid NOT NULL,
	"requester_entity_id" uuid,
	"origin_interaction_id" uuid,
	"origin_context_id" uuid,
	"objective" text NOT NULL,
	"status" "task_status" DEFAULT 'proposed' NOT NULL,
	"urgency" "task_urgency" DEFAULT 'normal' NOT NULL,
	"temporal_requirement" text,
	"blocked_reason" text,
	"result_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_recipient_entity_id_entities_id_fk" FOREIGN KEY ("recipient_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_context_id_interaction_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."interaction_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_entity_id_entities_id_fk" FOREIGN KEY ("assignee_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requester_entity_id_entities_id_fk" FOREIGN KEY ("requester_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_origin_interaction_id_interactions_id_fk" FOREIGN KEY ("origin_interaction_id") REFERENCES "public"."interactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_origin_context_id_interaction_contexts_id_fk" FOREIGN KEY ("origin_context_id") REFERENCES "public"."interaction_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_reports_task_id_idx" ON "task_reports" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_world_assignee_idx" ON "tasks" USING btree ("world_id","assignee_entity_id");--> statement-breakpoint
CREATE INDEX "tasks_world_requester_idx" ON "tasks" USING btree ("world_id","requester_entity_id");--> statement-breakpoint
CREATE INDEX "tasks_world_status_idx" ON "tasks" USING btree ("world_id","status");