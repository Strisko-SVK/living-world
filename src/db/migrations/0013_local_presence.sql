CREATE TABLE "local_presence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"state_version" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"issued_by" text DEFAULT current_user NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "local_presence_binding_unique" UNIQUE("world_id","npc_id","context_id","id"),
	CONSTRAINT "local_presence_revocation_shape" CHECK (("local_presence"."revoked_at" is null) = ("local_presence"."revoked_by" is null)),
	CONSTRAINT "local_presence_state_version" CHECK ("local_presence"."state_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "local_presence_id" uuid;--> statement-breakpoint
ALTER TABLE "local_presence" ADD CONSTRAINT "local_presence_npc_id_npcs_entity_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_presence" ADD CONSTRAINT "local_presence_npc_world_fk" FOREIGN KEY ("world_id","npc_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_presence" ADD CONSTRAINT "local_presence_context_world_fk" FOREIGN KEY ("world_id","context_id") REFERENCES "public"."interaction_contexts"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_presence" ADD CONSTRAINT "local_presence_location_world_fk" FOREIGN KEY ("world_id","location_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_presence_active_unique" ON "local_presence" USING btree ("world_id","npc_id","context_id") WHERE "local_presence"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_local_presence_fk" FOREIGN KEY ("world_id","npc_id","context_id","local_presence_id") REFERENCES "public"."local_presence"("world_id","npc_id","context_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_local_presence_mode" CHECK ("interactions"."local_presence_id" is null or "interactions"."communication_mode" = 'local');--> statement-breakpoint
CREATE FUNCTION guard_local_presence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by')
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS DISTINCT FROM current_user::text THEN
    RAISE EXCEPTION 'Presence evidence is immutable except for one operator revocation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER local_presence_immutable BEFORE UPDATE ON local_presence FOR EACH ROW EXECUTE FUNCTION guard_local_presence();
--> statement-breakpoint
CREATE FUNCTION guard_interaction_presence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.local_presence_id IS NOT NULL AND
    (NEW.local_presence_id IS DISTINCT FROM OLD.local_presence_id OR
     ROW(NEW.world_id,NEW.npc_id,NEW.context_id,NEW.speaker_entity_id,NEW.request_text,NEW.trace_id,NEW.created_at,NEW.source_provider,NEW.source_message_id,NEW.communication_mode)
     IS DISTINCT FROM ROW(OLD.world_id,OLD.npc_id,OLD.context_id,OLD.speaker_entity_id,OLD.request_text,OLD.trace_id,OLD.created_at,OLD.source_provider,OLD.source_message_id,OLD.communication_mode)) THEN
    RAISE EXCEPTION 'Prepared interaction binding is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.local_presence_id IS NULL AND NEW.local_presence_id IS NOT NULL AND
    (OLD.communication_mode <> 'unknown' OR NEW.communication_mode <> 'local' OR OLD.status <> 'received' OR OLD.response_claim_id IS NOT NULL OR OLD.response_text IS NOT NULL OR
    (to_jsonb(NEW) - 'local_presence_id' - 'communication_mode') IS DISTINCT FROM (to_jsonb(OLD) - 'local_presence_id' - 'communication_mode')) THEN
    RAISE EXCEPTION 'Invalid local preparation transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER interaction_presence_immutable BEFORE UPDATE ON interactions FOR EACH ROW EXECUTE FUNCTION guard_interaction_presence();
