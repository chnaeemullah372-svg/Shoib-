-- Anti-delete + per-account monitoring.
-- Apply with: pnpm --filter @workspace/db run push
-- (or run this SQL directly against the database).

-- 1) Anti-delete: keep originals, just record WHEN a delete happened.
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2) Per-account chats: tag each chat with the connected number that captured it.
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS account_phone text;

-- 3) Registry of every WhatsApp number that has ever connected.
CREATE TABLE IF NOT EXISTS wa_accounts (
  phone text PRIMARY KEY,
  name text,
  first_connected_at timestamptz NOT NULL DEFAULT now(),
  last_connected_at timestamptz NOT NULL DEFAULT now(),
  connect_count integer NOT NULL DEFAULT 1
);
