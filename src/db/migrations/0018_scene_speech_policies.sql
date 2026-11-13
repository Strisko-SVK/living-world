-- M2.15E: new table is intentionally empty on upgrade. Historical events
-- cannot obtain retroactive DM/operator scene-speech authorization.
-- Only the isolated local DEV/CI host role may write in this milestone.
CREATE TABLE "npc_scene_speech_policies" (
  "id" uuid PRIMARY KEY NOT NULL,
  "world_id" uuid NOT NULL,
  "npc_id" uuid NOT NULL,
  "context_id" uuid NOT NULL,
  "presence_id" uuid NOT NULL,
  "npc_state_version" integer NOT NULL,
  "issuer_entity_id" uuid NOT NULL,
  "issuer_role" text NOT NULL,
  "issued_by" text DEFAULT current_user NOT NULL,
  "decision" text NOT NULL,
  "activity" text NOT NULL,
  "perception" text NOT NULL,
  "other_scene" text NOT NULL,
  "issued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  CONSTRAINT "scene_speech_role_host_only" CHECK ("issuer_role" = 'host_operator'),
  CONSTRAINT "scene_speech_decision_values" CHECK ("decision" in ('allow_direct_speech','hold','deny')),
  CONSTRAINT "scene_speech_activity_values" CHECK ("activity" in ('free','busy','unavailable')),
  CONSTRAINT "scene_speech_perception_values" CHECK ("perception" in ('aware','unaware')),
  CONSTRAINT "scene_speech_occupancy_values" CHECK ("other_scene" in ('none','active')),
  CONSTRAINT "scene_speech_positive_revision" CHECK ("npc_state_version" > 0),
  CONSTRAINT "scene_speech_bounded_window" CHECK ("expires_at" > "issued_at" and "expires_at" <= "issued_at" + interval '30 minutes'),
  CONSTRAINT "scene_speech_revocation_shape" CHECK (("revoked_at" is null) = ("revoked_by" is null))
);
--> statement-breakpoint
ALTER TABLE "npc_scene_speech_policies" ADD CONSTRAINT "scene_speech_presence_scope_fk"
FOREIGN KEY ("world_id","npc_id","context_id","presence_id")
REFERENCES "public"."local_presence"("world_id","npc_id","context_id","id")
ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "npc_scene_speech_policies" ADD CONSTRAINT "scene_speech_issuer_world_fk"
FOREIGN KEY ("world_id","issuer_entity_id") REFERENCES "public"."entities"("world_id","id")
ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "scene_speech_one_open_policy" ON "npc_scene_speech_policies"
USING btree ("world_id","npc_id","context_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "scene_speech_world_presence_idx" ON "npc_scene_speech_policies"
USING btree ("world_id","npc_id","context_id","presence_id");
--> statement-breakpoint
CREATE FUNCTION public.guard_scene_speech_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Never allow the normal production runtime to issue these operator grants.
  -- A separate reviewed production/DM authorization model is required later.
  IF current_database() NOT IN ('living_world_ci','living_world_gateway_dev')
     OR current_user NOT IN ('living_world_ci','lw_gateway_dev') THEN
    RAISE EXCEPTION 'Scene speech operator is not authorized' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Issued scene speech evidence cannot be deleted or truncated' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.issued_at := clock_timestamp();
    NEW.issued_by := current_user;
    -- Database-generated time prevents a forged long-lived grant. Bound
    -- minor clock_timestamp() differences between the two expressions.
    NEW.expires_at := LEAST(
      NEW.expires_at,
      NEW.issued_at + interval '30 minutes'
    );
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by')
       IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by')
    OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.revoked_by IS DISTINCT FROM current_user::text
    OR NEW.revoked_at < OLD.issued_at THEN
    RAISE EXCEPTION 'Scene speech evidence is immutable except for a single revocation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scene_speech_policy_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "npc_scene_speech_policies"
FOR EACH ROW EXECUTE FUNCTION public.guard_scene_speech_policy();
--> statement-breakpoint
CREATE TRIGGER scene_speech_policy_no_truncate
BEFORE TRUNCATE ON "npc_scene_speech_policies"
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_scene_speech_policy();
