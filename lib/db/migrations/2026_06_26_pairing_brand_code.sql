-- Custom-branded WhatsApp pairing code shown during phone linking.
-- Apply with: psql $DATABASE_URL -f lib/db/migrations/2026_06_26_pairing_brand_code.sql
-- (or via `pnpm --filter @workspace/db run push` if drizzle-kit is wired up).

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS pairing_brand_code text NOT NULL DEFAULT 'HASANALI';
