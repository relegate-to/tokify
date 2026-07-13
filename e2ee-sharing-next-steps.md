# E2EE Sharing — Next Steps

Status and plan for the remaining work after the **capability link-shares
backend** landed (branch `feat/e2ee-link-shares`). Read the design docs first:
[`e2ee-sharing-plan-v2.md`](e2ee-sharing-plan-v2.md) (accounts/teams) and
[`e2ee-sharing-link-shares.md`](e2ee-sharing-link-shares.md) (accountless links).

---

## 1. Where things stand (notes)

**Done — the data + ops + link backend (Go, no UI):**

- v2 accounts/teams: crypto core (`internal/integrations/neonsync/sharing/`),
  schema + RLS (`sharing_schema.sql`), and the ops layer (`sharing_client.go`,
  `sharing_service.go`, `sharing_reconcile.go`). Service methods exist for
  `CreateAudience`, `AddMember`, `RemoveMember`, `SetShareFilter`,
  `RevokeGrant`, `Approve/RejectContribution`, and the shared read path
  `ListSharedEntries`.
- Link shares: `sharing_link.go` (+ `SECTION 6` of `sharing_schema.sql`). Public
  methods `CreateLinkShare`, `RevokeLinkShare`, `ListLinkShares`. Each link is
  its own dedicated audience frozen at epoch 1 with a synthetic member; a
  `sharing_link_fetch` `SECURITY DEFINER` RPC is the only door for the anonymous
  role; a KEK-encrypted trust bundle carries the sender's signing pubkey so a
  holder can verify author signatures.
- Verified: `gofmt`/`go vet`/`go build` clean, 55 Go tests pass, full RLS SQL
  suite green on a local PG. **Not yet run in the pinned Docker images**
  (`make test` / `make linter`) — do that before merge.

**Not done / blocking for anything user-facing:**

- **No Wails bindings for sharing.** `cmd/tock-desktop/app.go` binds `neonSync`
  and exposes only *sync* (`SyncStatus`, `SyncSetEnabled`, `SyncNow`, unlock/…).
  None of the audience/link methods above are exposed to the frontend yet.
- **No web viewer** for recipients/invitees. None of the crypto exists in a
  browser today.
- **Platform check owed:** confirm `allowAnonymous` is enabled on the Neon
  project and that an anonymous token can `EXECUTE` `sharing_link_fetch`
  (§9 of the link-shares doc). This is the one unverified dependency and gates
  the whole viewer.

**Frozen wire contracts** the viewer must reproduce byte-for-byte (any drift =
silent decrypt failures). All live in `internal/integrations/neonsync/`:

- Argon2id params (`crypto.go`): time=3, memory=64 MiB, threads=4, keyLen=32;
  `DeriveKEK(password, salt_enc)` where the "password" for a link is
  `base64.StdEncoding(HKDF(S, "tokify-link-readability-v1"))`.
- Link token: `hex(HKDF(S, "tokify-link-visibility-v1"))`; `token_hash =
  hex(sha256(token_bytes))`; fragment secret S is 16 bytes, base64url (no pad).
- Sealed box `SealTo`/`OpenSealed` (`sharing/sharing.go`): X25519 + HKDF-SHA256
  (info `tokify-share-seal-v1`, salt = ephPub‖recipientPub) + XChaCha20-Poly1305,
  zero nonce, wire = `ephPub(32)‖ciphertext`.
- Canonical AAD/sig JSON shapes and domain strings (`sharing/payloads.go`,
  `sharing/sharing.go`): `EntryAAD`/`GrantAAD`/`EpochKeyAAD`, entry/grant/epoch
  signing domains, `DeriveEntryDEK` (`tokify-entry-dek-v1:<id>`), fingerprint
  format (`sharing/identity.go`).

---

## 2. Web app — view a shared link, accept a team invite, open the desktop app

A small hosted app served at `…/share/<audience-id>#<S>` (links) and an
invite route for teams. It is a **read/decrypt client**, plus a launcher into
the desktop app. The server must stay unable to read anything.

**2a. Crypto in the browser (the big decision, do this first).**
Pick one and prove a round-trip against a Go-produced fixture before building UI:

- **Go → WASM** — compile the `sharing` package (+ the link derivation) to WASM
  and call it from JS. Lowest risk of wire drift (same code), larger bundle,
  needs a thin JS↔WASM shape. *Recommended* given how many frozen contracts
  there are.
- **JS/TS reimpl** — `@noble/*` (ed25519, curves, hashes) + `hash-wasm`
  (argon2id) + an XChaCha20-Poly1305 impl. Smaller bundle, but every constant
  above must be re-derived exactly; budget real time for byte-compat tests.

Ship a shared test vector (a Go test that emits a fixture JSON; a JS/WASM test
that decrypts it) so the contract can't silently rot.

**2b. Link-viewer flow** (accountless, from `e2ee-sharing-link-shares.md §6`):

1. Read `S` from the URL **fragment** (never sent to the server).
2. Acquire a Neon `allowAnonymous` token; POST `/rpc/sharing_link_fetch` with
   `link_token = hex(HKDF(S,"tokify-link-visibility-v1"))` (+ `p_limit`/`p_offset`
   for paging).
3. From the returned ciphertext: `DeriveKEK` → `UnwrapIdentity` →
   `UnwrapEpochKeyForMember` → `UnwrapDEKFromEpoch` → `DecryptEntryPayload`.
4. Open the trust bundle under the KEK → verify each entry's `author_sig`
   against the sender's signing pubkey. (Holders do **no** epoch-chain check and
   never typed a password — see the threat model in §7.)
5. Render the slice (read-only). Handle: unknown/expired/revoked token → RPC
   returns `null`; empty slice; paging.

**2c. Team-invite acceptance flow** (account holders, from
`e2ee-sharing-plan-v2.md`). This one is **not** accountless — it needs a real
identity and the §9 fingerprint exchange:

- Invitee signs in / provisions their identity (`identities` row + wrapped
  identity), then the admin runs `AddMember` (pin-verified pubkey) to wrap the
  epoch key to them. Decide how the invite link carries the audience id and how
  the two sides do the out-of-band fingerprint verification the plan mandates —
  don't skip it (a link invite is not a substitute for §9 pinning).
- After acceptance, reads go through the normal member path
  (`ListSharedEntries`), not the link RPC.

**2d. "Open the app".** Deep-link back into Tokify (custom URL scheme registered
by the desktop app, or a download/open CTA) so an invitee who accepted in the
browser lands in the native app. Needs a URL scheme handler wired in
`cmd/tock-desktop/main.go` and a route on the web side.

---

## 3. Creation UI — make a team, or a link for a project/filter

Most of this is **already designed** (Sam's mockups). Remaining work is wiring
the existing Go methods to the frontend and dropping the designed UI on top.

**3a. Expose sharing over Wails** (`cmd/tock-desktop/app.go`). Add thin
Wails-bound wrappers — same pattern as the existing `SyncStatus`/`SyncSetEnabled`
methods (nil-guard `a.neonSync`, forward, return typed structs) — for:

- Links: `CreateLinkShare(projects, sinceDays, validForHours) → {audienceID,
  secret}`, `ListLinkShares()`, `RevokeLinkShare(audienceID)`.
- Teams: `CreateAudience()`, `SetShareFilter(audienceID, projects, sinceDays)`,
  `AddMember(...)`, `RemoveMember(...)`, `RevokeGrant(...)`,
  `Approve/RejectContribution(...)`, and a viewer for `ListSharedEntries()`.

Keep business logic in `internal/` (CLAUDE.md) — `app.go` stays a forwarding
surface. Then regenerate bindings (`wailsjs/go/main/App`) — never hand-edit.

**3b. Build the create surface** (`cmd/tock-desktop/frontend/src`). From the
designs: pick a project and/or a time filter (maps to the `{projects[],
since_days}` share filter, `filter.go`), choose **link** vs **team**, set an
optional expiry (default a bounded `valid_until` for links — §8), then:

- Link → call `CreateLinkShare`, show the `…/share/<id>#<secret>` URL with a
  copy button and the "treat like a password / it self-expires" caveat (§7).
- Team → `CreateAudience` + `SetShareFilter`, then an add-members panel driving
  `AddMember` with the fingerprint-verification step surfaced (§9).

**3c. Manage/revoke.** A list of active links/teams (`ListLinkShares` /
`getAudiences`) with revoke actions (`RevokeLinkShare` deletes the audience and
cascades; team revocation is `RemoveMember`/`RevokeGrant`). Use the
`frontend-design` skill for the visual pass and match the app's calm/tactile
aesthetic (see CLAUDE.md frontend guidelines).

---

## Suggested order

1. Confirm `allowAnonymous` on Neon (unblocks 2). — *cheap, do now*
2. Wails bindings for sharing (3a) + creation UI (3b/3c) against the working
   backend — ships the *sender* experience end-to-end with no new crypto.
3. Browser crypto decision + fixture round-trip (2a).
4. Link viewer (2b), then team-invite acceptance + deep-link (2c/2d).
