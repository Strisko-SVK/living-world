-- Abort before changing constraints if legacy rows conflict. No data is repaired
-- automatically. Locks keep this preflight and constraint installation atomic.
LOCK TABLE entities, interaction_contexts, interactions, tasks,
  discord_context_mappings, discord_identities, memory_sources,
  relationship_events IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE relation record;
DECLARE invalid boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM discord_context_mappings GROUP BY world_id, guild_id, channel_id, thread_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'M2.3.1 preflight: conflicting Discord locations; resolve explicitly before retrying';
  END IF;
  IF EXISTS (SELECT 1 FROM discord_identities WHERE is_primary AND status <> 'active') OR
     EXISTS (SELECT 1 FROM discord_identities WHERE is_primary GROUP BY world_id, discord_user_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'M2.3.1 preflight: conflicting or inactive primary identities; resolve explicitly before retrying';
  END IF;
  IF EXISTS (SELECT 1 FROM discord_context_mappings WHERE status = 'active' AND npc_id IS NOT NULL GROUP BY world_id, npc_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'M2.3.1 preflight: multiple active NPC primary mappings; resolve explicitly before retrying';
  END IF;
  FOR relation IN SELECT * FROM (VALUES
    ('discord_context_mappings', 'context_id', 'interaction_contexts'),
    ('discord_context_mappings', 'npc_id', 'entities'),
    ('discord_identities', 'entity_id', 'entities'),
    ('interaction_contexts', 'linked_location_entity_id', 'entities'),
    ('interactions', 'context_id', 'interaction_contexts'),
    ('interactions', 'npc_id', 'entities'),
    ('interactions', 'speaker_entity_id', 'entities'),
    ('tasks', 'assignee_entity_id', 'entities'),
    ('tasks', 'requester_entity_id', 'entities'),
    ('tasks', 'origin_interaction_id', 'interactions'),
    ('tasks', 'origin_context_id', 'interaction_contexts')
  ) AS refs(child, column_name, parent) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I c LEFT JOIN %I p ON p.id = c.%I AND p.world_id = c.world_id WHERE c.%I IS NOT NULL AND p.id IS NULL)', relation.child, relation.parent, relation.column_name, relation.column_name) INTO invalid;
    IF invalid THEN
      RAISE EXCEPTION 'M2.3.1 preflight: invalid world reference %.%; resolve explicitly before retrying', relation.child, relation.column_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM memory_sources s JOIN npc_memories m ON m.id = s.memory_id LEFT JOIN interactions i ON i.id = s.source_interaction_id WHERE s.source_interaction_id IS NOT NULL AND (i.id IS NULL OR i.world_id <> m.world_id OR i.npc_id <> m.npc_id)) OR
     EXISTS (SELECT 1 FROM relationship_events e JOIN relationships r ON r.id = e.relationship_id JOIN entities n ON n.id = r.source_entity_id LEFT JOIN interactions i ON i.id = e.source_interaction_id WHERE e.source_interaction_id IS NOT NULL AND (i.id IS NULL OR i.world_id <> r.world_id OR (n.entity_type = 'npc' AND i.npc_id <> n.id))) THEN
    RAISE EXCEPTION 'M2.3.1 preflight: invalid interaction provenance; resolve explicitly before retrying';
  END IF;
END $$;
--> statement-breakpoint
-- Drizzle generates foreign keys before new candidate keys; install these first.
ALTER TABLE "entities" ADD CONSTRAINT "entities_world_id_unique" UNIQUE("world_id","id");--> statement-breakpoint
ALTER TABLE "interaction_contexts" ADD CONSTRAINT "interactionContexts_world_id_unique" UNIQUE("world_id","id");--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_world_id_unique" UNIQUE("world_id","id");--> statement-breakpoint
DROP INDEX "discord_context_mappings_location_idx";--> statement-breakpoint
ALTER TABLE "discord_context_mappings" ADD CONSTRAINT "discord_context_world_fk" FOREIGN KEY ("world_id","context_id") REFERENCES "public"."interaction_contexts"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_context_mappings" ADD CONSTRAINT "discord_npc_world_fk" FOREIGN KEY ("world_id","npc_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_identities" ADD CONSTRAINT "discord_identity_world_fk" FOREIGN KEY ("world_id","entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_contexts" ADD CONSTRAINT "context_location_world_fk" FOREIGN KEY ("world_id","linked_location_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_context_world_fk" FOREIGN KEY ("world_id","context_id") REFERENCES "public"."interaction_contexts"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_npc_world_fk" FOREIGN KEY ("world_id","npc_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_speaker_world_fk" FOREIGN KEY ("world_id","speaker_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_source_interaction_id_interactions_id_fk" FOREIGN KEY ("source_interaction_id") REFERENCES "public"."interactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_events" ADD CONSTRAINT "relationship_events_source_interaction_id_interactions_id_fk" FOREIGN KEY ("source_interaction_id") REFERENCES "public"."interactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_assignee_world_fk" FOREIGN KEY ("world_id","assignee_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_requester_world_fk" FOREIGN KEY ("world_id","requester_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_interaction_world_fk" FOREIGN KEY ("world_id","origin_interaction_id") REFERENCES "public"."interactions"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_context_world_fk" FOREIGN KEY ("world_id","origin_context_id") REFERENCES "public"."interaction_contexts"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_context_mappings_active_npc_unique" ON "discord_context_mappings" USING btree ("world_id","npc_id") WHERE "discord_context_mappings"."status" = 'active' and "discord_context_mappings"."npc_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_identity_active_primary_unique" ON "discord_identities" USING btree ("world_id","discord_user_id") WHERE "discord_identities"."is_primary" and "discord_identities"."status" = 'active';--> statement-breakpoint
ALTER TABLE "discord_context_mappings" ADD CONSTRAINT "discord_context_mappings_location_unique" UNIQUE NULLS NOT DISTINCT("world_id","guild_id","channel_id","thread_id");--> statement-breakpoint
ALTER TABLE "discord_identities" ADD CONSTRAINT "discord_identity_primary_active" CHECK (not "discord_identities"."is_primary" or "discord_identities"."status" = 'active');
