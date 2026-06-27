---
name: WhatsApp panel decisions
description: Security + product constraints for the Support Connect WhatsApp panel (user + admin).
---

## QR codes must be rendered locally
Render the Baileys QR/pairing string with the local `qrcode` package (e.g. `QRCode.toDataURL`), never via an external image service like `api.qrserver.com`.
**Why:** the QR `state.qr` value is the live WhatsApp linking payload. Sending it to a third party exposes a session-pairing path. A prior version used `api.qrserver.com` — that is a credential-exfiltration risk.
**How to apply:** any connect/QR UI must keep `state.qr` on-origin.

## Admin panel is monitoring-only
The admin dashboard must not be able to send WhatsApp messages — UI form AND the backend route must both be absent. The `POST /admin-panel/send` route was intentionally removed.
**Why:** product requirement — admin oversees all incoming/outgoing traffic but never originates messages. Hiding only the UI is not enough; an authenticated admin token could still call the route.
**How to apply:** if asked to add admin messaging, confirm intent first — it contradicts the monitoring-only design.

## Connection backend already works
The working Baileys connection lives in `multiWhatsapp.ts` (connectQR / connectPhone pairing). Reported "connection not working" complaints have been about QR UX (manual tap, no auto-generate), not the backend. The pairing-code flow (type number → 5s → requestPairingCode) mirrors the known-good `services/whatsapp.ts`. Pairing-code is the default connect mode (user finds it easiest); QR is an opt-in tab that auto-generates on open.

## "Complete WhatsApp Web" needs history sync, not just live capture
`messages.upsert` (type `notify`) only captures messages that arrive AFTER the device links — so the inbox starts empty. To make existing chats/messages appear like WhatsApp Web, you MUST also handle the Baileys `messaging-history.set` event and persist its chats+messages. Mark these as `history` so old inbound messages do NOT inflate unread counters.
**Why:** users link an account and expect their real conversations to show up immediately; without history sync the panel looks broken/empty.

## Every message showing "Media" = unwrap Baileys envelopes
If chats/messages all render as "📎 Media" (no real text), the parser is reading the top-level proto without unwrapping. Baileys wraps real content in envelopes: outgoing-from-phone → `deviceSentMessage.message`, disappearing chats → `ephemeralMessage.message`, view-once → `viewOnceMessage(/V2/V2Extension).message`, plus `documentWithCaptionMessage.message` and `editedMessage.message`. Unwrap (loop, content can be doubly-wrapped) BEFORE extracting conversation/extendedTextMessage/captions.
**Why:** the user's own outgoing messages and any disappearing-message chat were all falling through to the "Media" fallback.

## Correcting already-persisted message rows on re-sync
In-memory dedup (`upsertMsg` only persists when a message is newly `added`) means a re-link/history replay will NOT re-write rows already in the DB — so a parser fix alone won't repair old bad rows. To backfill: when an existing in-memory message is re-seen with better/different non-empty text (and isn't deleted), update it in memory AND call notifyPersist; pair that with `onConflictDoUpdate` on `wa_messages` (keyed on waMessageId) whose text uses `CASE WHEN deleted THEN keep ELSE new` so delete markers survive.
**How to apply:** any "old data is wrong after a parser/format fix" situation needs both a re-emit path through dedup AND a conflict-update at the DB layer.

## Admin chat monitor = master-detail, not split, and must poll the open chat
Admin "All Chats" should be tap-to-open like normal WhatsApp: show the full-width list when no chat is active, and a full conversation view (with a back button that clears activeChat) when one is tapped — not a cramped side-by-side split that strands "Select a chat" on mobile. The open conversation must have its OWN polling effect keyed on the active jid; the main dashboard `loadAll` poll does not refetch the open chat's messages.

## Persist-listener flag propagation gotcha
The persist pipeline is a two-hop listener chain: `UserSession.notifyPersist` → per-session listener → `MultiWhatsAppService.getSession()` bridge listener → global listeners in `chatPersistence`. When you add an arg (e.g. the `history` flag) to `PersistListener`, you must forward it through BOTH hops. The bridge in `getSession()` is easy to miss and silently drops the arg (it becomes `undefined`), defeating the flag.
**How to apply:** any new field on a listener signature must be threaded through every relay closure, not just the emit site.

## Real media rendering — download + serve, don't store inline in chat payload
Media (photo/voice/video/doc) shows as a placeholder unless you actually `downloadMediaMessage` (Baileys) in BOTH the live `messages.upsert` and the `messaging-history.set` handlers. Store the bytes as base64 in `wa_messages.media` (+ `mediaMime`/`mediaKind`/`fileName`). Cap downloads (8MB) and pass `reuploadRequest: sock.updateMediaMessage` so expired media can be re-fetched. The chat-list/messages query must EXCLUDE the base64 blob (return only `hasMedia` + meta) and serve bytes lazily from a dedicated `/media/:msgId` route, or every poll drags megabytes.
**Why:** inlining base64 in the messages list response makes polling huge and slow; placeholder-only happens when the download step is skipped.

## Media route auth via `?t=` token is required for <img>/<audio>/<video> src
Browser media tags can't send an Authorization header, so the media serve routes accept the bearer token as `?t=` query param (mirrors the existing events/SSE route pattern) and set it as the auth header server-side. Known tradeoff: token leaks via logs/history; acceptable here because it's a single-panel-user (PANEL_USER_ID=1) monitoring app. If scope ever becomes multi-user, switch to short-lived signed media URLs AND scope `getMediaById` by owner/jid (currently fetches by global waMessageId — brittle IDOR if scope expands).

## Backup restore must map EVERY persisted column
Backup export uses `select().from(waMessagesTable)` (all columns), but restore re-maps fields explicitly — so any NEW column (e.g. media/mediaMime/mediaKind/fileName) is silently dropped on restore unless added to the restore mapping too.
**How to apply:** whenever you add a `wa_messages` column, update the restore `.map()` in `panel.ts` in lockstep, or restored media/data vanishes.

## Media download must be non-blocking, and its backfill must not re-count unread
In the live `messages.upsert` handler, do NOT `await downloadMediaBase64` before `upsertMsg` — that delays (and if it throws, drops) the message, killing the real-time feel. Instead upsert the placeholder immediately, then download in the background and re-`upsertMsg({...chatMsg, media})` to backfill. CRITICAL: pass `history=true` on that backfill call, otherwise the second persist increments `wa_chats.unread` a SECOND time (persistMessage bumps unread whenever `!history && !fromMe`, and it can't tell a correction from a new message) → inbox badges inflate by 2 for every inbound media message.
**Why:** the user reported messages felt slow/not-updating after media was added; the blocking await + double-count were the cause.

## Never log the panel user out on transient errors
`useRequirePanelAuth` (and polling catch handlers) must only clear the token + redirect to /login on a genuine **401/403**. The panel token is a deterministic HMAC with NO expiry, so it's valid until the password changes. A network blip or API restart makes `/panel/me` reject — clearing the token there logs the user out spuriously. `panelApi.handle()` attaches `err.status`; gate logout on `err.status === 401`. On other errors keep the session (optimistic `setUser`).
**Why:** user explicitly wants the session to persist "even a year" until they delete authorization.

## In-app back button must not depend solely on pushed history
Chat-open pushes `history.pushState({scChat}, "")`; the ◀ button checks `window.history.state?.scChat` and uses `history.back()` if present, else closes directly (`setActiveJid(null)`). Without the fallback, if the entry wasn't pushed, `history.back()` navigates the real history (e.g. to /connect) instead of returning to the chat list — exactly the bug the user hit.

## Default theme = authentic WhatsApp WHITE-GREEN (`:root` light palette)
User explicitly wanted real WhatsApp white+green colors/styles, NOT a dark theme. Achieved by removing `class="dark"` from `index.html` so the existing `:root` light palette (white bg, green `#00a884` / `--wa-header: 168 100% 33%`) applies. `:root` was already authentic WhatsApp — the only change needed was dropping the forced `.dark`. Keep `theme-color` meta green. Do NOT reintroduce a dark default.

## VIP theme is an additive opt-in skin, never a replacement
The default look (now WhatsApp white-green `:root`) must stay untouched. VIP is added by also putting a `vip` class on `<html>`; `index.css` `.vip` block must come AFTER `.dark`/`:root` so its overlapping CSS vars win the cascade. `.vip` defines a FULL self-contained palette so it works regardless of whether `.dark` is present. State lives in localStorage `wa_theme_vip`, applied by `applyTheme()` in `main.tsx` before render (avoids flash). Toggles exist in BOTH user Settings and admin header. `clearCache()` in settings must EXEMPT `wa_theme_vip` (it otherwise matches the `wa_` purge prefix and silently resets the theme).
**Why:** user said "Sirf VIP theme add karo, baaki rehne do" — add VIP only, keep the rest.

## Connect-first flow (WhatsApp-Web style) — guard against redirect ping-pong and the disconnect trap
chats.tsx redirects to `/connect` when WA isn't connected, but ONLY after the first real status fetch (a `connChecked` flag, avoids a flash) and NEVER while a conversation is open (`activeJid`). connect.tsx auto-navigates to `/` ONLY on a fresh link: track the FIRST observed status in a `firstConnected` ref (null→set on first fetch); auto-redirect only when `firstConnected.current === false && connected`. If you redirect whenever `connected`, a user who opens Connect on purpose to disconnect gets yanked away and can never disconnect. Keep a manual "Open Chats" button as the flaky-network fallback.

## Spurious logout root cause = unordered single-row token lookup
Panel token = HMAC(SESSION_SECRET, `panel:userId:passwordHash`); secret has a stable constant fallback so it's NOT the cause. The real bug: `getUserFromToken` fetched the panel user with `db.select().limit(1)` UNORDERED. Once a 2nd row exists (a pending signup), that picks an arbitrary/wrong user, the HMAC compare fails → 401 → client logs out. Fix: iterate ALL panel users and match each. **Rule:** any token whose verification depends on a DB row must look up the RIGHT row (decode an id or iterate), never an unordered `limit(1)`.

## Chat opens at the top, not the last message = UNBOUNDED scroll container
`getChatMessagesDb` is `asc(ts)` so order is correct; JS scroll-to-bottom alone is NOT enough. Root cause was the Conversation root div using `min-h-screen` — the parent grows past the viewport so the PAGE BODY scrolls, the inner `flex-1 overflow-y-auto` pane never gets a bounded height, and `scrollRef.scrollTop = scrollHeight` is a no-op. Fix: pin the conversation root to `h-[100dvh]` (fixed viewport height) so the inner div is the real scroller. **Rule:** a `flex-1 overflow-y-auto` child only scrolls if an ancestor has a FIXED height (`h-screen`/`h-[100dvh]`), never `min-h-screen`. Pair with: jump to bottom on first open (`didInitialScroll` ref reset on `jid`), near-bottom gate on poll refresh, `requestAnimationFrame` before setting scrollTop.

## Phone-sent (WhatsApp→WhatsApp) messages need Baileys `append`, not just `notify`
`messages.upsert` fires with `m.type`: `notify` = brand-new live message arriving here; `append` = messages added from ELSEWHERE, **including the messages you send from your own phone**. A handler that does `if (m.type !== "notify") return;` silently drops all phone-sent outgoing → they never appear in the panel. Fix: accept both; `isLive = m.type === "notify"`; call `upsertMsg(jid, m, display, !isLive)` so `append` is treated like history (persisted + updates lastMsg/lastMsgTs, but no unread inflation); gate incoming-routing (`incomingKeys` + `notifyMsg`) on `!fromMe && isLive`. Dedup is safe (id-based merge + DB `onConflictDoUpdate`). Edge case (low-prob): a genuinely-new INCOMING as `append` won't bump unread/route.

## Live message sync ALSO depends on a PERSISTENT deployment (Baileys websocket)
Even with the `append` fix, in the PUBLISHED app Baileys holds a long-lived websocket + local `.user-sessions` auth files, which autoscale tears down/spins between instances → fresh messages stop. Must deploy as a Reserved VM (single always-on instance). Polling in dev (`/panel/chats` 4s, open conversation 3s) works fine locally.

## Pairing code generates but doesn't link = environmental, not code
Baileys is already latest (`7.0.0-rc13`) and the connectPhone pattern is sound. If a pairing code shows but the phone never links, it's WhatsApp-side (account linked on too many devices, or a stale/"Bad MAC" session), not a bug to chase in code. Guard the request with `if (sock.authState.creds.registered) return;` before `requestPairingCode`. Advise the user to try QR once as a diagnostic and to ensure the number isn't over-linked.

## Custom-branded pairing code IS supported by Baileys (not a hack)
`requestPairingCode(phoneNumber, customPairingCode?)` accepts a second arg: a custom code that REPLACES the random one (so the OTP can spell a brand, e.g. `HASANALI`). Baileys only validates `length === 8` (no charset check); WhatsApp accepts A-Z/0-9. This is how "Axiom"-style bots show their channel name in the official pairing code. Stored editable in `app_settings.pairing_brand_code` (default `HASANALI`, NOT NULL), normalized to 8 `[A-Z0-9]` chars; threaded route→`multiWA.connectPhone(userId,phone,brand)`→`UserSession.connectPhone`→`requestPairingCode(phone, brandCode)`; falls back to random only when brand isn't exactly 8 chars. `PUT /panel/settings` 400s on a present-but-not-8 value (no silent no-op).
**Why:** user saw another bot do it and wanted the same; it's an official Baileys feature, not an exploit.
Also editable from ADMIN side via `GET/PUT /admin-panel/pairing-code` (requireAdmin; same 8-char [A-Z0-9] normalization+validation as the user route). Both routes write the same singleton `app_settings` row (id=1) — keep validation in sync if one changes. This does NOT break "admin is monitoring-only": that rule is specifically about *sending WhatsApp messages*; settings edits are allowed.

## Anti-delete: keep the ORIGINAL content, only flag the revoke
A "delete for everyone" must NOT overwrite the stored text/media with a placeholder — the whole point of the monitoring panel is to recover what was deleted. A revoke arrives as a Baileys `protocolMessage` with `type === 0` (REVOKE); its `key.id` points at the original message. On revoke: set `deleted=true` + `deletedAt` only, never touch text/media. The revoke envelope itself must be SKIPPED (never persisted) or it stores as a junk "Media" row. Detection must UNWRAP first (`unwrapMessage`) because the revoke can be wrapped in deviceSent/ephemeral. The `wa_messages` `onConflictDoUpdate` text uses `CASE WHEN deleted OR isDeleted THEN keep ELSE new` so a delete marker is never clobbered by a later re-sync.
**Why:** user's headline feature — see deleted messages' real content.

## Anti-delete timing: revoke can arrive before the original is persisted
`markDeleted(id)` is a bare `UPDATE ... WHERE wa_message_id=id` — a no-op if the row isn't stored yet (out-of-order delivery / history sync). Fix: keep an in-memory `pendingDeletes` Set in chatPersistence; `markDeleted` adds the id to it AND runs the UPDATE; `persistMessage` computes `isDeleted = msg.deleted || pendingDeletes.has(msg.id)` so a later-arriving original is written as already-deleted. **Rule:** any "flag by id" that can race its target insert needs a pending-tombstone, not just an UPDATE.

## View-once / once-more media: download the UNWRAPPED message
View-once pics download as nothing unless you pass the unwrapped payload to `downloadMediaBase64`: use `{ key: msg.key, message: parsed.raw }` (parseWAMessage already returns the unwrapped `raw`) in BOTH the live `messages.upsert` and history-sync download calls. Passing the raw envelope makes Baileys fail to locate the media node. Persisted base64 in `wa_messages.media` makes it permanent (survives the WhatsApp "view once" consumption).

## Per-account view: tag each chat with the connected number (first-owner)
`wa_accounts` (phone PK, first/last_connected_at, connect_count) is upserted via `recordAccount` whenever a session reaches `connected` with a phoneNumber (wired through `multiWA.addGlobalListener` in startPersistence). Each `wa_chats` row is tagged `account_phone` from `getSessionInfo(PANEL_USER_ID).phoneNumber` at persist time, using `COALESCE(existing, current)` = FIRST owner wins. Admin "Connected Numbers" view filters chats client-side by `accountPhone`. 
**Known limitation (accepted):** chats are keyed by `jid` only, so if two DIFFERENT connected numbers (re-paired SIM over time) both chat with the SAME contact jid, that one chat stays under whichever number talked first — true separation would need a composite `(account_phone, jid)` key + full persistence/hydrate/media refactor. Deliberately NOT done: single-session monitoring panel, shared-contact-across-SIMs is rare, and the refactor is high-risk on a working app. Revisit only if the user reports actual cross-account mixing.

## Show EVERYTHING: groups (@g.us) + status (status@broadcast), not just individuals
`parseWAMessage` historically dropped anything not ending in `@s.whatsapp.net` (groups + status filtered out). To show all chat types, accept `@s.whatsapp.net` OR `@g.us` OR `status@broadcast` in parseWAMessage AND relax the `messages.update` status-tick filter (was also `@s.whatsapp.net`-only) to any non-empty jid. The `messaging-history.set` unread/name capture must also stop being individual-only.
**Why:** user wanted the panel to mirror real WhatsApp — groups, status/stories, and chat-locked numbers all visible.

## Readable chat titles need a name pipeline (groups have NO name on the message)
Individual chats: `msg.pushName` (only on incoming, `!fromMe`). Status: literal "Status". Groups: the subject is NOT on the message — fetch async via `sock.groupMetadata(jid).subject`, cache the jids already fetched (a Set) so you don't refetch, and re-emit a persist so the new name lands in the DB. History sync also carries chat titles in `h.chats[].name/subject` — prefer those. Thread the name through the SAME two-hop persist chain as the `history` flag (notifyPersist → per-session listener → getSession bridge → global listener → persistMessage), then upsert `wa_chats.name` with `COALESCE(new, existing)` so a known name is never wiped by a later nameless message.
**Why:** without this, groups show the raw `…@g.us` id and status shows a number.

## Instant updates = SSE stream, polling demoted to a slow safety net
User's most-emphasized ask was INSTANT background updates. The panel uses a Server-Sent-Events endpoint that registers the same persist/delete/state listeners the DB persister uses, and the frontend drives refreshes off one EventSource (debounced) with the open conversation reloading on a tick counter; polling stays only as a slow fallback. Two rules that bite: (1) EventSource can't set an Authorization header, so the token rides as a `?t=` query param (same tradeoff as the media route); (2) EVERY listener you register on the SSE connection plus the heartbeat interval MUST be torn down on `req.on("close")`, or each reconnect leaks a listener.
**Why:** without SSE the inbox only updated on a multi-second poll, which the user explicitly rejected.
**Caveat:** like live capture, this only works on a persistent deployment (Reserved VM) — autoscale tears down the Baileys socket between instances.

## OTP/pairing-brand editor is ADMIN-ONLY now
The pairing-brand code card was REMOVED from user `settings.tsx` (and its 8-char validation + the field stripped from the PUT payload via destructure). The admin route (`GET/PUT /admin-panel/pairing-code`) stays — that's the only place to edit it. Consistent with monitoring-only = sending only; settings edits allowed on admin.

## Theme system generalized from boolean VIP → named themes (back-compat preserved)
The theme store moved from a boolean VIP flag to a named-theme id, but the old `isVip`/`setVip` API is KEPT as thin wrappers because the admin dashboard header VIP toggle still calls them — and the new getter migrates the legacy boolean key while the setter keeps it in sync, so neither side breaks. Each non-default theme must be a FULL self-contained palette block in `index.css` placed after `.vip` (it has to redefine the whole var set incl the `--wa-*` chat surfaces, not just `--primary`, or surfaces fall back to the default and look broken). Gotcha that silently resets the theme: the settings "clear cache" purge matches the `wa_`-prefixed localStorage keys, so it MUST exempt every theme key.
**Why:** user kept asking for more VIP skins; generalizing beat adding more booleans, but the admin toggle and the cache-clear purge are the two things that quietly break.

## TS project references serve stale types after a schema change
`artifacts/api-server` consumes `@workspace/db` via TS project references (reads its built `.d.ts`). After editing `lib/db` schema, `drizzle-kit push` updates the DB but NOT the declarations — api-server typecheck then errors that new columns "do not exist". Run `npx tsc -b lib/db` to rebuild declarations before typechecking the api.
