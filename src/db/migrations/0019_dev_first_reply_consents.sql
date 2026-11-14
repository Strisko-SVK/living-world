CREATE TABLE "npc_dev_first_reply_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"player_entity_id" uuid NOT NULL,
	"source_message_id" text NOT NULL,
	"source_guild_id" text NOT NULL,
	"source_parent_id" text NOT NULL,
	"source_thread_id" text NOT NULL,
	"operator_entity_id" uuid NOT NULL,
	"issued_by" text DEFAULT current_user NOT NULL,
	"fixed_reply" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_id" uuid,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "dev_reply_one_event_per_world" UNIQUE("world_id","source_message_id"),
	CONSTRAINT "dev_reply_one_consent_per_interaction" UNIQUE("world_id","interaction_id"),
	CONSTRAINT "dev_reply_fixed_text" CHECK ("npc_dev_first_reply_consents"."fixed_reply" = 'Acknowledged. Standing by.'),
	CONSTRAINT "dev_reply_snowflakes" CHECK ("npc_dev_first_reply_consents"."source_message_id" ~ '^[0-9]{17,20}$' and
        "npc_dev_first_reply_consents"."source_guild_id" ~ '^[0-9]{17,20}$' and
        "npc_dev_first_reply_consents"."source_parent_id" ~ '^[0-9]{17,20}$' and
        "npc_dev_first_reply_consents"."source_thread_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "dev_reply_time_window" CHECK ("npc_dev_first_reply_consents"."expires_at" > "npc_dev_first_reply_consents"."issued_at" and
        "npc_dev_first_reply_consents"."expires_at" <= "npc_dev_first_reply_consents"."issued_at" + interval '5 minutes'),
	CONSTRAINT "dev_reply_terminal_shape" CHECK ((
        "npc_dev_first_reply_consents"."status" = 'approved'
        and "npc_dev_first_reply_consents"."attempt_id" is null
        and "npc_dev_first_reply_consents"."claimed_at" is null
        and "npc_dev_first_reply_consents"."revoked_at" is null
        and "npc_dev_first_reply_consents"."revoked_by" is null
      ) or (
        "npc_dev_first_reply_consents"."status" = 'claimed'
        and "npc_dev_first_reply_consents"."attempt_id" is not null
        and "npc_dev_first_reply_consents"."claimed_at" is not null
        and "npc_dev_first_reply_consents"."revoked_at" is null
        and "npc_dev_first_reply_consents"."revoked_by" is null
      ) or (
        "npc_dev_first_reply_consents"."status" = 'revoked'
        and "npc_dev_first_reply_consents"."attempt_id" is null
        and "npc_dev_first_reply_consents"."claimed_at" is null
        and "npc_dev_first_reply_consents"."revoked_at" is not null
        and "npc_dev_first_reply_consents"."revoked_by" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "npc_dev_first_reply_consents" ADD CONSTRAINT "dev_reply_original_interaction_scope_fk" FOREIGN KEY ("world_id","npc_id","context_id","interaction_id") REFERENCES "public"."interactions"("world_id","npc_id","context_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_dev_first_reply_consents" ADD CONSTRAINT "dev_reply_player_world_fk" FOREIGN KEY ("world_id","player_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_dev_first_reply_consents" ADD CONSTRAINT "dev_reply_operator_world_fk" FOREIGN KEY ("world_id","operator_entity_id") REFERENCES "public"."entities"("world_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_reply_world_status_idx" ON "npc_dev_first_reply_consents" USING btree ("world_id","status");

--> statement-breakpoint
-- The DEV-only first reply proof is durable, non-deletable and cannot be
-- rearmed by changing the consent UUID after an uncertain first attempt.
CREATE FUNCTION public.guard_dev_first_reply_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Exact database/role PAIRS; a production or foreign role must fail.
  IF NOT (
    (current_database()='living_world_ci' AND current_user='living_world_ci')
    OR (current_database()='living_world_gateway_dev' AND current_user='lw_gateway_dev')
  ) THEN
    RAISE EXCEPTION 'DEV first reply consent operator is not authorized' USING ERRCODE='42501';
  END IF;
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'One-shot consent audit cannot be erased' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'approved' OR NEW.attempt_id IS NOT NULL
       OR NEW.claimed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'One-shot consent must begin approved and unused' USING ERRCODE='23514';
    END IF;
    NEW.issued_at := clock_timestamp();
    NEW.issued_by := current_user;
    NEW.expires_at := LEAST(NEW.expires_at, NEW.issued_at + interval '5 minutes');
  ELSE
    -- Strictly allow ONE approved -> claimed OR approved -> revoked transition.
    -- No refund after an uncertain send, no editing identity/target/expiry,
    -- no second attempt or terminal record mutation.
    IF OLD.status <> 'approved' OR OLD.expires_at <= clock_timestamp()
       OR (to_jsonb(NEW) - 'status' - 'attempt_id' - 'claimed_at' - 'revoked_at' - 'revoked_by')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'attempt_id' - 'claimed_at' - 'revoked_at' - 'revoked_by')
    THEN
      RAISE EXCEPTION 'One-shot consent is immutable or expired' USING ERRCODE='23514';
    END IF;
    IF NEW.status='claimed' AND NEW.attempt_id IS NOT NULL
       AND NEW.revoked_at IS NULL AND NEW.revoked_by IS NULL THEN
      NEW.claimed_at := clock_timestamp();
    ELSIF NEW.status='revoked' AND NEW.attempt_id IS NULL
          AND NEW.claimed_at IS NULL THEN
      NEW.revoked_at := clock_timestamp();
      NEW.revoked_by := current_user;
    ELSE
      RAISE EXCEPTION 'Invalid one-shot consent transition' USING ERRCODE='23514';
    END IF;
  END IF;

  -- Defense in depth: the source must ALREADY exist; per-event approval
  -- comes AFTER inbound, while host scene-speech policy predates inbound.
  -- The application also checks a trusted Discord snowflake, exact route,
  -- mapping, activity, freshness and NPC presence before writes.
  IF NEW.status IN ('approved','claimed') AND NOT EXISTS (
    SELECT 1 FROM interactions i
    JOIN worlds w ON w.id=i.world_id
    WHERE w.id=NEW.world_id AND w.status='active' AND w.system_type='test'
      AND (
        (current_database()='living_world_ci' AND w.key LIKE 'npc-gateway-ci-%')
        OR (current_database()='living_world_gateway_dev' AND w.key LIKE 'lw-dev-first-reply-%')
      )
      AND i.world_id=NEW.world_id
      AND i.npc_id=NEW.npc_id
      AND i.context_id=NEW.context_id
      AND i.id=NEW.interaction_id
      AND i.speaker_entity_id=NEW.player_entity_id
      AND i.source_provider='discord'
      AND i.source_message_id=NEW.source_message_id
      AND i.source_guild_id=NEW.source_guild_id
      AND i.source_channel_id=NEW.source_parent_id
      AND i.source_thread_id=NEW.source_thread_id
      AND i.status='received' AND i.communication_mode='unknown'
      AND i.local_presence_id IS NULL
      AND i.response_claim_id IS NULL AND i.response_text IS NULL
      AND i.response_message_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM npc_response_deliveries d WHERE d.interaction_id=i.id
      )
      AND EXISTS (
        SELECT 1 FROM npc_scene_speech_policies p
        WHERE p.world_id=NEW.world_id AND p.npc_id=NEW.npc_id
          AND p.context_id=NEW.context_id
          AND p.issuer_entity_id=NEW.operator_entity_id
          AND p.issuer_role='host_operator'
          AND p.decision='allow_direct_speech'
          AND p.activity='free' AND p.perception='aware'
          AND p.other_scene='none'
          AND p.revoked_at IS NULL
          AND p.issued_at <= i.created_at
          AND p.expires_at > clock_timestamp()
      )
  ) THEN
    RAISE EXCEPTION 'Original fresh authorized event is required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dev_first_reply_consent_immutable
BEFORE INSERT OR UPDATE OR DELETE ON npc_dev_first_reply_consents
FOR EACH ROW EXECUTE FUNCTION public.guard_dev_first_reply_consent();
--> statement-breakpoint
CREATE TRIGGER dev_first_reply_consent_no_truncate
BEFORE TRUNCATE ON npc_dev_first_reply_consents
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_dev_first_reply_consent();
