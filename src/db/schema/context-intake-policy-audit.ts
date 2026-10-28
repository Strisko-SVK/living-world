import { sql } from "drizzle-orm";
import {
  foreignKey,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { interactionContexts } from "./interaction-contexts.js";
import { npcIntakePolicy } from "./enums.js";

// Written only by the local operator command, atomically with the policy update.
export const contextIntakePolicyAudit = pgTable(
  "context_intake_policy_audit",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id").notNull(),
    contextId: uuid("context_id").notNull(),
    previousPolicy: npcIntakePolicy("previous_policy").notNull(),
    targetPolicy: npcIntakePolicy("target_policy").notNull(),
    databaseRole: text("database_role")
      .notNull()
      .default(sql`current_user`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "context_intake_policy_audit_context_world_fk",
      columns: [table.worldId, table.contextId],
      foreignColumns: [interactionContexts.worldId, interactionContexts.id],
    }).onDelete("restrict"),
  ],
);
