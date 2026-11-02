import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
// Keys contain digests of public webhook IDs/version identifiers, never tokens.
// This is shared provider cooldown/quarantine state, not a delivery lifecycle.
export const discordOutboundLimits = pgTable("discord_outbound_limits", {
  key: text("key").primaryKey(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  disabled: boolean("disabled").notNull().default(false),
});
