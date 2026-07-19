# E2EE Live Sharing — Design Plan (v2)

**System:** Time-tracking app, no backend (client → database with auth + row-level security), end-to-end encrypted.
**Goal:** Share a live, filtered *slice* of one's entries — not all-or-nothing — that can grow and shrink, and that generalizes cleanly from 1:1 sharing to full team workspaces using **one mechanism**.

**Threat model, stated once:** the database is honest-but-curious *at minimum* and potentially **actively malicious**. Confidentiality alone is not enough; this plan provides **integrity and authenticity against the server** too (§2b, §3, §5). Where a guarantee is visibility-only rather than cryptographic, the plan says so explicitly.

---

## 1. The core idea

Sharing requires two planes to agree on the same subset of data:

- **Visibility plane** — *which rows a user may see.* Handled by RLS. Re-evaluates on every read, so a filter that grows/shrinks is free here.
- **Readability plane** — *which rows a user can decrypt.* RLS cannot touch this; it has no plaintext.

A share is therefore always a **pointer *plus* a wrapped key** in the same row. Visibility alone (an RLS-granted row) is just an opaque blob the recipient can't open. The wrapped key travels with the pointer. Forgetting the key half is the tempting mistake — don't.

The unifying abstraction is the **audience**: a set of member public keys plus its own keypair.

- A **1:1 share** is an audience of one.
- A **team workspace** is an audience of many.

They are the same object at different sizes. Build it once.

The decision that makes this right from day one (painful to retrofit, trivial to design in): **audience keys are epoched.** An epoch is the audience keypair for a given membership period. Any membership change mints a new epoch. Epochs *are* the revocation/rotation story.

**Corollary that must be designed, not assumed:** because grants are wrapped to the epoch current *at write time*, a member's readable history is exactly the set of epochs they hold keys for. What a joiner can read is therefore a **policy choice** (§4), not an automatic property.

---

## 2. Key hierarchy

Four levels, each wrapping the one below:

1. **Entry payload** — encrypted with a per-entry symmetric **DEK** (data encryption key).
2. **DEK** — wrapped to an **audience epoch key**, once per (entry × audience) the entry belongs to. **Never wrapped to individual members.** This indirection is the pivot that makes teams free.
3. **Audience epoch private key** — wrapped to each **member's identity public key**, once per member in that epoch.
4. **Member identity private key** — wrapped by the member's password-derived key.

**Read path:** unlock identity key (password) → unwrap the audience-epoch keys you're entitled to → unwrap the entry DEK → decrypt payload.

The 1:1 case pays one extra indirection (the audience level) versus wrapping straight to a person. That "cost" is exactly what makes teams free — it's the convergence that lets one mechanism serve both.

**Primitives:** per-entry payload + DEK are symmetric (AES-GCM / XChaCha20-Poly1305 — fast, hundreds of MB/s). Wrapping to pubkeys is X25519 seal / libsodium `crypto_box_seal`. Identity keys additionally carry an **Ed25519 signing half** (see §2a/§2b). No exotic crypto anywhere.

### 2a. Authenticity: signatures are load-bearing, not optional

Sealed boxes are **anonymous** — a recipient cannot tell who sealed them — and AEAD alone binds nothing to database rows. Against a malicious server, confidentiality without authenticity is a half-built lock. Two rules, applied uniformly:

- **Bind ciphertexts to their context.** Every AEAD encryption puts its identifying context in the AAD: entries bind `(entry_id, version, author_id)`; wrapped DEKs in grants bind `(entry_id, audience_id, epoch)`; wrapped epoch keys bind `(audience_id, epoch, member_id)`. A server that splices ciphertext A under row B's metadata, swaps grants between entries, or replays an old version gets a **decryption failure**, not a silent wrong answer.
- **Sign what you author.** Authors sign entries and grants with their identity signing key; admins sign epoch announcements and membership changes (§2b). Verification chains back to the same verified-fingerprint infrastructure §9 already requires — one trust root, used everywhere.

### 2b. Epoch key authenticity (the malicious-keyserver hole)

Authors learn "the current epoch pubkey" *from the database*. Unsigned, this is the single cheapest full-plaintext exfil: a malicious server mints its own keypair, presents it as the current epoch, and every author's reconcile loop obediently wraps DEKs to a server-controlled key. Member-key fingerprint verification (§9) does **not** cover this — it protects epoch-key *distribution* to members, not the epoch key authors *wrap to*.

Therefore: every epoch has a signed announcement — `(audience_id, epoch, epoch_pubkey, prev_epoch)` **signed by an admin's identity key** — stored in `audience_epochs`. Clients **must verify this signature against a fingerprint-verified admin key before wrapping anything to the epoch pubkey**, and must check the `prev_epoch` chain to detect forked or rolled-back epoch history. An unverifiable epoch is a hard stop on the write path, not a warning.

Trust chain, end to end: out-of-band fingerprint verification → admin identity key → signed epoch announcement → epoch pubkey → wrapped DEKs.

---

## 3. Schema

```
entries
  id, author_id,
  version, supersedes_id,           -- versions-that-supersede model (§8); version is in AAD
  enc_payload,                      -- E2EE, per-entry DEK; AAD = (entry_id, version, author_id)
  author_sig,                       -- Ed25519 over (id, version, payload ciphertext)
  wrapped_dek_author,               -- DEK sealed to author's own key
  contribution_status,              -- active | pending | approved | rejected
  started_at, duration_min, ...     -- ONLY fields consciously exposed as index (see §7)

audiences
  id, current_epoch, created_by

audience_epochs                     -- signed epoch announcements (§2b)
  audience_id, epoch,
  epoch_pubkey,
  prev_epoch,                       -- hash-chain link; detects fork/rollback
  admin_sig                         -- signed by an admin identity key; clients verify before wrapping

audience_members
  audience_id, member_id,
  role                              -- admin | member (governs who may add/remove/rotate)

audience_epoch_keys
  audience_id, epoch, member_id,
  wrapped_epoch_privkey             -- epoch private key sealed to that member's pubkey;
                                    -- AAD = (audience_id, epoch, member_id)
                                    -- a member has rows ONLY for epochs granted to them (§4 policy)

entry_audience_grants               -- materialized membership; load-bearing table
  entry_id, audience_id, epoch,     -- epoch MUST equal current_epoch at insert time (§5)
  wrapped_dek,                      -- DEK sealed to that audience-epoch key; AAD = (entry_id, audience_id, epoch)
  author_sig,                       -- author signs the grant tuple
  valid_from, valid_until,
  revoked, revoked_by               -- settable by author OR audience admin (§4a)

shares                              -- the intent / filter, authored client-side
  audience_id,
  filter_encrypted                  -- encrypted to the audience's CURRENT epoch key (§4a);
                                    -- DB NEVER evaluates this; re-wrapped on epoch bump
```

Key structural point: grants are one row per **(entry × audience)**, not per (entry × member). Membership churn stops touching grants entirely — that's the whole win.

---

## 4. Operations

### Author writes an entry
Client-side, on every create/edit:
1. Mint DEK, encrypt payload (AAD per §2a), sign, wrap DEK to author's own key.
2. **Verify, then reconcile:** for each audience whose (client-evaluated) filter matches the entry, verify the current epoch's signed announcement (§2b), then wrap the DEK to that **verified current epoch key** and insert a signed grant.
3. Precompute `valid_until` for time-window slices (e.g. `started_at + 7d`) so the trailing edge needs nobody online.
4. Non-owner authors land `contribution_status = pending` if the audience requires approval; otherwise `approved`.

This is **reconcile-on-write**, not just add-on-write: a predicate change (retag an entry, edit a filter) also *deletes* now-stale grants. All client-side. Reconcile also sweeps up any grants the author owes from filter changes that happened while they were offline, and cleans up any grants an admin soft-revoked in the interim (§4a).

### Add a member — and the join-visibility policy
Baseline operation: wrap the **current epoch key** to the new member's pubkey — one row in `audience_epoch_keys`. Zero entries touched, zero grants touched. O(1), one admin device, nobody else online.

But be precise about what that buys, because grants point at the epoch that was current *when each entry was written*:

- **Join-forward-only (the default).** The new member holds only the current epoch, so they read entries granted under it — everything, if the audience has never bumped; only post-bump entries otherwise. O(1). This is the honest default and the schema's stated invariant.
- **History-visible join (explicit admin option).** The admin additionally wraps **each prior epoch key** to the new member — O(#epochs), still zero entries and zero grants touched, so the core win stands. Caveat to surface in product copy: granting old epochs to a re-added member restores exactly the history a past removal-bump was minted to fence off. That is inherent to "history-visible," not a bug, but it must be a deliberate admin action, never automatic.

Either way, this is the seam that would otherwise be O(entries) × authors — the pain PRE exists to absorb — solved without a proxy and without weakening the server.

### Remove a member
Admin bumps to a **new epoch** (publishing a signed announcement, §2b), wraps the new epoch key to the *remaining* members, re-wraps `filter_encrypted` to the new epoch, and points new writes at it.
- Removed member keeps old-epoch keys → can't recall what was already theirs (irreducible; no scheme can).
- Removed member gets no new epoch → all future entries are dark to them (forward secrecy on removal).
- Cost: O(remaining members), re-wrapping **one key**, never entries. Bounded and cheap.

### 4a. Filter changes: who acts, and when (the liveness gap, closed)
Reconcile-on-write covers the author acting on their own entries. But when an **admin edits the audience filter**, other authors' grants need to change — and only each author can insert or delete their own grants (that asymmetry *is* the forgery prevention, §5). Assign each direction to a plane:

- **Widening** is readability-plane work and is inherently lazy: each author materializes the new grants on their next reconcile. Eventual, per-author, acceptable — nothing is exposed in the meantime.
- **Narrowing** is *not* acceptable lazily: an offline author's now-out-of-scope entries would stay exposed indefinitely. So narrowing gets a **visibility-plane fast path**: audience **admins may set `revoked` on grants** (RLS-permitted, recorded in `revoked_by`), taking effect immediately on the read predicate. The crypto-plane cleanup — actually deleting the grant and its wrapped DEK — happens when the author next reconciles.

Honest limit of the fast path: an admin soft-revoke hides the row via RLS but the wrapped DEK still exists until the author cleans it up, so a member colluding with the DB (or an RLS bug) could still decrypt in that window. Immediate *cryptographic* un-sharing of another author's entry is impossible without their participation — by design, since anything else would let admins manipulate keys they don't own.

Note the filter itself is `filter_encrypted` **to the current epoch key** — every author needs it to reconcile, and members-not-admins can read but not edit it (RLS). Consequence to state plainly: removed members retain old-epoch keys and thus can decrypt the filter *as it stood in their epochs*; the re-wrap on bump keeps future filter edits dark to them, same as entries.

### Approval gate (per-share/audience setting)
Not a second system — a `contribution_status` column plus one read-predicate branch.

**Wrap-on-write, gate-on-read:** a pending contribution's grants are materialized immediately, so nobody needs to be online at approval time. Approval is a pure admin-side `UPDATE contribution_status = 'approved'` that flips visibility. (The alternative — withhold grants until approval — forces the author online at approval time and is rejected for that reason.)

**Be honest about what this gate is:** it is **visibility-only, not cryptographic.** Every member holding the epoch key can *decrypt* a pending contribution the moment it's written; only RLS hides it. A member colluding with the DB, or a single RLS bug, exposes the pending queue. This is the accepted price of offline approval — acceptable because pending contributions were *authored for* this audience anyway — but it must never be sold as "unapproved content is unreadable."

---

## 5. RLS policies (the ones to get exactly right)

### Read (three-tier visibility)
A member may read an entry if:

```
they are a current member of an audience with a live grant for the entry
  ( grant.recipient audience contains auth.uid()
    AND now() within [valid_from, valid_until)
    AND NOT revoked )
AND (
      entry.author_id = auth.uid()             -- your own contribution, any status
   OR entry.contribution_status = 'approved'   -- everyone sees approved
   OR ( entry.contribution_status = 'pending'
        AND caller is admin of the audience )  -- approval queue, as a read predicate
)
```

The approval queue is just a read predicate — no separate pending table.

### Grant insert (forgery prevention — the critical one)
You may insert a grant **only for an entry you authored**, into an audience you're a member of, **on the current epoch only**:

```
auth.uid() = entry.author_id
AND auth.uid() is a current member of the target audience
AND grant.epoch = audience.current_epoch        -- stale-epoch writes fail loudly (race guard)
AND the entry matches a share of that audience  -- integrity of membership
```

The load-bearing clause is the first: you can only wrap DEKs for entries you authored. Cross-member forgery (mapping someone else's entry to a key you control — a plaintext-exfil primitive) becomes **structurally unrepresentable**, not merely crypto-prevented. Defense in both planes.

The epoch-equality clause closes the **bump race**: an author holding a stale view who wraps to epoch N while the admin bumps to N+1 (removing someone) gets a hard insert failure, re-fetches, re-verifies the new epoch announcement, and re-reconciles — instead of silently landing new content on an epoch a removed member still holds.

### Grant revocation
`UPDATE ... SET revoked` is permitted to the grant's author **or an admin of the grant's audience** (§4a). No one else. Admins cannot insert, only revoke — the asymmetry preserves forgery prevention.

### Membership writes
Writes to `audience_members`, epoch bumps (`audience_epochs` inserts), and `audience_epoch_keys` inserts are gated on `role = admin` for the audience. Admin is a first-class concept from day one. RLS gates *who may write* these rows; the admin signature (§2b) is what lets *clients* trust them — the DB check alone proves nothing to a client that distrusts the DB.

---

## 6. Recipient decrypt cost

One independent unwrap + verify + decrypt per entry — the *same* cost the owner already pays for their own entries. It is **not** all-or-nothing: each grant is self-contained, entries are independent, there's no master key that forces "decrypt everything to read anything."

Keep it cheap in practice:
- **Page it:** decrypt only the viewport (e.g. 50 rows), not the whole slice. Perceived cost is O(viewport).
- **Cache** decrypted epoch keys, verified epoch announcements and author keys, and DEKs in memory for the session.
- The asymmetric steps — audience-epoch unwrap and announcement-signature verification — are done **once per audience-epoch per session**, then N cheap symmetric DEK unwraps (Ed25519 verifies on entries are ~µs and don't change the shape). This is the two-level structure baked into the hierarchy (§2), so the expensive step doesn't repeat per entry.

Only if real-device profiling on a real slice size shows pain do you optimize further — and the hierarchy already gives you the main lever.

---

## 7. Metadata / index decision (make it consciously)

Because the DB never evaluates the filter (the owner's client does, then materializes grants), your **filter predicate and its tag values never need to be DB-readable.** RLS checks grant membership against an opaque list.

The tradeoff to decide deliberately: any field you want the *database* to sort/paginate on (e.g. `started_at`, `duration_min`) must be a cleartext (or blind-indexed) column, which leaks that field to whoever controls the DB. Encrypt everything else in the payload. Expose the minimum index surface you actually need for queries; keep sensitive dimensions (like tags, if they're sensitive) inside the encrypted payload and out of the index.

**And name the structural leak, not just the column leak:** the grants table itself is a metadata oracle. The server sees the full sharing graph (who shares with which audiences), per-entry audience membership, entry cadence, and grant-insert *timing* — which partially reveals filter semantics (a grant appearing right after an entry says "this entry matched"). None of this is plaintext, all of it is traffic analysis, and hiding it would require padding/dummy grants or oblivious techniques far beyond this design's budget. **Accepted leakage — chosen consciously, like the index columns.**

You cannot have both a private filter *and* a server that evaluates it. This design chooses **private predicate + client-materialized grants.**

---

## 8. Write-back / co-authoring (multi-author slices)

Supported as first-class (this is why `author_id` is distinct from audience/owner and why the reconcile loop is symmetric — each author wraps their own entries' DEKs to the audience epoch key).

- **Suggestions/corrections** and **new contributed entries** are both just entries authored by a member and shared back through the same grants mechanism. No new crypto.
- **No in-place edits of someone else's entry.** Model corrections as **versions that supersede** (`version`, `supersedes_id`), never mutations. This avoids handing out durable keys and avoids client-side merge-conflict arbitration (which has no backend to resolve it — last-writer-wins would silently eat data). Version numbers ride in the AAD (§2a), so a server serving a stale version fails decryption checks rather than silently rolling back.
- The **approval toggle** governs when a non-owner's contribution becomes visible to *other* members (see §4/§5) — visibility-only, per the caveat there.

---

## 9. Irreducible things to build from day one

- **Verified key distribution is the crown-jewel attack surface — in two places, not one.** (1) A swapped *member* pubkey lets an attacker receive an audience epoch key on add-member. Out-of-band **fingerprint verification** (or TOFU + pinning) is not optional. (2) A swapped *epoch* pubkey lets the server receive every author's wrapped DEKs (§2b) — so epoch announcements are admin-signed and clients hard-fail on unverifiable epochs. Both verifications chain to the same fingerprint root. The whole E2EE guarantee rests on these two seams.
- **Identity keys sign as well as decrypt.** Ciphertext binding via AAD and author/admin signatures (§2a) are day-one requirements: without them the server can splice, swap, and roll back ciphertexts undetected, and "E2EE" quietly means confidentiality-only.
- **Members hold a keychain of epochs**, not a single key. Design the client key store as "set of epoch keys per audience" from the start — and the join-visibility policy (§4) as an explicit setting, not an accident of implementation.
- **Admin role** is a real, RLS-enforced *and signature-backed* concept. Trivial now, awkward later.
- **Removal is forward-only.** Say so in product copy: "remove" means no future reads, not unsend. No scheme can recall plaintext already decrypted.
- **Password loss is total loss — decide the recovery story now.** The identity private key is wrapped only by a password-derived key. Lose the password and the account's entries, epoch keys, and every audience they admin are gone; there is no reset (a server-side reset would *be* the backdoor). Options, all standard: recovery codes (offline copy of the wrapped identity key), multi-device key sync (each device holds the identity key, any device can re-provision another), or social/escrow recovery. Pick at least one before launch; also define **identity-key rotation** (new keypair, re-wrap held epoch keys, re-sign, revoke old fingerprint) for device-compromise response.

**Revocation product decisions to settle** (none forced by crypto):
- A removed co-author's *future reads* — stop (automatic via epoch bump).
- Their *pending* contributions — auto-reject on removal? (probably yes)
- Their *approved* contributions — keep / tombstone / reassign ownership? Co-members' grants persist independent of the removed author's own access unless you tombstone.
- A re-added member's *history* — forward-only by default; history-visible only by explicit admin action (§4).

---

## 10. Why this over the alternatives

- **Per-member wrapping** works for 1:1 but can't become teams without O(entries) backfill per author on every join. Rejected — it's not one mechanism.
- **Proxy re-encryption (PRE)** is aimed at the right pain (add-member fan-out) but: (a) the re-encryption key is *not* slice-scoped, so the proxy must be *trusted to honestly apply the predicate* — a downgrade from "server literally cannot read"; (b) needs a new, less battle-tested crypto core alongside libsodium; (c) reintroduces a trusted live compute component. Only needed for live re-encryption to a reader who *can't hold the audience key* — which nothing here requires. Rejected for now.
- **Epoched audiences (this plan)** give teams with no backend and a server that still cannot read anything — and, with signed epochs and bound ciphertexts, cannot *tamper* undetected either. Membership churn is O(members re-wrapping one key) — plus O(#epochs) only when history-visible joins are explicitly granted — never O(entries). One mechanism for 1:1 and teams.

### The one honest ceiling
This is hand-rolled epoch / sender-key ratcheting (same lineage as Signal sender keys; a deliberately simplified MLS). Correct and appropriate for shares and small-to-medium teams, where re-wrapping one key to K members on removal is nothing. If audiences ever get **large and churny** (dozens+ with frequent membership changes), the linear-in-members rewrap is what **MLS / TreeKEM** reduces to log(N) — but MLS wants a delivery/ordering service (a backend) and real complexity.

That's the graduation path, and **the audience abstraction is exactly what you'd swap the internals of** without touching entries, DEKs, grants, or RLS. Building audiences now *is* building the seam that lets you adopt MLS later without a rewrite. (The signed epoch-announcement chain of §2b is also exactly the shape MLS's commit chain takes — another reason it's the right seam.)

---

## Summary in one line

**Epoched audiences as the universal sharing primitive; per-entry DEKs wrapped to admin-signed, client-verified epoch keys; ciphertexts bound and author-signed so the server can neither read nor splice; membership materialized as opaque grants; visibility on RLS (including admin fast-path revocation for filter narrowing), readability on the key plane; approval and co-authoring as thin, explicitly visibility-only predicates on top — no backend, and teams come free.**
