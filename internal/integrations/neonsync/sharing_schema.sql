-- Tokify E2EE live sharing — Neon Data API schema (audiences / grants / RLS).
--
-- Applied AFTER schema.sql. Extends the zero-knowledge sync core with the
-- epoched-audience sharing primitive from e2ee-sharing-plan-v2.md: entries can
-- be shared as a live, filtered slice to an "audience" (a set of member public
-- keys plus its own epoched keypair). 1:1 sharing is an audience of one; a team
-- is an audience of many — the same object at different sizes (plan §1).
--
-- Server trust posture is UNCHANGED and stricter than schema.sql's: the DB is
-- honest-but-curious *at minimum* and potentially actively malicious (plan
-- threat model). Every key / ciphertext / signature column below is an opaque
-- base64 blob; hash-chain links are lowercase hex; the server never evaluates a
-- filter, never learns a plaintext, and — crucially — cannot forge a share.
-- RLS here provides the VISIBILITY plane (who may see a row); the READABILITY
-- plane (who may decrypt) lives entirely in the wrapped keys and is invisible
-- to these policies. Both planes must agree for a share to be usable (plan §1).
--
-- Integrity/authenticity against the server is carried by client-verified
-- signatures (author_sig, admin_sig) and AAD-bound ciphertexts (plan §2a/§2b).
-- Every *_sig column below is UNTRUSTED TRANSPORT: the DB stores it, clients
-- verify it against a fingerprint-verified key before trusting anything. A DB
-- check "row exists" proves nothing to a client that distrusts the DB (§5).
--
-- ACCEPTED LEAKAGE (plan §7, chosen consciously — the same deliberate posture
-- as schema.sql's index columns): the grant/share/membership rows are a
-- metadata oracle. The server sees the sharing graph (who shares with which
-- audiences), per-entry audience membership, entry cadence, grant-insert
-- timing, and the valid_from / valid_until time-window bounds. All of that is
-- traffic analysis, none of it is plaintext, and hiding it would need
-- padding / dummy grants / oblivious techniques far beyond budget. There remain
-- NO plaintext activity timestamps on `entries` itself — started_at / duration
-- stay inside the encrypted payload, exactly as in schema.sql.
--
-- Idempotent throughout: safe to re-run (CREATE ... IF NOT EXISTS, DROP POLICY
-- IF EXISTS + CREATE, CREATE OR REPLACE FUNCTION, ADD COLUMN IF NOT EXISTS,
-- guarded constraint adds).

-- ===========================================================================
-- SECTION 0 — Column additions to existing tables
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- entries: versioning (§8), authorship signature (§2a) and the contribution
-- approval status (§4). `user_id` (from schema.sql) DOUBLES AS the plan's
-- `author_id` — there is intentionally no separate author column.
--
-- NOTE — there is deliberately NO `wrapped_dek_author` column here, though plan
-- §3 lists one. Per-entry DEKs are HKDF-derived from the author's account DEK
-- and the entry id, so the author RE-DERIVES the DEK on read instead of storing
-- a wrap of it. Fixed contract; the plan's wrapped-DEK-to-author slot is empty
-- by design.
-- ---------------------------------------------------------------------------
ALTER TABLE public.entries
    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;               -- rides in AAD (§2a); replay of an old version fails decryption
ALTER TABLE public.entries
    ADD COLUMN IF NOT EXISTS supersedes_id text;                              -- versions-that-supersede model (§8); NULL for originals
ALTER TABLE public.entries
    ADD COLUMN IF NOT EXISTS author_sig text;                                 -- base64 Ed25519 over (id, version, ciphertext); NULL for legacy rows
ALTER TABLE public.entries
    ADD COLUMN IF NOT EXISTS contribution_status text NOT NULL DEFAULT 'approved'; -- own entries are simply 'approved' (plan's 'active' dropped as redundant)

-- CHECK added out-of-line and guarded so re-runs and legacy rows don't fail.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entries_contribution_status_check'
          AND conrelid = 'public.entries'::regclass
    ) THEN
        ALTER TABLE public.entries
            ADD CONSTRAINT entries_contribution_status_check
            CHECK (contribution_status IN ('approved', 'pending', 'rejected'));
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- user_keys: the wrapped identity private key (the Ed25519+X25519 identity
-- keypair of §2/§9), wrapped under the same password-derived KEK as wrapped_dek.
-- Nullable until an account is provisioned for sharing. Own-row-only under the
-- existing user_keys RLS — which is exactly why the PUBLIC halves live in a
-- separate `identities` table below (admins must read other users' public keys
-- to wrap epoch keys to them).
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_keys
    ADD COLUMN IF NOT EXISTS wrapped_identity text;                           -- base64 identity privkey ciphertext, wrapped by the KEK
ALTER TABLE public.user_keys
    ADD COLUMN IF NOT EXISTS identity_nonce text;                             -- base64 24-byte nonce for wrapped_identity

-- ===========================================================================
-- SECTION 1 — New tables
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- identities: the PUBLIC halves of each user's identity keypair. Exists because
-- user_keys is own-row-only under RLS, but audience admins must read OTHER
-- users' public keys to wrap epoch keys to them (add-member, §4). Only public
-- material lives here, so it is readable by every authenticated caller;
-- writable only by the owner. Clients still fingerprint-verify these keys
-- out-of-band before trusting them (§9) — the DB row is untrusted transport.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.identities (
    user_id    text        PRIMARY KEY,                  -- Neon Auth JWT `sub`
    pub_enc    text        NOT NULL,                      -- base64 X25519 public encryption key
    pub_sig    text        NOT NULL,                      -- base64 Ed25519 public signing key
    created_at timestamptz NOT NULL DEFAULT now()         -- bookkeeping only
);

-- ---------------------------------------------------------------------------
-- audiences: the universal sharing primitive (plan §1). `current_epoch` is a
-- pointer into audience_epochs. It DEFAULTS TO 0 meaning "no epoch minted yet";
-- real epoch rows start at 1, which makes the epoch-bootstrap INSERT policy
-- `epoch = current_epoch + 1` land the first epoch as 1 (see audience_epochs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audiences (
    id            text        PRIMARY KEY,                -- client-generated random hex
    created_by    text        NOT NULL,                   -- Neon Auth JWT `sub` of the creator
    current_epoch integer     NOT NULL DEFAULT 0,         -- 0 = none minted yet; bumped by trigger on epoch insert
    created_at    timestamptz NOT NULL DEFAULT now()      -- bookkeeping only
);

-- ---------------------------------------------------------------------------
-- audience_epochs: the SIGNED EPOCH ANNOUNCEMENT of §2b. Each row announces the
-- public key for one membership period. `prev_epoch` hash-chains to the prior
-- announcement (hex; '' for epoch 1) so clients detect forked or rolled-back
-- epoch history. admin_sig is signed by an admin identity key.
--
-- CRITICAL: clients MUST verify admin_sig against a fingerprint-verified admin
-- key AND walk the prev_epoch chain BEFORE wrapping any DEK to epoch_pubkey. An
-- unverifiable epoch is a hard stop on the write path (§2b). This DB row is
-- untrusted transport; the signature is the only thing that makes it safe.
-- Append-only: there are deliberately NO UPDATE/DELETE policies (below), since
-- a mutable epoch history would defeat the hash chain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audience_epochs (
    audience_id text        NOT NULL,
    epoch       integer     NOT NULL,                     -- starts at 1
    epoch_pubkey text       NOT NULL,                     -- base64 X25519 epoch public key
    prev_epoch  text        NOT NULL DEFAULT '',          -- hex hash of the previous announcement; '' for epoch 1
    admin_id    text        NOT NULL,                     -- announcing admin's JWT `sub`
    admin_sig   text        NOT NULL,                     -- base64 Ed25519 over the announcement tuple; UNTRUSTED until client-verified
    created_at  timestamptz NOT NULL DEFAULT now(),       -- bookkeeping only
    PRIMARY KEY (audience_id, epoch),
    CONSTRAINT audience_epochs_audience_fk
        FOREIGN KEY (audience_id) REFERENCES public.audiences (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- audience_members: materialized membership + role. `role` governs who may
-- add/remove members, bump epochs, and wrap epoch keys (plan §5). Admin is a
-- first-class, RLS-enforced concept from day one (§9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audience_members (
    audience_id text        NOT NULL,
    member_id   text        NOT NULL,                     -- member's JWT `sub`
    role        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),       -- bookkeeping only
    PRIMARY KEY (audience_id, member_id),
    CONSTRAINT audience_members_role_check CHECK (role IN ('admin', 'member')),
    CONSTRAINT audience_members_audience_fk
        FOREIGN KEY (audience_id) REFERENCES public.audiences (id) ON DELETE CASCADE
);

-- member lookup: "which audiences am I in" drives most read predicates.
CREATE INDEX IF NOT EXISTS audience_members_member_idx
    ON public.audience_members (member_id);

-- ---------------------------------------------------------------------------
-- audience_epoch_keys: level-3 wraps (§2). The audience epoch PRIVATE key,
-- sealed to each member's identity pubkey, once per (audience, epoch, member).
-- A member holds rows ONLY for the epochs granted to them (§4 join policy):
-- join-forward-only wraps just the current epoch; a history-visible join wraps
-- prior epochs too — both zero entries and zero grants touched.
-- AAD (client-side) = (audience_id, epoch, member_id) per §2a.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audience_epoch_keys (
    audience_id           text        NOT NULL,
    epoch                 integer     NOT NULL,
    member_id             text        NOT NULL,           -- recipient member's JWT `sub`
    wrapped_epoch_privkey text        NOT NULL,           -- base64 sealed box of the epoch privkey
    created_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (audience_id, epoch, member_id),
    CONSTRAINT audience_epoch_keys_audience_fk
        FOREIGN KEY (audience_id) REFERENCES public.audiences (id) ON DELETE CASCADE
);

-- read path: "which epoch keys are wrapped to me".
CREATE INDEX IF NOT EXISTS audience_epoch_keys_member_idx
    ON public.audience_epoch_keys (member_id);

-- ---------------------------------------------------------------------------
-- entry_audience_grants: the load-bearing table (plan §3). One row per
-- (entry × audience) — NOT per member — so membership churn never touches
-- grants. `wrapped_dek` is the per-entry DEK sealed to the audience-epoch key;
-- `epoch` MUST equal the audience's current_epoch at insert time (RLS §5).
-- `author_id` is the wrapping author's `sub` (== entries.user_id of the entry).
--
-- valid_from / valid_until implement time-window slices (§4); revoked /
-- revoked_by implement the §4a admin fast-path (visibility-plane narrowing).
--
-- FK on entry_id to entries: acceptable because the ops layer pushes ENTRIES
-- FIRST, then grants, within a sync — a grant can therefore never arrive before
-- its entry. ON DELETE CASCADE so removing an entry never strands its wrapped
-- DEK ciphertext. (Ordering requirement: entries must be pushed before grants.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entry_audience_grants (
    entry_id    text        NOT NULL,
    audience_id text        NOT NULL,
    epoch       integer     NOT NULL,                     -- == audiences.current_epoch at insert (RLS-enforced)
    author_id   text        NOT NULL,                     -- == entries.user_id of entry_id; == auth.user_id() at insert (RLS)
    wrapped_dek text        NOT NULL,                     -- base64 DEK sealed to the audience-epoch key; AAD = (entry_id, audience_id, epoch)
    author_sig  text        NOT NULL,                     -- base64 Ed25519 over the grant tuple; UNTRUSTED until client-verified
    valid_from  timestamptz NOT NULL DEFAULT now(),       -- plaintext metadata (accepted leakage §7)
    valid_until timestamptz NULL,                         -- plaintext metadata; NULL = no upper bound
    revoked     boolean     NOT NULL DEFAULT false,       -- §4a fast-path soft-revoke (visibility only)
    revoked_by  text        NULL,                         -- who revoked; RLS-checked == auth.user_id() on revoke
    created_at  timestamptz NOT NULL DEFAULT now(),       -- bookkeeping only
    PRIMARY KEY (entry_id, audience_id),
    CONSTRAINT entry_audience_grants_entry_fk
        FOREIGN KEY (entry_id) REFERENCES public.entries (id) ON DELETE CASCADE,
    CONSTRAINT entry_audience_grants_audience_fk
        FOREIGN KEY (audience_id) REFERENCES public.audiences (id) ON DELETE CASCADE
);

-- read path: "which grants target this audience" (visibility check per audience).
CREATE INDEX IF NOT EXISTS entry_audience_grants_audience_idx
    ON public.entry_audience_grants (audience_id);

-- ---------------------------------------------------------------------------
-- shares: the intent / filter, authored client-side. filter_ciphertext is
-- encrypted to the audience's CURRENT epoch key (§4a) and the DB NEVER
-- evaluates it — RLS checks grant membership, not the filter (plan §7). An
-- audience must have at least one share row for its members to accept grants
-- (the grant-insert policy requires it). updated_at is server-set via the
-- existing set_updated_at trigger (schema.sql), matching that style.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shares (
    id               text        PRIMARY KEY,             -- client-generated random hex
    audience_id      text        NOT NULL,
    epoch            integer     NOT NULL,                -- epoch the filter is wrapped to; re-wrapped on bump (§4a)
    filter_ciphertext text       NOT NULL,                -- base64; encrypted to the audience epoch key, never DB-evaluated
    created_by       text        NOT NULL,                -- creator's JWT `sub`
    updated_at       timestamptz NOT NULL DEFAULT now(),  -- server-set (trigger below); advisory
    created_at       timestamptz NOT NULL DEFAULT now(),  -- bookkeeping only
    CONSTRAINT shares_audience_fk
        FOREIGN KEY (audience_id) REFERENCES public.audiences (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS shares_audience_idx ON public.shares (audience_id);

-- Reuse schema.sql's set_updated_at() to force server-set updated_at on shares.
DROP TRIGGER IF EXISTS shares_set_updated_at ON public.shares;
CREATE TRIGGER shares_set_updated_at
    BEFORE INSERT OR UPDATE ON public.shares
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- SECTION 2 — SECURITY DEFINER helper functions
--
-- Membership/role/epoch predicates below are queried BY policies on the very
-- tables they read (a policy on audience_members that SELECTs audience_members
-- recurses infinitely). These helpers run as the schema owner and BYPASS RLS,
-- breaking the recursion. search_path is pinned to (public, pg_temp) so a
-- caller cannot shadow a referenced object; they are STABLE (read-only within a
-- statement) and EXECUTE is revoked from PUBLIC, granted only to authenticated.
-- ===========================================================================

-- Is `uid` (defaulting to the caller) a member of audience `aud`?
CREATE OR REPLACE FUNCTION public.sharing_is_member(aud text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.audience_members
        WHERE audience_id = aud AND member_id = auth.user_id()
    );
$$;

-- Is the caller an admin of audience `aud`?
CREATE OR REPLACE FUNCTION public.sharing_is_admin(aud text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.audience_members
        WHERE audience_id = aud AND member_id = auth.user_id() AND role = 'admin'
    );
$$;

-- Is the caller the original creator of audience `aud`? (bootstrap self-admin)
CREATE OR REPLACE FUNCTION public.sharing_is_audience_creator(aud text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.audiences
        WHERE id = aud AND created_by = auth.user_id()
    );
$$;

-- Current epoch pointer for audience `aud` (0 if none / unknown).
CREATE OR REPLACE FUNCTION public.sharing_current_epoch(aud text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT current_epoch FROM public.audiences WHERE id = aud),
        0
    );
$$;

-- Does audience `aud` have at least one share row? (integrity-of-membership
-- clause of the grant-insert policy, §5.)
CREATE OR REPLACE FUNCTION public.sharing_audience_has_share(aud text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.shares WHERE audience_id = aud
    );
$$;

-- Does the caller hold a LIVE grant for entry `eid`? Live = caller is a member
-- of the granting audience AND now() is within [valid_from, valid_until) AND
-- the grant is not revoked. This is the visibility half of the three-tier read
-- (§5); readability (can they decrypt) is a separate key-plane question.
CREATE OR REPLACE FUNCTION public.sharing_has_live_grant(eid text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.entry_audience_grants g
        JOIN public.audience_members m
          ON m.audience_id = g.audience_id
        WHERE g.entry_id = eid
          AND m.member_id = auth.user_id()
          AND NOT g.revoked
          AND now() >= g.valid_from
          AND (g.valid_until IS NULL OR now() < g.valid_until)
    );
$$;

-- Is the caller an admin of ANY audience holding a grant on entry `eid`?
-- Gates the approval-queue read of pending contributions and the admin-side
-- status flip / grant-revoke on other authors' entries (§4/§4a/§5).
CREATE OR REPLACE FUNCTION public.sharing_is_grant_admin(eid text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.entry_audience_grants g
        JOIN public.audience_members m
          ON m.audience_id = g.audience_id
        WHERE g.entry_id = eid
          AND m.member_id = auth.user_id()
          AND m.role = 'admin'
    );
$$;

REVOKE EXECUTE ON FUNCTION public.sharing_is_member(text)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sharing_is_admin(text)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sharing_is_audience_creator(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sharing_current_epoch(text)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sharing_audience_has_share(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sharing_has_live_grant(text)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sharing_is_grant_admin(text)     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.sharing_is_member(text)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.sharing_is_admin(text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.sharing_is_audience_creator(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sharing_current_epoch(text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.sharing_audience_has_share(text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.sharing_has_live_grant(text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.sharing_is_grant_admin(text)      TO authenticated;

-- ===========================================================================
-- SECTION 3 — Column-guard triggers
--
-- RLS decides WHICH ROWS a verb touches but CANNOT restrict WHICH COLUMNS an
-- UPDATE mutates. These BEFORE UPDATE triggers close that gap: they turn the
-- admin write surface into a narrow, auditable operation instead of a
-- ciphertext-overwrite hole.
-- ===========================================================================

-- entries: a non-author (admin acting via the entries UPDATE policy) may only
-- flip contribution_status. Every other column must be unchanged, else RAISE.
-- This is what makes the §4/§5 approval gate an admin-only status flip rather
-- than a way to overwrite another author's ciphertext.
CREATE OR REPLACE FUNCTION public.entries_guard_admin_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF auth.user_id() IS DISTINCT FROM OLD.user_id THEN
        IF NEW.id            IS DISTINCT FROM OLD.id
        OR NEW.user_id       IS DISTINCT FROM OLD.user_id
        OR NEW.ciphertext    IS DISTINCT FROM OLD.ciphertext
        OR NEW.nonce         IS DISTINCT FROM OLD.nonce
        OR NEW.deleted       IS DISTINCT FROM OLD.deleted
        OR NEW.version       IS DISTINCT FROM OLD.version
        OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
        OR NEW.author_sig    IS DISTINCT FROM OLD.author_sig THEN
            RAISE EXCEPTION
                'non-author may only change contribution_status on entries';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entries_guard_admin_update ON public.entries;
CREATE TRIGGER entries_guard_admin_update
    BEFORE UPDATE ON public.entries
    FOR EACH ROW EXECUTE FUNCTION public.entries_guard_admin_update();

-- entry_audience_grants: an UPDATE may only change `revoked` and `revoked_by`
-- (the §4a soft-revoke fast path). Everything else is immutable — authors
-- delete-and-reinsert rather than mutate a grant, so wrapped_dek / epoch /
-- author_sig can never be silently rewritten. When revoked transitions to true,
-- revoked_by must equal the caller (records WHO narrowed, §4a).
CREATE OR REPLACE FUNCTION public.grants_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.entry_id    IS DISTINCT FROM OLD.entry_id
    OR NEW.audience_id IS DISTINCT FROM OLD.audience_id
    OR NEW.epoch       IS DISTINCT FROM OLD.epoch
    OR NEW.author_id   IS DISTINCT FROM OLD.author_id
    OR NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek
    OR NEW.author_sig  IS DISTINCT FROM OLD.author_sig
    OR NEW.valid_from  IS DISTINCT FROM OLD.valid_from
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
        RAISE EXCEPTION
            'grant UPDATE may only change revoked / revoked_by';
    END IF;

    IF NEW.revoked AND NOT OLD.revoked THEN
        IF NEW.revoked_by IS DISTINCT FROM auth.user_id() THEN
            RAISE EXCEPTION 'revoked_by must equal the revoking caller';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS grants_guard_update ON public.entry_audience_grants;
CREATE TRIGGER grants_guard_update
    BEFORE UPDATE ON public.entry_audience_grants
    FOR EACH ROW EXECUTE FUNCTION public.grants_guard_update();

-- audiences: keep current_epoch consistent with audience_epochs WITHOUT letting
-- clients write the pointer directly. This AFTER INSERT trigger advances the
-- pointer to the newly announced epoch, so from the client's perspective an
-- epoch bump is a SINGLE INSERT into audience_epochs (no separate UPDATE, no
-- race window between announcing and pointing). SECURITY DEFINER so it can
-- update audiences under FORCE RLS.
CREATE OR REPLACE FUNCTION public.audience_epochs_bump_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.audiences
       SET current_epoch = NEW.epoch
     WHERE id = NEW.audience_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audience_epochs_bump_pointer ON public.audience_epochs;
CREATE TRIGGER audience_epochs_bump_pointer
    AFTER INSERT ON public.audience_epochs
    FOR EACH ROW EXECUTE FUNCTION public.audience_epochs_bump_pointer();

-- ===========================================================================
-- SECTION 4 — Row-Level Security
--
-- ENABLE + FORCE on every table (FORCE so the owner is constrained too — no
-- path bypasses scoping). Per-VERB policies throughout: FOR ALL cannot express
-- the asymmetric read/insert/update/delete rules the plan needs.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- entries: replace schema.sql's FOR ALL own-rows policy with the three-tier
-- read (§5) plus per-verb write rules. The own-rows policy is dropped here in
-- the idempotent DROP-then-CREATE style.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS entries_own_rows ON public.entries;

-- SELECT: own rows OR a live grant, gated by the approval tier —
--   approved   → visible to any live-grant holder
--   pending    → visible only to the author or an admin of a granting audience
--   rejected   → visible only to the author (falls out of the branch above)
DROP POLICY IF EXISTS entries_select ON public.entries;
CREATE POLICY entries_select ON public.entries
    FOR SELECT
    TO authenticated
    USING (
        user_id = auth.user_id()
        OR (
            public.sharing_has_live_grant(id)
            AND (
                contribution_status = 'approved'
                OR (
                    contribution_status = 'pending'
                    AND public.sharing_is_grant_admin(id)
                )
            )
        )
    );

-- INSERT: you may only plant entries stamped with your own sub.
DROP POLICY IF EXISTS entries_insert ON public.entries;
CREATE POLICY entries_insert ON public.entries
    FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.user_id());

-- UPDATE: the author, or an admin of a granting audience (for the approval
-- status flip). The column-guard trigger constrains the admin to
-- contribution_status only.
DROP POLICY IF EXISTS entries_update ON public.entries;
CREATE POLICY entries_update ON public.entries
    FOR UPDATE
    TO authenticated
    USING (user_id = auth.user_id() OR public.sharing_is_grant_admin(id))
    WITH CHECK (user_id = auth.user_id() OR public.sharing_is_grant_admin(id));

-- DELETE: own rows only. No admin delete of another author's entry.
DROP POLICY IF EXISTS entries_delete ON public.entries;
CREATE POLICY entries_delete ON public.entries
    FOR DELETE
    TO authenticated
    USING (user_id = auth.user_id());

-- ---------------------------------------------------------------------------
-- identities: public keys — readable by all authenticated (admins need other
-- users' public keys to wrap epoch keys). Writable only by the owner.
-- ---------------------------------------------------------------------------
ALTER TABLE public.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS identities_select ON public.identities;
CREATE POLICY identities_select ON public.identities
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS identities_insert ON public.identities;
CREATE POLICY identities_insert ON public.identities
    FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.user_id());

DROP POLICY IF EXISTS identities_update ON public.identities;
CREATE POLICY identities_update ON public.identities
    FOR UPDATE
    TO authenticated
    USING (user_id = auth.user_id())
    WITH CHECK (user_id = auth.user_id());

-- ---------------------------------------------------------------------------
-- audiences: visible to members and the creator; created by yourself; the
-- current_epoch pointer is UPDATE-able only by an admin (though in practice the
-- bump-pointer trigger does it as a side effect of an epoch insert).
-- ---------------------------------------------------------------------------
ALTER TABLE public.audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audiences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audiences_select ON public.audiences;
CREATE POLICY audiences_select ON public.audiences
    FOR SELECT
    TO authenticated
    USING (public.sharing_is_member(id) OR created_by = auth.user_id());

DROP POLICY IF EXISTS audiences_insert ON public.audiences;
CREATE POLICY audiences_insert ON public.audiences
    FOR INSERT
    TO authenticated
    WITH CHECK (created_by = auth.user_id());

DROP POLICY IF EXISTS audiences_update ON public.audiences;
CREATE POLICY audiences_update ON public.audiences
    FOR UPDATE
    TO authenticated
    USING (public.sharing_is_admin(id))
    WITH CHECK (public.sharing_is_admin(id));

-- ---------------------------------------------------------------------------
-- audience_epochs: signed announcements (§2b). Members read; admins append the
-- NEXT epoch only, signing as themselves. APPEND-ONLY — no UPDATE/DELETE
-- policies exist, because a mutable epoch history would defeat the prev_epoch
-- hash chain (§2b) that lets clients detect fork/rollback.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audience_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_epochs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audience_epochs_select ON public.audience_epochs;
CREATE POLICY audience_epochs_select ON public.audience_epochs
    FOR SELECT
    TO authenticated
    USING (public.sharing_is_member(audience_id));

-- INSERT: admin only, strictly current_epoch + 1 (append-only, no gaps/rewrites),
-- announcing as themselves. For the first epoch, current_epoch is 0 so this
-- lands epoch 1. The bump-pointer trigger then advances current_epoch, making
-- the whole bump a single client INSERT.
DROP POLICY IF EXISTS audience_epochs_insert ON public.audience_epochs;
CREATE POLICY audience_epochs_insert ON public.audience_epochs
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.sharing_is_admin(audience_id)
        AND epoch = public.sharing_current_epoch(audience_id) + 1
        AND admin_id = auth.user_id()
    );

-- ---------------------------------------------------------------------------
-- audience_members: members see the roster of audiences they belong to; admins
-- add/remove/re-role. Bootstrap exception: the audience creator may insert
-- their OWN first admin row (there is no admin yet to authorize it). Recursion
-- is avoided by the SECURITY DEFINER helpers.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audience_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audience_members_select ON public.audience_members;
CREATE POLICY audience_members_select ON public.audience_members
    FOR SELECT
    TO authenticated
    USING (public.sharing_is_member(audience_id));

DROP POLICY IF EXISTS audience_members_insert ON public.audience_members;
CREATE POLICY audience_members_insert ON public.audience_members
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.sharing_is_admin(audience_id)
        OR (
            member_id = auth.user_id()
            AND role = 'admin'
            AND public.sharing_is_audience_creator(audience_id)
        )
    );

DROP POLICY IF EXISTS audience_members_update ON public.audience_members;
CREATE POLICY audience_members_update ON public.audience_members
    FOR UPDATE
    TO authenticated
    USING (public.sharing_is_admin(audience_id))
    WITH CHECK (public.sharing_is_admin(audience_id));

DROP POLICY IF EXISTS audience_members_delete ON public.audience_members;
CREATE POLICY audience_members_delete ON public.audience_members
    FOR DELETE
    TO authenticated
    USING (public.sharing_is_admin(audience_id));

-- ---------------------------------------------------------------------------
-- audience_epoch_keys: a member reads only the epoch keys wrapped to THEM;
-- admins wrap (insert) and can delete. No member-side write — receiving a wrap
-- you didn't earn is meaningless (it's sealed to your pubkey) and forging one
-- to another member is an admin-gated action anyway.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audience_epoch_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_epoch_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audience_epoch_keys_select ON public.audience_epoch_keys;
CREATE POLICY audience_epoch_keys_select ON public.audience_epoch_keys
    FOR SELECT
    TO authenticated
    USING (member_id = auth.user_id());

DROP POLICY IF EXISTS audience_epoch_keys_insert ON public.audience_epoch_keys;
CREATE POLICY audience_epoch_keys_insert ON public.audience_epoch_keys
    FOR INSERT
    TO authenticated
    WITH CHECK (public.sharing_is_admin(audience_id));

DROP POLICY IF EXISTS audience_epoch_keys_delete ON public.audience_epoch_keys;
CREATE POLICY audience_epoch_keys_delete ON public.audience_epoch_keys
    FOR DELETE
    TO authenticated
    USING (public.sharing_is_admin(audience_id));

-- ---------------------------------------------------------------------------
-- entry_audience_grants: the forgery-prevention core (§5).
-- ---------------------------------------------------------------------------
ALTER TABLE public.entry_audience_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entry_audience_grants FORCE ROW LEVEL SECURITY;

-- SELECT: the entry's author always sees their own grants; audience members see
-- grants targeting audiences they belong to (needed to unwrap DEKs on read).
DROP POLICY IF EXISTS entry_audience_grants_select ON public.entry_audience_grants;
CREATE POLICY entry_audience_grants_select ON public.entry_audience_grants
    FOR SELECT
    TO authenticated
    USING (author_id = auth.user_id() OR public.sharing_is_member(audience_id));

-- INSERT (the load-bearing policy, §5 — every clause matters):
--   author_id = auth.user_id()                         -- you sign as yourself
--   the entry EXISTS and is authored by the caller      -- you may only wrap DEKs
--                                                          for entries you authored;
--                                                          cross-member forgery
--                                                          (mapping someone else's
--                                                          entry to a key you
--                                                          control — a plaintext
--                                                          exfil primitive) is made
--                                                          STRUCTURALLY
--                                                          UNREPRESENTABLE.
--   sharing_is_member(audience_id)                      -- you belong to the target
--   epoch = sharing_current_epoch(audience_id)          -- current epoch only: a
--                                                          stale-view author racing
--                                                          an admin's bump gets a
--                                                          HARD insert failure, not a
--                                                          silent land on an epoch a
--                                                          removed member still holds.
--   sharing_audience_has_share(audience_id)             -- integrity of membership:
--                                                          no grants to an audience
--                                                          with no filter/intent.
DROP POLICY IF EXISTS entry_audience_grants_insert ON public.entry_audience_grants;
CREATE POLICY entry_audience_grants_insert ON public.entry_audience_grants
    FOR INSERT
    TO authenticated
    WITH CHECK (
        author_id = auth.user_id()
        AND EXISTS (
            SELECT 1 FROM public.entries e
            WHERE e.id = entry_id AND e.user_id = auth.user_id()
        )
        AND public.sharing_is_member(audience_id)
        AND epoch = public.sharing_current_epoch(audience_id)
        AND public.sharing_audience_has_share(audience_id)
    );

-- UPDATE: the grant's author OR an admin of the granting audience may revoke
-- (§4a). The column-guard trigger restricts the change to revoked / revoked_by
-- and pins revoked_by to the caller. Admins CANNOT insert — only revoke — which
-- is what preserves forgery prevention (§5).
DROP POLICY IF EXISTS entry_audience_grants_update ON public.entry_audience_grants;
CREATE POLICY entry_audience_grants_update ON public.entry_audience_grants
    FOR UPDATE
    TO authenticated
    USING (author_id = auth.user_id() OR public.sharing_is_admin(audience_id))
    WITH CHECK (author_id = auth.user_id() OR public.sharing_is_admin(audience_id));

-- DELETE: the author only — the crypto-plane cleanup (§4a) is the author's job.
DROP POLICY IF EXISTS entry_audience_grants_delete ON public.entry_audience_grants;
CREATE POLICY entry_audience_grants_delete ON public.entry_audience_grants
    FOR DELETE
    TO authenticated
    USING (author_id = auth.user_id());

-- ---------------------------------------------------------------------------
-- shares: the filter/intent. Members read (every author needs it to reconcile,
-- §4a); only admins create/edit/delete it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shares FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shares_select ON public.shares;
CREATE POLICY shares_select ON public.shares
    FOR SELECT
    TO authenticated
    USING (public.sharing_is_member(audience_id));

DROP POLICY IF EXISTS shares_insert ON public.shares;
CREATE POLICY shares_insert ON public.shares
    FOR INSERT
    TO authenticated
    WITH CHECK (public.sharing_is_admin(audience_id));

DROP POLICY IF EXISTS shares_update ON public.shares;
CREATE POLICY shares_update ON public.shares
    FOR UPDATE
    TO authenticated
    USING (public.sharing_is_admin(audience_id))
    WITH CHECK (public.sharing_is_admin(audience_id));

DROP POLICY IF EXISTS shares_delete ON public.shares;
CREATE POLICY shares_delete ON public.shares
    FOR DELETE
    TO authenticated
    USING (public.sharing_is_admin(audience_id));

-- ===========================================================================
-- SECTION 5 — Grants to the authenticated role
--
-- Only the DML verbs each table actually needs, matching schema.sql's minimal
-- posture. RLS above still constrains which rows those verbs can touch.
--   identities            SELECT (all) + INSERT/UPDATE (own)
--   audiences             SELECT/INSERT/UPDATE (no client DELETE)
--   audience_epochs       SELECT/INSERT (append-only)
--   audience_members      SELECT/INSERT/UPDATE/DELETE
--   audience_epoch_keys   SELECT/INSERT/DELETE (no UPDATE — rewrap = new row)
--   entry_audience_grants SELECT/INSERT/UPDATE/DELETE
--   shares                SELECT/INSERT/UPDATE/DELETE
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE         ON public.identities           TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.audiences            TO authenticated;
GRANT SELECT, INSERT                 ON public.audience_epochs      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audience_members     TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.audience_epoch_keys  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entry_audience_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shares               TO authenticated;

-- ===========================================================================
-- SECTION 6 — Capability link shares (e2ee-sharing-link-shares.md)
--
-- A one-off recipient with NO account reads a filtered slice through a
-- token-gated RPC instead of RLS-on-`sub`. The crypto plane is unchanged: each
-- link gets its OWN dedicated audience (roster = the sender only, frozen at
-- epoch 1 — no rotation ever runs, §3 of the link-shares doc) plus a SYNTHETIC
-- member that receives an ordinary audience_epoch_keys wrap but is deliberately
-- NEVER inserted into audience_members. Visibility is a bearer capability: the
-- URL fragment's secret S derives (a) a link token whose SHA-256 hash is stored
-- here, and (b) the KEK that unwraps the synthetic identity. The server only
-- ever holds and returns ciphertext.
--
-- Two load-bearing hardening rules (§7):
--   1. The `anonymous` role gets ZERO privileges on the base tables and only
--      EXECUTE on sharing_link_fetch — the RPC is the only door.
--   2. sharing_link_fetch is SECURITY DEFINER and authorizes on the token hash
--      itself (not RLS), scoping strictly to the one audience the token names
--      and returning only that audience's ciphertext.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- link_shares: one row per capability link, owned by its creator. Everything
-- the recipient needs to bootstrap a read lives here as opaque ciphertext:
-- the synthetic identity keypair wrapped under the link-derived KEK, the salt
-- anchoring that KEK, and a KEK-encrypted trust bundle carrying the sender's
-- signing pubkey (lets a viewer verify author signatures — §7). token_hash is
-- SHA-256(link_token) so the raw token never rests on the server. `member_id`
-- is the synthetic sub the epoch key and grants are keyed to; no Neon account
-- backs it and it is never a row in audience_members (§3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.link_shares (
    id                 text        PRIMARY KEY,             -- client-generated random hex
    audience_id        text        NOT NULL,                -- the link's dedicated audience
    token_hash         text        NOT NULL,                -- hex SHA-256 of the link token (never store the token)
    member_id          text        NOT NULL,                -- synthetic member sub (no Neon account backs it)
    wrapped_identity   text        NOT NULL,                -- base64 synthetic identity privkeys, sealed under the link KEK
    identity_nonce     text        NOT NULL,                -- base64 24-byte nonce for wrapped_identity
    salt_enc           text        NOT NULL,                -- base64 salt anchoring the link KEK (DeriveKEK input)
    trust_bundle       text        NOT NULL,                -- base64 sender signing pubkey, sealed under the link KEK (§7)
    trust_bundle_nonce text        NOT NULL,                -- base64 24-byte nonce for trust_bundle
    created_by         text        NOT NULL,                -- sender's JWT `sub`
    valid_from         timestamptz NOT NULL DEFAULT now(),  -- plaintext window bound (accepted leakage §7)
    valid_until        timestamptz NULL,                    -- plaintext; NULL = no upper bound (a bounded value is recommended, §8)
    revoked            boolean     NOT NULL DEFAULT false,  -- instant kill switch the RPC's live-row check honors (§8)
    created_at         timestamptz NOT NULL DEFAULT now(),  -- bookkeeping only
    CONSTRAINT link_shares_audience_fk
        FOREIGN KEY (audience_id) REFERENCES public.audiences (id) ON DELETE CASCADE
);

-- token lookup: the RPC finds a live row by token_hash. UNIQUE so a hash names
-- at most one link. An indexed equality lookup on a hashed high-entropy token
-- needs no constant-time compare — a timing channel on it is useless (§9).
CREATE UNIQUE INDEX IF NOT EXISTS link_shares_token_hash_idx
    ON public.link_shares (token_hash);

-- creator lookup: "which links did I mint" drives the list/revoke UI.
CREATE INDEX IF NOT EXISTS link_shares_created_by_idx
    ON public.link_shares (created_by);

-- ---------------------------------------------------------------------------
-- Does audience `aud` back a capability link? Confines the audience DELETE
-- policy below to link audiences only, so v2's no-client-delete posture for
-- ordinary (shared/team) audiences is preserved. SECURITY DEFINER so the check
-- does not depend on the caller's link_shares RLS visibility.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sharing_audience_has_link(aud text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.link_shares WHERE audience_id = aud
    );
$$;

REVOKE EXECUTE ON FUNCTION public.sharing_audience_has_link(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.sharing_audience_has_link(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- link_shares RLS: strictly own-row for the authenticated creator. The
-- `anonymous` role gets NO policy and NO grant here, so it can never read a
-- link_shares row directly — its only access is through the RPC (§7).
-- ---------------------------------------------------------------------------
ALTER TABLE public.link_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.link_shares FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_shares_select ON public.link_shares;
CREATE POLICY link_shares_select ON public.link_shares
    FOR SELECT
    TO authenticated
    USING (created_by = auth.user_id());

DROP POLICY IF EXISTS link_shares_insert ON public.link_shares;
CREATE POLICY link_shares_insert ON public.link_shares
    FOR INSERT
    TO authenticated
    WITH CHECK (created_by = auth.user_id());

DROP POLICY IF EXISTS link_shares_update ON public.link_shares;
CREATE POLICY link_shares_update ON public.link_shares
    FOR UPDATE
    TO authenticated
    USING (created_by = auth.user_id())
    WITH CHECK (created_by = auth.user_id());

DROP POLICY IF EXISTS link_shares_delete ON public.link_shares;
CREATE POLICY link_shares_delete ON public.link_shares
    FOR DELETE
    TO authenticated
    USING (created_by = auth.user_id());

-- ---------------------------------------------------------------------------
-- audiences DELETE: the creator may delete an audience ONLY when it backs a
-- link (§8 revocation deletes the link's dedicated audience, and ON DELETE
-- CASCADE reaps its epochs, keys, grants, shares, and the link_shares row).
-- Confined to link audiences so ordinary audiences keep v2's no-delete rule.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS audiences_delete ON public.audiences;
CREATE POLICY audiences_delete ON public.audiences
    FOR DELETE
    TO authenticated
    USING (created_by = auth.user_id() AND public.sharing_audience_has_link(id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.link_shares TO authenticated;
GRANT DELETE                         ON public.audiences   TO authenticated;

-- ---------------------------------------------------------------------------
-- sharing_link_fetch: the ONE door for an accountless recipient. It hashes the
-- presented token, finds a LIVE link_shares row (not revoked, now within
-- [valid_from, valid_until)), and returns a single JSON object of nothing but
-- that one audience's ciphertext: the wrapped synthetic identity + salt, the
-- KEK-encrypted trust bundle, the epoch key(s) wrapped to the synthetic member,
-- and the granted (approved, live, non-deleted) entries joined to their grants.
-- Returns NULL when no live link matches. SECURITY DEFINER so it authorizes on
-- the token itself rather than RLS-on-`sub` (§2 of the link-shares doc).
--
-- Paging: p_limit / p_offset bound the entries array (ordered by grant
-- valid_from desc) so a large slice does not return in one call (§9). NULL
-- p_limit returns all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sharing_link_fetch(
    link_token text,
    p_limit    integer DEFAULT NULL,
    p_offset   integer DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hash text := encode(sha256(convert_to(link_token, 'UTF8')), 'hex');
    v_link public.link_shares;
    v_result json;
BEGIN
    SELECT * INTO v_link
      FROM public.link_shares
     WHERE token_hash = v_hash
       AND NOT revoked
       AND now() >= valid_from
       AND (valid_until IS NULL OR now() < valid_until);

    IF NOT FOUND THEN
        RETURN NULL;   -- unknown, revoked, or expired token: reveal nothing
    END IF;

    SELECT json_build_object(
        'audience_id',        v_link.audience_id,
        'member_id',          v_link.member_id,
        'wrapped_identity',   v_link.wrapped_identity,
        'identity_nonce',     v_link.identity_nonce,
        'salt_enc',           v_link.salt_enc,
        'trust_bundle',       v_link.trust_bundle,
        'trust_bundle_nonce', v_link.trust_bundle_nonce,
        'epoch_keys', (
            SELECT COALESCE(json_agg(json_build_object(
                       'epoch',                 ek.epoch,
                       'wrapped_epoch_privkey', ek.wrapped_epoch_privkey)), '[]'::json)
              FROM public.audience_epoch_keys ek
             WHERE ek.audience_id = v_link.audience_id
               AND ek.member_id   = v_link.member_id
        ),
        'entries', (
            SELECT COALESCE(json_agg(row_to_json(sel)), '[]'::json)
              FROM (
                SELECT e.id,
                       e.ciphertext,
                       e.nonce,
                       e.version,
                       e.author_sig,
                       e.user_id AS author_id,
                       g.epoch   AS grant_epoch,
                       g.wrapped_dek
                  FROM public.entry_audience_grants g
                  JOIN public.entries e ON e.id = g.entry_id
                 WHERE g.audience_id = v_link.audience_id
                   AND NOT g.revoked
                   AND now() >= g.valid_from
                   AND (g.valid_until IS NULL OR now() < g.valid_until)
                   AND e.contribution_status = 'approved'
                   AND NOT e.deleted
                 ORDER BY g.valid_from DESC
                 LIMIT p_limit OFFSET p_offset
              ) sel
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- anonymous role lockdown (§7). The role exists in Neon (allowAnonymous); the
-- guarded CREATE lets the RLS test harness — a bare postgres — exercise the
-- same posture. It is granted NOTHING on any table and ONLY EXECUTE on the RPC,
-- so the RPC is provably the only door. REVOKE from PUBLIC keeps the function
-- off the default-privileges path.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymous') THEN
        CREATE ROLE anonymous NOLOGIN;
    END IF;
END $$;

REVOKE ALL ON public.link_shares FROM anonymous;

REVOKE EXECUTE ON FUNCTION public.sharing_link_fetch(text, integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.sharing_link_fetch(text, integer, integer) TO anonymous;
GRANT  EXECUTE ON FUNCTION public.sharing_link_fetch(text, integer, integer) TO authenticated;
