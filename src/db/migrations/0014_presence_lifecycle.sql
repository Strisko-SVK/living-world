-- Prior lifecycle history is unknowable: fail closed for all pre-0014 grants.
UPDATE "public"."local_presence" SET revoked_at = clock_timestamp(), revoked_by = current_user
WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION "public".revoke_deactivated_presence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Source row -> evidence is the existing grant/response lock direction.
  -- Never acquire interaction or other lifecycle rows from these triggers.
  IF TG_TABLE_NAME = 'worlds' THEN
    UPDATE public.local_presence SET revoked_at = clock_timestamp(), revoked_by = current_user
    WHERE world_id = NEW.id AND revoked_at IS NULL;
  ELSIF TG_TABLE_NAME = 'interaction_contexts' THEN
    UPDATE public.local_presence SET revoked_at = clock_timestamp(), revoked_by = current_user
    WHERE world_id = NEW.world_id AND context_id = NEW.id AND revoked_at IS NULL;
  ELSIF TG_TABLE_NAME = 'entities' THEN
    UPDATE public.local_presence SET revoked_at = clock_timestamp(), revoked_by = current_user
    WHERE world_id = NEW.world_id AND npc_id = NEW.id AND revoked_at IS NULL;
  ELSIF TG_TABLE_NAME = 'npcs' THEN
    UPDATE public.local_presence SET revoked_at = clock_timestamp(), revoked_by = current_user
    WHERE npc_id = NEW.entity_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER world_presence_deactivated AFTER UPDATE OF status ON "public"."worlds"
FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
EXECUTE FUNCTION "public".revoke_deactivated_presence();
--> statement-breakpoint
CREATE TRIGGER scene_presence_deactivated AFTER UPDATE OF status ON "public"."interaction_contexts"
FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
EXECUTE FUNCTION "public".revoke_deactivated_presence();
--> statement-breakpoint
CREATE TRIGGER entity_presence_deactivated AFTER UPDATE OF status ON "public"."entities"
FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
EXECUTE FUNCTION "public".revoke_deactivated_presence();
--> statement-breakpoint
CREATE TRIGGER npc_presence_deactivated AFTER UPDATE OF lifecycle_state ON "public"."npcs"
FOR EACH ROW WHEN (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state <> 'active')
EXECUTE FUNCTION "public".revoke_deactivated_presence();
