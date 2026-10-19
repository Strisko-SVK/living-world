ALTER TABLE "interactions" ADD COLUMN "response_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "response_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "response_dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "response_prompt_version" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "response_generation_outcome" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_response_claim_shape" CHECK (
      ("interactions"."response_claim_id" is null and "interactions"."response_claimed_at" is null
        and "interactions"."response_dispatched_at" is null and "interactions"."response_prompt_version" is null
        and "interactions"."response_generation_outcome" is null)
      or ("interactions"."response_claim_id" is not null and "interactions"."response_claimed_at" is not null
        and "interactions"."response_prompt_version" is not null and length("interactions"."response_prompt_version") > 0
        and "interactions"."response_generation_outcome" is not null
        and "interactions"."response_generation_outcome" in ('claimed','dispatched','responded','failed','uncertain')
        and ("interactions"."response_generation_outcome" not in ('dispatched','responded','uncertain')
          or "interactions"."response_dispatched_at" is not null)));