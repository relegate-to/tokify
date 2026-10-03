# Realtime Timer Sync and Push — Plan

## Status (October 2026)

Draft. Phase 1 is implemented in the repository; its migration still has to be
applied to the live Neon project. The Phase 2a spike is done and dropped the
live connection (see 2a). Phases 2b and 2c are implemented (`internal/integrations/neonsync/running.go`, `internal/app/timersync`); 2d–4 are not started.

**Problem:** the running timer never leaves the device it started on.
`SyncNow` pushes only completed activities, every 5 minutes
(`internal/integrations/neonsync/service.go`, `cmd/tock-desktop/app.go`), and
shared entries reach other members by polling (`App.tsx`,
`SHARED_POLL_ACTIVE_MS`). That is fine for history, but not for a mobile app
that must show a timer started on the desktop, or remind you it is still
running after you walk away.

**Goal:** one running timer per user, visible on every device, with push to
phones. Keep Neon as the only backend. Keep end-to-end encryption: the server,
Google and Apple see ciphertext and opaque ids only.

**Platforms:** macOS now; Windows, Linux, iOS and Android planned.

**Delivery, one push mechanism:**

1. **FCM push to phones** — the only thing we deliver. A backgrounded or
   closed phone app can only be reached through APNs/FCM, so this is needed
   whatever else exists. FCM covers Android and relays to APNs for iOS. iOS
   may need a direct APNs call for Live Activities (verify in Phase 3).
2. **Everything else reads the row.** Phones read `running_timers` when a push
   arrives or the app opens. Desktops read it on the polls they already run
   (10–30s while the window is visible, the 5-minute sync otherwise) and when
   the tray menu opens.

The server side is a single `notify(user, event)` that pushes to the user's
phones. Nothing else knows how delivery works.

**Later:** Neon is building native realtime sync on Electric (announced
September 2026, no date; alpha sign-up via the Neon Discord). When it ships
with scale-to-zero support, subscribe desktops and foregrounded phones to
their `running_timers` row and drop the desktop poll for it. Push to phones
stays.

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

## Phase 2 — Running timer on every device

### 2a. Spike: Neon Functions as the live connection (done, rejected)

Deployed an SSE Function (Neon Auth JWT checked against the project JWKS,
per-isolate Postgres polling) to a throwaway branch on 2026-10-01 and drove it
from a Go client. Results:

- Every open stream holds a concurrency slot. The account-wide cap was exactly
  200, and once full every request on the account got 429, writes included.
- Each stream occupied its own isolate, so per-isolate polling saved nothing:
  one query per device every 1.5s, and about $18 per connected device per
  month in Function compute (Launch waiting rate).
- Client disconnects never reached the handler (no stream `cancel()`, no
  request abort); zombie streams lived until the server closed them at JWT
  expiry.
- Polling or `LISTEN/NOTIFY` keeps Postgres awake while any desktop is
  connected.
- Neon has no database-change Function Trigger (only cron and object
  storage).

Conclusion: no live connection. Desktops poll; phones get push (see Delivery).

### 2b. Running-timer record

- `running_timers` table (`schema.sql`), one row per user: a `version` and
  the timer as ciphertext under the account DEK — description, project,
  notes, tags, start, end and the starting device's id. Times stay inside the
  ciphertext, like `entries`. The AAD binds owner and version, so the server
  cannot relabel an old timer as current. RLS scopes it to the owner; a
  trigger makes `version` advance by exactly one; no deletes.
- The row is never cleared: a stop keeps the timer with its end time, so a
  device still showing it as running closes its copy at the same instant and
  both completed entries hash to the same id.
- Start and stop go through the Data API: one row per user gives the
  one-timer invariant, and a version-checked update (`version=eq.N`) catches
  two devices racing.
- Starting while another device's timer is running behaves as it does
  locally: the running timer is visible on every device, and a start stops it
  at the new start time. If two devices race inside one poll window, the
  loser's version check fails; it re-reads the row and applies the same
  stop-then-start.
- Stopping writes the completed entry through the existing sync path so Neon
  history is unchanged.

### 2c. Desktop client

- Sync client in `internal/` (not `cmd/tock-desktop`, which is
  `//go:build darwin` throughout) so it compiles for Windows and Linux.
- Start and stop in `app.go` write the row when signed in. The row is read on
  launch, on the existing shared-entries poll and 5-minute sync, and when the
  tray menu opens; a change updates local state and calls `refreshTrayTitle`.
  Offline, fall back to local-only and reconcile on reconnect.
- `timersync` compares the record, the local running activity and the last
  state this device agreed with (`timersync.json`). That also publishes
  timers started from the CLI or MCP server, and stops made while offline.
  The timer reconciles before each entry sync, so a peer's stop closes the
  local copy before the pull could add a minute-rounded duplicate.
- Known edge: if one device stops a timer while another starts a new one
  inside the same poll window, the stopped timer can end up with two slightly
  different end times on the two devices.

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
- `notify` is a short Neon Function the app calls after a start or stop; it
  pushes to the user's phones. Payloads carry ids and timestamps only, never
  titles.

---

## Phase 4 — Mobile apps

- Stack: **React Native on Expo** in `mobile/` (decided October 2026), to
  share the desktop's look, TypeScript types and React logic. The look carries
  over through react-native-reusables (shadcn for React Native, on NativeWind)
  fed the desktop's design tokens. Live Activities and widgets still need
  native Swift alongside. Native folders are generated (`expo prebuild`), not
  committed.
- Order of work:
  - **4a. Crypto parity** (done): `mobile/src/crypto` ports the sync crypto
    and checks itself against `internal/integrations/neonsync/testdata/
    crypto-vectors.json`, which the Go tests generate and verify. Argon2id is
    native (`react-native-argon2`) because the desktop uses four lanes, which
    libsodium cannot reproduce.
  - **4b. App shell**: Expo Router, NativeWind, reusables, desktop tokens.
  - **4c. Sign-in and unlock**: Neon Auth with the derived auth hash, DEK
    unwrapped and kept in the secure store.
  - **4d. Running timer**: read, start and stop through `running_timers`,
    keeping the exact start string so desktops still recognise the timer.
  - **4e. History**: read own entries; push completed ones so a timer started
    and stopped on the phone reaches the cloud without a desktop.
  - **4f.** Push (Phase 3), the iOS Live Activity and reminders.
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

- Whether Windows/Linux desktop ships before or after mobile.
