CREATE TYPE "public"."entity_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('npc', 'player_character', 'location', 'organization', 'faction', 'ship', 'group', 'population_node', 'item', 'other');--> statement-breakpoint
CREATE TYPE "public"."world_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"canonical_name" text NOT NULL,
	"status" "entity_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"system_type" text NOT NULL,
	"status" "world_status" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entities_world_id_idx" ON "entities" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "entities_world_id_canonical_name_idx" ON "entities" USING btree ("world_id","canonical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_entity_id_normalized_alias_unique" ON "entity_aliases" USING btree ("entity_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "entity_aliases_normalized_alias_idx" ON "entity_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "entity_aliases_entity_id_idx" ON "entity_aliases" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worlds_key_unique" ON "worlds" USING btree ("key");