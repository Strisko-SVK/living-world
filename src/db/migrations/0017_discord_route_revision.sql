-- An existing route's unseen history cannot justify earlier responses.
-- Reset all current route epochs so pre-migration sends fail closed.
UPDATE "public"."discord_context_mappings"
SET "updated_at" = clock_timestamp();
--> statement-breakpoint
CREATE FUNCTION "public".bump_discord_route_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Covers direct SQL and application changes, not only explicit operators.
  IF ROW(OLD.world_id, OLD.context_id, OLD.npc_id, OLD.guild_id,
         OLD.channel_id, OLD.thread_id, OLD.mapping_type, OLD.status)
     IS DISTINCT FROM
     ROW(NEW.world_id, NEW.context_id, NEW.npc_id, NEW.guild_id,
         NEW.channel_id, NEW.thread_id, NEW.mapping_type, NEW.status) THEN
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER discord_route_revision BEFORE UPDATE ON "public"."discord_context_mappings"
FOR EACH ROW EXECUTE FUNCTION "public".bump_discord_route_revision();
