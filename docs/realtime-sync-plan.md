# Realtime Timer Sync and Push — Plan

## Status (September 2026)

Draft. Phase 1 is implemented in the repository; its migration still has to be
applied to the live Neon project. Phases 2–4 are not started.

**Problem:** the running timer never leaves the device it started on.
`SyncNow` pushes only completed activities, every 5 minutes
(`internal/integrations/neonsync/service.go`, `cmd/tock-desktop/app.go`), and
shared entries reach other members by polling (`App.tsx`,
`SHARED_POLL_ACTIVE_MS`). That is fine for history, but not for a mobile app
that must show a timer started on the desktop, or remind you it is still
running after you walk away.

**Goal:** one running timer per user, visible live on every device, with push
to phones that are not open. Keep Neon as the only backend. Keep end-to-end
encryption: the server, Google and Apple see ciphertext and opaque ids only.

**Platforms:** macOS now; Windows, Linux, iOS and Android planned.

**Delivery, two mechanisms only:**

1. **Live connection** — every running app (all desktops, mobile while
   foregrounded) holds one SSE/WebSocket connection to a Neon Function.
2. **FCM push** — only for mobile apps that are backgrounded or closed. FCM
   covers Android and relays to APNs for iOS. iOS may need a direct APNs call
   for Live Activities (verify in Phase 3).

The server side is a single `notify(user, event)` that writes to the user's
open connections and pushes to their unconnected mobile devices. Nothing else
knows how delivery works.

---

## Phase 1 — Enforce invite acceptance in the sharing schema

Independent of the rest; do it before the mobile app widens the user base.

**Hole:** `audience_members.status` defaults to `'active'` and the admin branch
of `audience_members_insert` does not constrain it, and the update guard
trigger exempts admins entirely. An admin can therefore add someone as
`active` without consent (or invite and then flip them). The victim's
`reconcileAudiences` then grants every entry matching the admin-chosen filter.
Epoch pinning limits this to users the victim has already pinned, i.e. anyone
they have shared a team with before.

**Work:**

- `sharing_schema.sql`: admin inserts must use `status = 'invited'`; only the
  creator's bootstrap self-row may insert `'active'`. Only the member may move
  their own row to `'active'`, admins included.
- `entries_guard_admin_update`: forbid `user_id` changes for everyone, not just
  non-authors (an author who is a grant admin can currently reassign an entry).
- Client: reconcile only into audiences this account created or explicitly
  accepted (record acceptance locally, sync it in the pins blob).
- `scripts/sharing-rls-test.sql`: cases for forced-active insert, admin status
  flip, and `user_id` reassignment.
- Apply the migration to the live Neon project (owner step), then
  `NOTIFY pgrst, 'reload schema'`.

---

## Phase 2 — Live timer sync on desktop

### 2a. Spike: Neon Functions as the live connection (about a day)

Throwaway code in `spikes/neon-push/`. A Neon Function that verifies a Neon
Auth JWT against the project JWKS and serves an SSE stream, with each isolate
polling Postgres every 1–2s for changed timers and forwarding to its local
clients (Neon's recommended pattern; `LISTEN/NOTIFY` would force always-on
compute on the paid plan). A small Go client connects to it.

Answer before building for real:

- Does an open connection count against the 100 concurrent-invocation
  account limit, and can Neon raise it?
- What does always-on compute cost once desktops stay connected?
- Reconnect behavior across isolate eviction and the 15-minute heartbeat.

**Fallback:** if the limits are unworkable, keep Neon for data and auth and
move only the live connection to a dedicated service. Clients take the
endpoint from build flags, so this is a config change.

### 2b. Running-timer record

- `running_timers` table, one row per user: entry id, start time, `version`,
  encrypted `{description, project, tags}` under the account DEK, and the
  device that started it. RLS scopes it to the owner.
- Function endpoints `POST /timer/start` and `/timer/stop`: verify the JWT,
  apply the change with a version check in a transaction (the one-timer
  invariant), then `notify`.
- Conflict rule for a start while another device is running: **undecided**
  (stop the other device's timer vs. prompt).
- Stopping writes the completed entry through the existing sync path so Neon
  history is unchanged.

### 2c. Desktop client

- Sync client in `internal/` (not `cmd/tock-desktop`, which is
  `//go:build darwin` throughout) so it compiles for Windows and Linux.
- Start and stop in `app.go` go through the timer API when signed in; incoming
  events update local state and call `refreshTrayTitle`. Offline, fall back to
  local-only and reconcile on reconnect.
- The shared-entries poll can later ride the same connection as a
  "team changed" event feeding the existing delta read.

### 2d. Windows and Linux desktop

A port, not part of the sync work: tray, menu bar mode, window chrome and
build tags in `cmd/tock-desktop` are macOS-specific today. Scope separately;
it only depends on 2c living in `internal/`.

---

## Phase 3 — Push notifications

Prerequisites (owner): Firebase project, Apple Developer account, APNs key
uploaded to Firebase.

- Spike first: confirm outbound FCM (and APNs, if needed) from a Neon
  Function; confirm whether FCM can start and update iOS Live Activities.
- `push_devices` table: device token, platform, owner, last seen; RLS to the
  owner; registration and removal endpoints.
- `notify` pushes to the user's mobile devices with no open connection.
  Payloads carry ids and timestamps only, never titles.

---

## Phase 4 — Mobile apps

- Stack: **undecided** (native vs. cross-platform); decides how Live
  Activities and widgets are built.
- Sign-in with email/password or OTP against Neon Auth, matching desktop.
  Neon Auth has no Sign in with Apple; App Store rule 4.8 does not require it
  without third-party login. If social login becomes required, self-hosting
  Better Auth against the existing `neon_auth` schema is the exit (verify
  schema compatibility first).
- Unwrap the account DEK with the password-derived key, as desktop does, so
  the phone can decrypt the timer record.
- iOS: a Live Activity for the running timer; the widget reads the title from
  the app's own decrypted cache. Local notifications for "still running"
  reminders, scheduled on-device when a timer starts.

---

## Open decisions

- Conflict rule when two devices start timers.
- Mobile stack.
- Whether Windows/Linux desktop ships before or after mobile.
