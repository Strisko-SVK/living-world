CREATE TYPE "public"."knowledge_classification" AS ENUM('fact', 'reported_claim', 'rumor', 'inference', 'assumption', 'misinformation');--> statement-breakpoint
CREATE TYPE "public"."knowledge_conflict_status" AS ENUM('unresolved', 'reviewed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."knowledge_secrecy" AS ENUM('public', 'private', 'restricted', 'secret');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('witnessed', 'heard', 'read', 'official', 'inferred', 'rumor_chain', 'memory', 'archive', 'dm', 'system', 'imported');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('current', 'outdated', 'disputed', 'invalidated');--> statement-breakpoint
CREATE TABLE "knowledge_conflicts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"claim_a_id" uuid NOT NULL,
	"claim_b_id" uuid NOT NULL,
	"status" "knowledge_conflict_status" DEFAULT 'unresolved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	CONSTRAINT "knowledge_conflicts_distinct_claims" CHECK ("knowledge_conflicts"."claim_a_id" <> "knowledge_conflicts"."claim_b_id"),
	CONSTRAINT "knowledge_conflicts_canonical_pair" CHECK ("knowledge_conflicts"."claim_a_id" < "knowledge_conflicts"."claim_b_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"source_type" "knowledge_source_type" NOT NULL,
	"source_entity_id" uuid,
	"source_knowledge_id" uuid,
	"source_memory_id" uuid,
	"external_ref" text,
	"chain_depth" integer,
	"provenance_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_chain_depth_nonnegative" CHECK ("knowledge_sources"."chain_depth" >= 0)
);
--> statement-breakpoint
CREATE TABLE "npc_knowledge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"subject_entity_id" uuid,
	"predicate" text,
	"object_entity_id" uuid,
	"object_value" jsonb,
	"claim_text" text NOT NULL,
	"classification" "knowledge_classification" NOT NULL,
	"confidence" real NOT NULL,
	"secrecy" "knowledge_secrecy" NOT NULL,
	"status" "knowledge_status" DEFAULT 'current' NOT NULL,
	"acquired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_knowledge_confidence_range" CHECK ("npc_knowledge"."confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_claim_a_id_npc_knowledge_id_fk" FOREIGN KEY ("claim_a_id") REFERENCES "public"."npc_knowledge"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_claim_b_id_npc_knowledge_id_fk" FOREIGN KEY ("claim_b_id") REFERENCES "public"."npc_knowledge"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_knowledge_id_npc_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."npc_knowledge"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_source_knowledge_id_npc_knowledge_id_fk" FOREIGN KEY ("source_knowledge_id") REFERENCES "public"."npc_knowledge"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_source_memory_id_npc_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."npc_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_knowledge" ADD CONSTRAINT "npc_knowledge_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_knowledge" ADD CONSTRAINT "npc_knowledge_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_knowledge" ADD CONSTRAINT "npc_knowledge_subject_entity_id_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_knowledge" ADD CONSTRAINT "npc_knowledge_object_entity_id_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_conflicts_world_npc_idx" ON "knowledge_conflicts" USING btree ("world_id","npc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_conflicts_unique_pair_idx" ON "knowledge_conflicts" USING btree ("claim_a_id","claim_b_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_knowledge_id_idx" ON "knowledge_sources" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "npc_knowledge_world_npc_idx" ON "npc_knowledge" USING btree ("world_id","npc_id");--> statement-breakpoint
CREATE INDEX "npc_knowledge_world_npc_status_idx" ON "npc_knowledge" USING btree ("world_id","npc_id","status");