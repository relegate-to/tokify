# E2EE Link Shares — One-Off Recipients Without an Account

**Status:** design. Everything else in [`e2ee-sharing-plan-v2.md`](e2ee-sharing-plan-v2.md)
is implemented; this is the one remaining piece.

**Problem:** the v2 plan assumes every recipient is an account holder. Both planes
demand it — the visibility plane gates every read on `member_id = auth.user_id()`
(the `sub` from a Neon-validated JWT, `sharing_schema.sql`), and the readability
plane bottoms out at an identity private key wrapped under a **password-derived
KEK** (`sharing/identity.go`, `WrapIdentity`). A one-off recipient — a contract
employer you want to show this month's hours to, once — has **no account, no
email, and no counterpart for the §9 fingerprint exchange.**

**Goal:** let that recipient open a link and read their slice **without weakening
E2EE and without depending on the managed auth platform.** The server must still
be unable to read anything.

**Approach:** a **capability link**, not an account. The recipient is served
through a token-gated RPC against a table we own; the crypto plane is untouched.
This avoids depending on emailless-account support in managed Neon Auth (Better
Auth), which could not be confirmed — the capability model needs only Neon's
documented `allowAnonymous` token.

---

## 1. The core idea

A link share splits into the same two planes as everything else in v2, but each is
satisfied without an account:

- **Visibility** — *may the DB serve these rows to this caller?* Not RLS-on-`sub`
  (there is no `sub`), but a **link-token capability** checked inside one
  `SECURITY DEFINER` RPC against a `link_shares` table we own.
- **Readability** — *can the caller decrypt?* Unchanged from v2: an identity key
  the sender minted, wrapped under a KEK derived from a secret in the URL.

The one line that captures it: **the link is a capability that both opens the door
(RPC) and unlocks the box (KEK) — while the server only ever holds and returns
ciphertext.** Same shape as a "Google Doc link": the URL is the capability; the
data stays server-side, here additionally E2EE so the server can't read it either.

One word of precision on **"recipient"**: throughout this doc it means *whoever
holds the link*. There is one synthetic identity and one token, shared by every
holder — one human or fifty. The read side is stateless, so multiplicity costs
nothing mechanically; what it costs in control (all-or-nothing revocation, URL
residue in chat history) is named in §7.

The critical precision: the link carries **secrets that authorize and unlock, not
the keys themselves.** The wrapped identity keypair lives on the server like every
other member's — opaque. They combine only in the recipient's browser.

---

## 2. Why "just a row in our DB" isn't enough on its own

The tempting shortcut — create an "anonymous account" row and point RLS at it —
does not work, and it's worth stating why so the RPC below reads as necessary
rather than incidental:

**Every RLS check authorizes on `auth.user_id()`** — the `sub` extracted from a
*Neon-validated JWT* (`sharing_schema.sql:277,354`, …). **RLS trusts the token,
not our tables.** A row in a `link_recipients` table is invisible to RLS unless the
caller also presents a JWT whose claim RLS can tie to it — which an accountless
recipient doesn't have. So the capability has to be checked somewhere RLS-on-`sub`
can't reach: inside a function that does its own authorization. That is the RPC.

---

## 3. The mechanism

Reuses the existing `SECURITY DEFINER` + narrow-`EXECUTE` pattern already in
section 2 of the schema (`sharing_schema.sql:257–396`):

1. **Recipient auth = Neon's generic anonymous token** (`allowAnonymous`, a
   documented Neon feature). Role `anonymous`, no per-user `sub`. It is only a
   "may call the function" credential, **not an identity**.
2. **New table `link_shares`** (in our DB): `audience_id`, `token_hash`,
   `valid_from`, `valid_until`, `revoked`, the recipient's **wrapped identity blob
   + salt**, and a **synthetic `member_id`** (a UUID no Neon account backs).
3. **New RPC `sharing_link_fetch(link_token)`**, `SECURITY DEFINER`, `EXECUTE`
   granted to `anonymous`. It: hashes `link_token`, finds a live `link_shares` row
   (`NOT revoked AND now() within [valid_from, valid_until)`), and returns **only
   that audience's ciphertext** — the wrapped identity + salt, the audience epoch
   key for the synthetic `member_id`, and the granted entry payloads.
4. **`anonymous` is granted nothing on the base tables.** The RPC is the only door.
   This is the load-bearing hardening — without it the anonymous token could read
   more than one share's worth of rows.

### One audience per link, frozen at epoch 1

Each link gets its **own dedicated audience**, and the synthetic member is
**never inserted into `audience_members`**. This is load-bearing, not taste —
the rotation machinery hard-fails on a synthetic member from either side:

- If it *were* in the roster, every epoch bump pin-verifies each remaining
  member (`RemoveMember` → `pinnedIdentity`, `sharing_service.go:459,322`) and
  hard-fails without an `identities` row — which the sender cannot create,
  because `identities_insert` RLS is own-row-only (`sharing_schema.sql:575`).
  One live link would brick removing any real member from that audience.
- If it were out of the roster but attached to a *shared* audience, any
  rotation re-wraps the new epoch only to roster members and the link silently
  goes dark.

A dedicated audience dodges both because its roster never changes — the
sender's bootstrap self-admin row and nothing else — so **epoch 1 is the only
epoch it will ever have**. Epochs stay in the data model (grants are wrapped to
epoch keys; that *is* the reuse), but for a link audience the epoch is a frozen
implementation detail and no rotation code ever runs. The write path works
today: the `audience_epoch_keys` insert policy checks only that the *caller* is
an admin (`sharing_schema.sql:700`), not that the target `member_id` is in the
roster.

The cost: two links over the same slice are two audiences, so reconcile writes
each matching entry's grant once per link. For one-off shares, noise.

### The crypto plane is untouched

Only the *visibility* identity changes (from a `sub` to a capability). Everything on
the readability side is the existing v2 machinery, unchanged:

- Sender `GenerateIdentity` → `WrapIdentity` under the link-derived KEK.
- Sender wraps the current epoch key to the new pubkey (`WrapEpochKeyToMember`),
  writing an ordinary `audience_epoch_keys` row keyed by the synthetic `member_id`.
- Reconcile-on-write materializes the audience's grants exactly as for any audience
  (DEK wrapped to the epoch key, not to the member — so grants are shared, and the
  recipient needs only the epoch key to open all of them).

---

## 4. One secret, two derivations

The URL fragment carries a single random secret `S` (≥128 bits). Both halves derive
from it, domain-separated, so the link stays one opaque string:

```
link_token = HKDF(S, "link-visibility")    -> hashed to token_hash; authorizes the RPC
KEK        = DeriveKEK(S_read, salt_enc)    -> unwraps the wrapped identity
             where S_read = HKDF(S, "link-readability")
```

`DeriveKEK` (`crypto.go`) is reused byte-for-byte. **There is no email and no Neon
login to derive** — the anonymous token replaces the login half entirely, so
`DeriveAuthHash` is not on this path at all. That is the whole reason this approach
dodges the §9 account problem.

---

## 5. What the sender does at share-time (all client-side)

1. Roll a random secret `S`; derive `link_token` and `S_read` (§4).
2. Create a **dedicated audience** for this link (§3) whose filter matches the
   slice.
3. `GenerateSalt()` → `salt_enc`; `GenerateIdentity()` → the recipient's keypair;
   `WrapIdentity(id, DeriveKEK(S_read, salt_enc), synthetic_member_id)`.
4. Insert the `link_shares` row: `audience_id`, `hash(link_token)`, validity window,
   wrapped identity + salt, synthetic `member_id`.
5. `WrapEpochKeyToMember(recipientEncPub, epochPriv, …)` → one `audience_epoch_keys`
   row for the synthetic `member_id`. Zero entries touched — the ordinary O(1)
   add-member cost from v2 §4. The recipient's public key is used **in memory
   only and never stored** — nothing ever re-wraps to it (§3).
6. Reconcile-on-write produces the audience's grants (existing path).
7. Build the link: `…/share/<audience-id>#<S>`.

Steps 3 and 5 are the existing provisioning and epoch-wrap code
(`provisionIdentity`, `wrapEpochToMembers`); only the `link_shares` write is new.

---

## 6. What the recipient does on click

1. App loads. `S` sits in the URL **fragment** — never sent to the server.
2. Acquire a Neon anonymous token (`allowAnonymous`) and call
   `sharing_link_fetch(HKDF(S, "link-visibility"))`.
3. From the returned ciphertext: `DeriveKEK(HKDF(S,"link-readability"), salt_enc)`
   → `UnwrapIdentity` → `UnwrapEpochKeyForMember` → `UnwrapDEKFromEpoch` → decrypt
   payloads.

**From step 3 on these are the ordinary member decryption steps** (v2 §6) — but
not the full member read path. The holder has no pin store, so it performs **no
epoch-chain verification and no author-signature check**; rows arrive via the RPC
rather than a per-`sub` RLS `SELECT`, and a human never typed a password or
verified a fingerprint. What the missing checks concede is named in §7.

---

## 7. Threat model and honest costs

Stated plainly, in the v2 spirit of naming what a mechanism does *not* give you:

- **The RPC is a new trusted surface** that bypasses declarative RLS; its
  authorization is *function logic*, not a policy. It must be written carefully:
  store only the token **hash**, constant-time compare, scope strictly to the
  token's `audience_id`, enforce `valid_until` / `revoked`. Blast radius is bounded
  — it only ever returns **ciphertext**, and only for the one audience the token
  names — but it is a larger seam than pure RLS, and its token check *is* the
  security of the whole link feature.
- **`anonymous` must have zero direct privileges on the base tables.** If RLS ever
  grants the anonymous role anything, the RPC stops being the only door. Verify
  this in the migration and in a test.
- **The link is a bearer secret.** Whoever holds the URL *is* the recipient — one
  human or many; there is no distinct identity behind it. So **revocation is
  all-or-nothing per link**, and one holder later upgrading to a real account
  does not retire the link for the rest; per-person control means per-person
  links. And the URL travels: chat platforms, browser history, and unfurl bots
  store it whole (the fragment isn't *sent* in requests, but it *is* stored
  wherever the URL is). "Treat it like a password" understates it — passwords
  aren't pasted into group chats by design. TLS-only, no logging, and prefer a
  bounded `valid_until`.
- **Skipping §9 fingerprint verification is safe *here specifically*** because the
  sender minted both key halves — there is no third party to authenticate. The
  trust reduces to "whoever holds the link."
- **Integrity against a malicious server is weaker than for members.** Link
  holders verify no epoch chain and no author signatures (no pin store). The
  epoch public key is effectively public (it sits in the announcement, whose
  signature the holder can't check) and sealed boxes are sender-anonymous — so a
  malicious server could wrap a forged DEK to the epoch key and serve a
  fabricated entry. Members catch exactly this via pinned author identities;
  link holders can't. Confidentiality is unaffected either way. The cheap fix,
  if wanted: a **KEK-encrypted trust bundle** in the `link_shares` row carrying
  the sender's signing pubkey, letting the holder verify author signatures — the
  server can't tamper with what it can't decrypt. §9 says decide.
- **The fragment is the only copy of `S`** (URL fragments aren't sent in HTTP
  requests). Lose the link and access is gone — no recovery, consistent with the
  v2 §9 "password loss is total loss" posture. Fine for a one-off.
- **Link recipients are a special read path**, not a uniform member — a deliberate
  divergence from v2's one-mechanism ideal, and the accepted price of not depending
  on the auth platform.
- **Server still cannot read.** The wrapped identity, epoch key, and payloads are
  opaque; `S` never reaches the server. E2EE is unchanged — this adds a
  credential-delivery and a ciphertext-delivery channel, not a plaintext one.

---

## 8. Revocation

Simpler than member revocation, because there is no member:

- **Cut the link, instantly:** set `revoked` (or an elapsed `valid_until`) on the
  `link_shares` row — the RPC's own live-row check then denies it on the next
  call. All-or-nothing: one token, every holder.
- **Then delete the audience.** The link's audience serves nobody else (§3), and
  left alive, reconcile-on-write keeps minting grants nobody can read. Deleting
  it stops that, and `ON DELETE CASCADE` cleans up epochs, epoch keys, and
  grants.
- **No epoch bump — there is nothing to rotate.** The link audience's roster
  never changes (§3); revoking at the RPC and deleting the audience already ends
  visibility and future readability. `RemoveMember` is not on this path at all.
  What the link already decrypted is irrecoverable (irreducible — no scheme
  unsends).
- **Time-boxing:** a bounded `valid_until` on the `link_shares` row plus the
  precomputed grant `valid_until` (v2 §4) means a "this month's hours" link
  self-closes with nobody online.

---

## 9. Open items to settle before building

- **Confirm `allowAnonymous` is enabled** on this Neon project and that an
  anonymous token can `EXECUTE` a `SECURITY DEFINER` RPC. This is the one platform
  dependency the chosen path has; verify it first.
- **Lock down `anonymous`.** The migration must ensure the anonymous role has no
  table privileges and only `EXECUTE` on `sharing_link_fetch`; add a test asserting
  a raw anonymous `SELECT` on the base tables returns nothing.
- **Token discipline.** Decide the hash (SHA-256 is fine) and require `S` ≥ 128
  bits of entropy. An indexed lookup by `token_hash` suffices — a timing channel
  on equality is useless against a hashed high-entropy token. Also freeze the
  encoding of `S_read` into `DeriveKEK` (it takes a `string` password; pick
  base64 or hex and treat it as a frozen wire contract like the other domain
  strings).
- **Link lifetime default.** Recommend defaulting one-off links to a bounded
  `valid_until` rather than indefinite, surfaced in the share UI.
- **RPC return shape / paging.** Define what `sharing_link_fetch` returns and how it
  pages (v2 §6 viewport paging) so a large slice doesn't return in one call.
- **The recipient viewer is a new deliverable — likely the largest.** All of this
  crypto (Argon2id, HKDF, the sealed box, AAD canonicalization) exists only in
  Go; the holder runs in a browser. Either compile the Go to WASM or reimplement
  it bit-compatibly in JS/TS, and host a viewer app at `…/share/…`. None of that
  exists in the repo today.
- **Trust bundle or not (§7).** Decide whether link holders get author-signature
  verification via a KEK-encrypted sender pubkey in `link_shares`, or whether
  server-forgery-toward-link-holders is accepted as out of scope for one-off
  shares.
- **Upgrade path.** If a link holder later makes a real account, offer to add
  their *real* pubkey as an ordinary member and retire the link — per human: one
  holder upgrading does not retire the URL for anyone else; killing the link is
  a separate, explicit act.

---

## Summary in one line

**A one-off share is a capability link, not an account: the holder calls one
token-gated `SECURITY DEFINER` RPC (using Neon's generic `allowAnonymous` token
merely to reach it), which authorizes against a `link_shares` table we own and
returns only that audience's ciphertext; the URL fragment's single secret derives
both the RPC token (visibility) and the KEK (readability); each link is its own
audience, frozen at epoch 1 with no roster churn, so the crypto plane — identity,
epoch keys, grants — is reused unchanged and nothing ever rotates; and the server
still cannot read anything.**
