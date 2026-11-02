CREATE TABLE "discord_outbound_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL
);
