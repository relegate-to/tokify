-- Toki end-to-end-encrypted cloud sync — Neon Data API schema.
--
-- Zero-knowledge intent: the server (Neon/PostgREST) only ever stores
-- ciphertext. Every user-content column below holds an opaque base64 blob.
-- There are NO plaintext columns and NO plaintext activity timestamps —
-- entry times live inside the encrypted payload, not in any column. The only
-- server-visible timestamps (created_at, updated_at) are sync bookkeeping and
-- reveal nothing about the tracked activities.
--
-- Access is scoped per user by Row-Level Security keyed to the Neon Auth JWT.
-- auth.user_id() returns the JWT `sub` claim (as text); the `authenticated`
-- role is the PostgREST role the Data API assumes for signed-in callers.
--
-- Idempotent where reasonable: safe to re-run.

-- ---------------------------------------------------------------------------
-- user_keys: one row per user. Holds the wrapped data-encryption key (DEK)
-- and the material needed to re-derive the key-encryption key (KEK) from the
-- user's password. The server cannot decrypt any of this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_keys (
    user_id     text        PRIMARY KEY,                 -- Neon Auth JWT `sub`
    salt_enc    text        NOT NULL,                    -- base64 salt for the password-derived KEK
    wrapped_dek text        NOT NULL,                    -- base64 DEK ciphertext, wrapped by the KEK
    wrap_nonce  text        NOT NULL,                    -- base64 24-byte XChaCha20-Poly1305 nonce
    created_at  timestamptz NOT NULL DEFAULT now()       -- bookkeeping only
);

-- ---------------------------------------------------------------------------
-- entries: one row per activity-log line. `id` is a client-supplied keyed
-- content hash (hex HMAC-SHA256(DEK, canonical(entry))) so writes are an
-- idempotent upsert and the id itself leaks no plaintext.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entries (
    id         text        PRIMARY KEY,                  -- hex HMAC-SHA256(DEK, canonical(entry))
    user_id    text        NOT NULL,
    ciphertext text        NOT NULL,                     -- base64 XChaCha20-Poly1305 ciphertext of the entry JSON
    nonce      text        NOT NULL,                     -- base64 24-byte nonce
    updated_at timestamptz NOT NULL DEFAULT now(),       -- sync bookkeeping; server-set (see trigger); advisory
    deleted    boolean     NOT NULL DEFAULT false        -- tombstone; delete via encrypted sync, keep the row
);

CREATE INDEX IF NOT EXISTS entries_user_id_idx ON public.entries (user_id);

-- ---------------------------------------------------------------------------
-- Server-set timestamps. updated_at is advisory: a PostgREST client can send a
-- value on write, so these triggers force it to now() and keep clients from
-- back-dating sync bookkeeping. Kept intentionally trivial.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_set_updated_at ON public.entries;
CREATE TRIGGER entries_set_updated_at
    BEFORE INSERT OR UPDATE ON public.entries
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security.
--
-- ENABLE turns RLS on for normal callers; FORCE applies it to the table owner
-- too, so no path bypasses the per-user scoping.
--
-- The FOR ALL policy defends two directions:
--   USING      — a caller can only SELECT/UPDATE/DELETE rows whose user_id
--                matches its own JWT `sub`. It cannot read or mutate another
--                user's ciphertext.
--   WITH CHECK — a caller cannot INSERT or UPDATE a row stamped with a
--                foreign user_id, so it cannot plant rows into another user's
--                partition.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_keys_own_rows ON public.user_keys;
CREATE POLICY user_keys_own_rows ON public.user_keys
    FOR ALL
    TO authenticated
    USING (user_id = auth.user_id())
    WITH CHECK (user_id = auth.user_id());

ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entries_own_rows ON public.entries;
CREATE POLICY entries_own_rows ON public.entries
    FOR ALL
    TO authenticated
    USING (user_id = auth.user_id())
    WITH CHECK (user_id = auth.user_id());

-- ---------------------------------------------------------------------------
-- Grants. The `authenticated` role gets only what the sync client needs:
-- schema usage and row DML on these two tables. No CREATE, no access to any
-- other table. RLS above still constrains which rows those verbs can touch.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entries   TO authenticated;
