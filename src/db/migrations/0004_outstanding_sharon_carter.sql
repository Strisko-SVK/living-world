CREATE TYPE "public"."relationship_event_type" AS ENUM('interaction', 'assistance', 'betrayal', 'insult', 'threat', 'gift', 'obligation_created', 'obligation_fulfilled', 'shared_experience', 'conflict', 'reconciliation', 'dm_adjustment', 'imported', 'other');--> statement-breakpoint
CREATE TYPE "public"."relationship_intent" AS ENUM('genuine', 'transactional', 'manipulative', 'opportunistic', 'coercive', 'protective', 'mixed');--> statement-breakpoint
CREATE TABLE "relationship_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"relationship_id" uuid NOT NULL,
	"event_type" "relationship_event_type" NOT NULL,
	"delta" jsonb NOT NULL,
	"reason_summary" text NOT NULL,
	"source_interaction_id" uuid,
	"source_memory_id" uuid,
	"source_knowledge_id" uuid,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"familiarity" integer DEFAULT 0 NOT NULL,
	"trust" integer DEFAULT 50 NOT NULL,
	"respect" integer DEFAULT 50 NOT NULL,
	"affection" integer DEFAULT 0 NOT NULL,
	"fear" integer DEFAULT 0 NOT NULL,
	"resentment" integer DEFAULT 0 NOT NULL,
	"dependence" integer DEFAULT 0 NOT NULL,
	"obligation" integer DEFAULT 0 NOT NULL,
	"intent" "relationship_intent",
	"utility" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_distinct_entities" CHECK ("relationships"."source_entity_id" <> "relationships"."target_entity_id"),
	CONSTRAINT "relationships_familiarity_range" CHECK ("relationships"."familiarity" between 0 and 100),
	CONSTRAINT "relationships_trust_range" CHECK ("relationships"."trust" between 0 and 100),
	CONSTRAINT "relationships_respect_range" CHECK ("relationships"."respect" between 0 and 100),
	CONSTRAINT "relationships_affection_range" CHECK ("relationships"."affection" between 0 and 100),
	CONSTRAINT "relationships_fear_range" CHECK ("relationships"."fear" between 0 and 100),
	CONSTRAINT "relationships_resentment_range" CHECK ("relationships"."resentment" between 0 and 100),
	CONSTRAINT "relationships_dependence_range" CHECK ("relationships"."dependence" between 0 and 100),
	CONSTRAINT "relationships_obligation_range" CHECK ("relationships"."obligation" between 0 and 100),
	CONSTRAINT "relationships_version_positive" CHECK ("relationships"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "relationship_events" ADD CONSTRAINT "relationship_events_relationship_id_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_events" ADD CONSTRAINT "relationship_events_source_memory_id_npc_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."npc_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_events" ADD CONSTRAINT "relationship_events_source_knowledge_id_npc_knowledge_id_fk" FOREIGN KEY ("source_knowledge_id") REFERENCES "public"."npc_knowledge"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relationship_events_relationship_id_idx" ON "relationship_events" USING btree ("relationship_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_world_source_target_idx" ON "relationships" USING btree ("world_id","source_entity_id","target_entity_id");