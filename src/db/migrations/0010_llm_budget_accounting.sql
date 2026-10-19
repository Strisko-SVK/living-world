CREATE TABLE "llm_budget" (
	"id" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"ceiling_micros" bigint NOT NULL,
	CONSTRAINT "llm_budget_singleton" CHECK ("llm_budget"."id" = 'llm'),
	CONSTRAINT "llm_budget_currency" CHECK ("llm_budget"."currency" in ('USD', 'EUR')),
	CONSTRAINT "llm_budget_positive" CHECK ("llm_budget"."ceiling_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trace_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"charged_micros" bigint NOT NULL,
	"input_rate" bigint NOT NULL,
	"output_rate" bigint NOT NULL,
	"status" text NOT NULL,
	"outcome" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"retries" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "llm_usage_amounts" CHECK ("llm_usage"."reserved_micros" > 0 and "llm_usage"."charged_micros" >= 0 and "llm_usage"."input_rate" > 0 and "llm_usage"."output_rate" > 0),
	CONSTRAINT "llm_usage_status" CHECK ("llm_usage"."status" in ('reserved', 'settled', 'uncertain')),
	CONSTRAINT "llm_usage_lifecycle" CHECK (("llm_usage"."status" = 'reserved' and "llm_usage"."settled_at" is null and "llm_usage"."charged_micros" = "llm_usage"."reserved_micros") or ("llm_usage"."status" <> 'reserved' and "llm_usage"."settled_at" is not null)),
	CONSTRAINT "llm_usage_tokens" CHECK (("llm_usage"."input_tokens" is null and "llm_usage"."output_tokens" is null and "llm_usage"."total_tokens" is null) or ("llm_usage"."input_tokens" is not null and "llm_usage"."output_tokens" is not null and "llm_usage"."total_tokens" is not null and "llm_usage"."input_tokens" >= 0 and "llm_usage"."output_tokens" >= 0 and "llm_usage"."total_tokens" = "llm_usage"."input_tokens" + "llm_usage"."output_tokens")),
	CONSTRAINT "llm_usage_diagnostics" CHECK ("llm_usage"."retries" between 0 and 2 and ("llm_usage"."latency_ms" is null or "llm_usage"."latency_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_account_id_llm_budget_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."llm_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_account_status" ON "llm_usage" USING btree ("account_id","status","settled_at");