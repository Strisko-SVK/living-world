-- M2.19: durable, private NPC turn enrichment queue. No retroactive backfill.
-- The entry is created ONLY once a native Discord response is acknowledged.
CREATE TABLE npc_turn_enrichments (
  interaction_id uuid PRIMARY KEY REFERENCES interactions(id) ON DELETE RESTRICT,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  npc_id uuid NOT NULL REFERENCES npcs(entity_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','extracted','applying','done','failed')),
  proposals jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX npc_turn_enrichments_pending_idx
  ON npc_turn_enrichments(status, created_at);

CREATE FUNCTION lw_enqueue_npc_turn_enrichment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
    INSERT INTO npc_turn_enrichments(interaction_id,world_id,npc_id)
    SELECT i.id,i.world_id,i.npc_id
    FROM interactions i
    WHERE i.id=NEW.interaction_id AND i.world_id=NEW.world_id
      AND i.npc_id=NEW.npc_id AND i.context_id=NEW.context_id
      AND i.discord_native_source AND i.source_provider='discord'
      AND i.speaker_entity_id IS NOT NULL
      -- Response message id is stored on interactions after the delivery
      -- status UPDATE, inside the same transaction. Do not require it here.
    ON CONFLICT (interaction_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lw_enqueue_npc_turn_enrichment_trigger
AFTER UPDATE OF status ON npc_response_deliveries
FOR EACH ROW WHEN (NEW.status='delivered')
EXECUTE FUNCTION lw_enqueue_npc_turn_enrichment();
