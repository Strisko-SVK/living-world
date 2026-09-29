CREATE TYPE "public"."capability_level" AS ENUM('untrained', 'basic', 'competent', 'experienced', 'expert');--> statement-breakpoint
CREATE TYPE "public"."capability_source" AS ENUM('profile', 'game_system', 'background', 'manual', 'derived');--> statement-breakpoint
CREATE TYPE "public"."location_certainty" AS ENUM('certain', 'probable', 'uncertain', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."npc_lifecycle_state" AS ENUM('active', 'dormant', 'travelling', 'missing', 'archived', 'dead');--> statement-breakpoint
CREATE TABLE "npc_capabilities" (
	"npc_id" uuid NOT NULL,
	"capability_key" text NOT NULL,
	"level" "capability_level" NOT NULL,
	"source" "capability_source" NOT NULL,
	"confidence" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_capabilities_npc_id_capability_key_pk" PRIMARY KEY("npc_id","capability_key"),
	CONSTRAINT "npc_capabilities_confidence_range" CHECK ("npc_capabilities"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "npc_game_profiles" (
	"npc_id" uuid PRIMARY KEY NOT NULL,
	"game_system" text NOT NULL,
	"stat_depth" integer NOT NULL,
	"characteristics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"talents" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"combat" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gear" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"derived_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_game_profiles_stat_depth_range" CHECK ("npc_game_profiles"."stat_depth" between 0 and 3),
	CONSTRAINT "npc_game_profiles_version_positive" CHECK ("npc_game_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "npc_state" (
	"npc_id" uuid PRIMARY KEY NOT NULL,
	"current_location_id" uuid,
	"location_certainty" "location_certainty" NOT NULL,
	"physical_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emotional_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"material_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"availability_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_state_version_positive" CHECK ("npc_state"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "npcs" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"simulation_depth" integer NOT NULL,
	"narrative_weight" integer NOT NULL,
	"lifecycle_state" "npc_lifecycle_state" NOT NULL,
	"canon_protected" boolean DEFAULT false NOT NULL,
	"template_version" integer NOT NULL,
	"profile_version" integer NOT NULL,
	"baseline_profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npcs_simulation_depth_range" CHECK ("npcs"."simulation_depth" between 0 and 3),
	CONSTRAINT "npcs_narrative_weight_range" CHECK ("npcs"."narrative_weight" between 0 and 100),
	CONSTRAINT "npcs_template_version_positive" CHECK ("npcs"."template_version" > 0),
	CONSTRAINT "npcs_profile_version_positive" CHECK ("npcs"."profile_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "npc_capabilities" ADD CONSTRAINT "npc_capabilities_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_game_profiles" ADD CONSTRAINT "npc_game_profiles_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_state" ADD CONSTRAINT "npc_state_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npcs" ADD CONSTRAINT "npcs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;