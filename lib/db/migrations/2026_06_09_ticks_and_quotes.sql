-- Read receipts (ticks) + quoted-reply round-trip between bot widget and WhatsApp.
-- Apply with: psql $DATABASE_URL -f lib/db/migrations/2026_06_09_ticks_and_quotes.sql

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS wa_message_id     text,
  ADD COLUMN IF NOT EXISTS wa_status         smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quoted_message_id integer,
  ADD COLUMN IF NOT EXISTS quoted_text       text,
  ADD COLUMN IF NOT EXISTS quoted_wa_id      text;

CREATE INDEX IF NOT EXISTS chat_messages_wa_message_id_idx
  ON chat_messages (wa_message_id)
  WHERE wa_message_id IS NOT NULL;
