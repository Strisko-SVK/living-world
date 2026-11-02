CREATE TABLE "npc_response_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempt_id" uuid,
	"lease_until" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ack_message_id" text,
	"delivered_at" timestamp with time zone,
	"last_code" text,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" text,
	"reconciliation_evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_delivery_interaction_unique" UNIQUE("interaction_id"),
	CONSTRAINT "response_delivery_status" CHECK ("npc_response_deliveries"."status" in ('pending','claimed','sending','delivered','retryable','uncertain','blocked','failed')),
	CONSTRAINT "response_delivery_attempts" CHECK ("npc_response_deliveries"."attempts" between 0 and 3),
	CONSTRAINT "response_delivery_claim_shape" CHECK (("npc_response_deliveries"."attempts"=0 and "npc_response_deliveries"."attempt_id" is null and "npc_response_deliveries"."lease_until" is null) or ("npc_response_deliveries"."attempts">0 and "npc_response_deliveries"."attempt_id" is not null and "npc_response_deliveries"."lease_until" is not null)),
	CONSTRAINT "response_delivery_dispatch_shape" CHECK ("npc_response_deliveries"."status" not in ('sending','uncertain','delivered') or "npc_response_deliveries"."dispatched_at" is not null),
	CONSTRAINT "response_delivery_ack_shape" CHECK (("npc_response_deliveries"."status"='delivered' and "npc_response_deliveries"."ack_message_id" is not null and "npc_response_deliveries"."delivered_at" is not null) or ("npc_response_deliveries"."status"<>'delivered' and "npc_response_deliveries"."ack_message_id" is null and "npc_response_deliveries"."delivered_at" is null))
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "source_guild_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "source_channel_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "source_thread_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "source_mapping_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_delivery_scope_unique" UNIQUE("world_id","npc_id","context_id","id");--> statement-breakpoint
ALTER TABLE "npc_response_deliveries" ADD CONSTRAINT "response_delivery_scope_fk" FOREIGN KEY ("world_id","npc_id","context_id","interaction_id") REFERENCES "public"."interactions"("world_id","npc_id","context_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_delivery_world_status_idx" ON "npc_response_deliveries" USING btree ("world_id","status");--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_source_route_shape" CHECK (("interactions"."source_guild_id" is null and "interactions"."source_channel_id" is null and "interactions"."source_thread_id" is null and "interactions"."source_mapping_id" is null) or ("interactions"."source_provider" IS NOT DISTINCT FROM 'discord' and "interactions"."source_guild_id" is not null and "interactions"."source_channel_id" is not null and "interactions"."source_mapping_id" is not null));--> statement-breakpoint
CREATE FUNCTION guard_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.world_id,NEW.npc_id,NEW.context_id,NEW.interaction_id,NEW.payload,NEW.fingerprint,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.world_id,OLD.npc_id,OLD.context_id,OLD.interaction_id,OLD.payload,OLD.fingerprint,OLD.created_at)
     OR (OLD.status IN ('delivered','blocked','failed') AND NEW IS DISTINCT FROM OLD)
     OR NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'Immutable delivery snapshot or terminal result' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_snapshot_immutable BEFORE UPDATE ON npc_response_deliveries
FOR EACH ROW EXECUTE FUNCTION guard_delivery_snapshot();
--> statement-breakpoint
CREATE FUNCTION guard_delivery_interaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.source_guild_id,NEW.source_channel_id,NEW.source_thread_id,NEW.source_mapping_id)
    IS DISTINCT FROM ROW(OLD.source_guild_id,OLD.source_channel_id,OLD.source_thread_id,OLD.source_mapping_id) THEN
    RAISE EXCEPTION 'Original source route is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.source_mapping_id IS NOT NULL THEN
    IF OLD.response_text IS NOT NULL AND NEW.response_text IS DISTINCT FROM OLD.response_text THEN
      RAISE EXCEPTION 'Generated response is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.response_message_id IS DISTINCT FROM OLD.response_message_id THEN
      IF OLD.response_message_id IS NOT NULL OR NEW.response_message_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM npc_response_deliveries d WHERE d.world_id=NEW.world_id AND d.npc_id=NEW.npc_id
        AND d.interaction_id=NEW.id AND d.status='delivered' AND d.ack_message_id=NEW.response_message_id
      ) THEN
        RAISE EXCEPTION 'Response message reference requires delivery acknowledgement' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_interaction_guard BEFORE UPDATE ON interactions
FOR EACH ROW EXECUTE FUNCTION guard_delivery_interaction();
