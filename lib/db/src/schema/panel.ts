import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  smallint,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Single panel user. The whole app is built around ONE user account that the
 * admin oversees. The admin must be able to *see* the username + password, so
 * the plaintext password is stored alongside the hash (self-hosted personal
 * tool — the admin owns the data).
 */
export const panelUserTable = pgTable("panel_user", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordPlain: text("password_plain").notNull(),
  approved: boolean("approved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});
export type PanelUser = typeof panelUserTable.$inferSelect;

/** One row per WhatsApp contact/chat (1:1 chats only). */
export const waChatsTable = pgTable("wa_chats", {
  jid: text("jid").primaryKey(),
  phone: text("phone").notNull(),
  name: text("name"),
  lastMsg: text("last_msg").notNull().default(""),
  lastMsgTs: bigint("last_msg_ts", { mode: "number" }).notNull().default(0),
  unread: integer("unread").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type WaChat = typeof waChatsTable.$inferSelect;

/** Every incoming/outgoing WhatsApp message, persisted for history + backup. */
export const waMessagesTable = pgTable(
  "wa_messages",
  {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").notNull(),
    jid: text("jid").notNull(),
    text: text("text").notNull().default(""),
    fromMe: boolean("from_me").notNull().default(false),
    ts: bigint("ts", { mode: "number" }).notNull().default(0),
    status: smallint("status").notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    quotedText: text("quoted_text"),
    quotedId: text("quoted_id"),
    // Media payload (base64) for photos/voice/video/documents/stickers. Kept
    // out of the chat-list query; served on demand via the media endpoint.
    media: text("media"),
    mediaMime: text("media_mime"),
    mediaKind: text("media_kind"), // image | video | audio | sticker | document
    fileName: text("file_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    waMsgUnique: uniqueIndex("wa_messages_wa_message_id_uq").on(t.waMessageId),
  }),
);
export type WaMessage = typeof waMessagesTable.$inferSelect;

/** Application + connection logs (visible in User Logs + Admin Logs). */
export const appLogsTable = pgTable("app_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"),
  source: text("source").notNull().default("system"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppLog = typeof appLogsTable.$inferSelect;

/** Backups (full JSON snapshot of chats + messages + settings). */
export const appBackupsTable = pgTable("app_backups", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  chatCount: integer("chat_count").notNull().default(0),
  messageCount: integer("message_count").notNull().default(0),
  payload: text("payload").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppBackup = typeof appBackupsTable.$inferSelect;

/** Singleton settings row (id = 1). */
export const appSettingsTable = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  notifications: boolean("notifications").notNull().default(true),
  autoBackup: boolean("auto_backup").notNull().default(false),
  backupSchedule: text("backup_schedule").notNull().default("daily"),
  theme: text("theme").notNull().default("dark"),
  language: text("language").notNull().default("English"),
  pairingBrandCode: text("pairing_brand_code").notNull().default("HASANALI"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppSettings = typeof appSettingsTable.$inferSelect;
