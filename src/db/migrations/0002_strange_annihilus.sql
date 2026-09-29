CREATE TYPE "public"."memory_detail_level" AS ENUM('high', 'medium', 'low', 'gist');--> statement-breakpoint
CREATE TYPE "public"."memory_relation_type" AS ENUM('consolidated_from', 'summarizes', 'related_to', 'contradicts', 'supersedes');--> statement-breakpoint
CREATE TYPE "public"."memory_retention_class" AS ENUM('temporary', 'normal', 'important', 'permanent');--> statement-breakpoint
CREATE TYPE "public"."memory_source_type" AS ENUM('interaction', 'witnessed', 'heard', 'read', 'official', 'inferred', 'archive', 'dm', 'system', 'imported');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'consolidated', 'archived', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('episodic', 'social', 'emotional', 'traumatic', 'achievement', 'failure', 'relationship', 'world_event', 'routine');--> statement-breakpoint
CREATE TABLE "memory_relations" (
	"parent_memory_id" uuid NOT NULL,
	"child_memory_id" uuid NOT NULL,
	"relation_type" "memory_relation_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_relations_parent_memory_id_child_memory_id_relation_type_pk" PRIMARY KEY("parent_memory_id","child_memory_id","relation_type"),
	CONSTRAINT "memory_relations_no_self_relation" CHECK ("memory_relations"."parent_memory_id" <> "memory_relations"."child_memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_type" "memory_source_type" NOT NULL,
	"source_id" text,
	"source_entity_id" uuid,
	"source_interaction_id" uuid,
	"provenance_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npc_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"memory_type" "memory_type" NOT NULL,
	"summary" text NOT NULL,
	"importance" integer NOT NULL,
	"detail_level" "memory_detail_level" NOT NULL,
	"retention_class" "memory_retention_class" NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"emotional_tags" text[] DEFAULT '{}' NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_memories_importance_range" CHECK ("npc_memories"."importance" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_parent_memory_id_npc_memories_id_fk" FOREIGN KEY ("parent_memory_id") REFERENCES "public"."npc_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_child_memory_id_npc_memories_id_fk" FOREIGN KEY ("child_memory_id") REFERENCES "public"."npc_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_memory_id_npc_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."npc_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_memories" ADD CONSTRAINT "npc_memories_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_memories" ADD CONSTRAINT "npc_memories_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_sources_memory_id_idx" ON "memory_sources" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "npc_memories_world_npc_idx" ON "npc_memories" USING btree ("world_id","npc_id");--> statement-breakpoint
CREATE INDEX "npc_memories_world_npc_status_idx" ON "npc_memories" USING btree ("world_id","npc_id","status");