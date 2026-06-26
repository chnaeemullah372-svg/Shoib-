import { eq, sql, desc, asc } from "drizzle-orm";
import { createHash } from "crypto";
import {
  db,
  waChatsTable,
  waMessagesTable,
  appLogsTable,
  adminUsersTable,
  type WaChat,
} from "@workspace/db";
import { multiWA, type HydrateChat, type WAChatMsg } from "./multiWhatsapp";

/**
 * The whole app is built around ONE panel user. We pin every WhatsApp session
 * to this fixed id so the single user always drives the same Baileys engine.
 */
export const PANEL_USER_ID = 1;

let started = false;

/** Append a line to the application log table (best-effort, never throws). */
export async function logEvent(message: string, level = "info", source = "system") {
  try {
    await db.insert(appLogsTable).values({ message, level, source });
  } catch (err) {
    console.error("[log] failed to persist log:", err);
  }
}

/** Persist a single message + upsert its chat row. Best-effort.
 *  When `history` is true the message came from a WhatsApp history sync, so we
 *  never bump the unread counter (those messages are old) and only advance the
 *  chat's last-message preview when this message is actually newer. */
async function persistMessage(jid: string, phone: string, msg: WAChatMsg, history = false) {
  try {
    await db
      .insert(waMessagesTable)
      .values({
        waMessageId: msg.id,
        jid,
        text: msg.text,
        fromMe: msg.fromMe,
        ts: msg.ts,
        status: msg.status,
        deleted: msg.deleted ?? false,
        quotedText: msg.quotedText,
        quotedId: msg.quotedId,
        media: msg.media,
        mediaMime: msg.mediaMime,
        mediaKind: msg.mediaKind,
        fileName: msg.fileName,
      })
      .onConflictDoUpdate({
        target: waMessagesTable.waMessageId,
        // Refresh the stored text (e.g. an old row saved as "Media" before the
        // envelope-unwrap fix) but never clobber a deleted-for-everyone marker.
        // Backfill media too when a re-seen row finally downloaded its payload.
        set: {
          text: sql`CASE WHEN ${waMessagesTable.deleted} THEN ${waMessagesTable.text} ELSE ${msg.text} END`,
          quotedText: msg.quotedText,
          quotedId: msg.quotedId,
          media: sql`COALESCE(${waMessagesTable.media}, ${msg.media ?? null})`,
          mediaMime: sql`COALESCE(${waMessagesTable.mediaMime}, ${msg.mediaMime ?? null})`,
          mediaKind: sql`COALESCE(${waMessagesTable.mediaKind}, ${msg.mediaKind ?? null})`,
          fileName: sql`COALESCE(${waMessagesTable.fileName}, ${msg.fileName ?? null})`,
        },
      });

    await db
      .insert(waChatsTable)
      .values({
        jid,
        phone,
        lastMsg: msg.text,
        lastMsgTs: msg.ts,
        unread: 0,
      })
      .onConflictDoUpdate({
        target: waChatsTable.jid,
        set: {
          // Only move the preview forward for newer messages (history syncs can
          // arrive out of order).
          lastMsg: sql`CASE WHEN ${msg.ts} >= ${waChatsTable.lastMsgTs} THEN ${msg.text} ELSE ${waChatsTable.lastMsg} END`,
          lastMsgTs: sql`GREATEST(${waChatsTable.lastMsgTs}, ${msg.ts})`,
          unread:
            history || msg.fromMe
              ? sql`${waChatsTable.unread}`
              : sql`${waChatsTable.unread} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error("[persist] failed to persist message:", err);
  }
}

/** Update the delivery/read status of a stored message. */
async function persistStatus(waMessageId: string, status: number) {
  try {
    await db
      .update(waMessagesTable)
      .set({ status })
      .where(eq(waMessagesTable.waMessageId, waMessageId));
  } catch (err) {
    console.error("[persist] failed to update status:", err);
  }
}

/** Mark a chat's unread counter back to zero (when the user opens it). */
export async function clearUnread(jid: string) {
  try {
    await db.update(waChatsTable).set({ unread: 0 }).where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] failed to clear unread:", err);
  }
}

/** Mark a stored message as deleted-for-everyone. */
export async function markDeleted(waMessageId: string) {
  try {
    await db
      .update(waMessagesTable)
      .set({ deleted: true, text: "🚫 This message was deleted" })
      .where(eq(waMessagesTable.waMessageId, waMessageId));
  } catch (err) {
    console.error("[persist] failed to mark deleted:", err);
  }
}

/** Read full chat history from DB shaped for the engine's hydrate(). */
export async function loadHistory(): Promise<HydrateChat[]> {
  const chats = await db
    .select()
    .from(waChatsTable)
    .orderBy(desc(waChatsTable.lastMsgTs));

  const result: HydrateChat[] = [];
  for (const c of chats) {
    const msgs = await db
      .select()
      .from(waMessagesTable)
      .where(eq(waMessagesTable.jid, c.jid))
      .orderBy(asc(waMessagesTable.ts))
      .limit(300);
    result.push({
      meta: {
        jid: c.jid,
        phone: c.phone,
        lastMsg: c.lastMsg,
        lastMsgTs: c.lastMsgTs,
        unread: c.unread,
      },
      msgs: msgs.map((m) => ({
        id: m.waMessageId,
        text: m.text,
        fromMe: m.fromMe,
        ts: m.ts,
        status: m.status,
        deleted: m.deleted,
        quotedText: m.quotedText ?? undefined,
        quotedId: m.quotedId ?? undefined,
        media: m.media ?? undefined,
        mediaMime: m.mediaMime ?? undefined,
        mediaKind: m.mediaKind ?? undefined,
        fileName: m.fileName ?? undefined,
      })),
    });
  }
  return result;
}

/** All chats (for admin overview). */
export async function getAllChats(): Promise<WaChat[]> {
  return db.select().from(waChatsTable).orderBy(desc(waChatsTable.lastMsgTs));
}

/** All messages for a chat (from DB — survives restart). The heavy base64
 *  `media` column is intentionally excluded; clients fetch each payload on
 *  demand via the media endpoint using `hasMedia`/`mediaKind`. */
export async function getChatMessagesDb(jid: string) {
  const rows = await db
    .select({
      id: waMessagesTable.id,
      waMessageId: waMessagesTable.waMessageId,
      jid: waMessagesTable.jid,
      text: waMessagesTable.text,
      fromMe: waMessagesTable.fromMe,
      ts: waMessagesTable.ts,
      status: waMessagesTable.status,
      deleted: waMessagesTable.deleted,
      quotedText: waMessagesTable.quotedText,
      quotedId: waMessagesTable.quotedId,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
      hasMedia: sql<boolean>`(${waMessagesTable.media} IS NOT NULL)`,
    })
    .from(waMessagesTable)
    .where(eq(waMessagesTable.jid, jid))
    .orderBy(asc(waMessagesTable.ts));
  return rows;
}

/** Fetch a single message's media payload (base64) for the serve endpoint. */
export async function getMediaById(waMessageId: string) {
  const [row] = await db
    .select({
      media: waMessagesTable.media,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
    })
    .from(waMessagesTable)
    .where(eq(waMessagesTable.waMessageId, waMessageId))
    .limit(1);
  return row ?? null;
}

/**
 * Ensure at least one admin account exists so the admin panel is usable.
 * Self-hosted personal tool: seeds from ADMIN_USERNAME/ADMIN_PASSWORD env vars,
 * or falls back to admin / admin123 (logged so the owner can change it).
 */
async function seedDefaultAdmin() {
  try {
    const admins = await db.select().from(adminUsersTable).limit(1);
    if (admins.length) return;
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin123";
    await db
      .insert(adminUsersTable)
      .values({ username, passwordHash: createHash("sha256").update(password).digest("hex") } as any)
      .onConflictDoNothing();
    console.log(`[seed] created default admin "${username}" — change the password after first login`);
    await logEvent(`Default admin account "${username}" created`, "warn", "auth");
  } catch (err) {
    console.error("[seed] failed to seed admin:", err);
  }
}

/**
 * Wire engine → DB and load saved history into the engine. Idempotent.
 */
export async function startPersistence() {
  if (started) return;
  started = true;

  await seedDefaultAdmin();

  multiWA.addPersistListener((_uid, jid, phone, msg, history) => {
    void persistMessage(jid, phone, msg, history);
  });
  multiWA.addStatusListener((_uid, update) => {
    void persistStatus(update.waMessageId, update.status);
  });

  try {
    const history = await loadHistory();
    if (history.length) {
      multiWA.hydrate(PANEL_USER_ID, history);
      console.log(`[persist] hydrated ${history.length} chats from DB`);
    }
  } catch (err) {
    console.error("[persist] failed to hydrate history:", err);
  }

  await logEvent("Persistence started; engine wired to DB", "info", "system");
}
