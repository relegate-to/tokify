-- Tokify push — the phones the notify Function pushes to.
--
-- Applied AFTER schema.sql (it needs the authenticated role and
-- auth.user_id()). One row per FCM registration token: the token, its owner,
-- the platform, and when the phone last registered it. Nothing here says what
-- a user is doing; the pushes themselves carry ids and timestamps only.
--
-- A token names an app install, not an account, so registration goes through
-- register_push_device(), which moves the token to the caller when another
-- account registered it before (a phone that switched accounts without a
-- clean sign-out). Holding the token is the proof: FCM hands it only to that
-- install. Removal is a plain own-row DELETE through the Data API.
--
-- notify (functions/notify) reads and prunes these rows with the owner
-- connection, after checking the caller's JWT itself.
--
-- Idempotent throughout: safe to re-run.

CREATE TABLE IF NOT EXISTS public.push_devices (
    token     text        PRIMARY KEY CHECK (length(token) BETWEEN 1 AND 4096),
    user_id   text        NOT NULL,
    platform  text        NOT NULL CHECK (platform IN ('android', 'ios')),
    last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_devices_user_id_idx ON public.push_devices (user_id);

ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_devices FORCE ROW LEVEL SECURITY;

-- Read and delete own rows. No INSERT or UPDATE policy: writes go through
-- register_push_device() so a token can change hands.
DROP POLICY IF EXISTS push_devices_select ON public.push_devices;
CREATE POLICY push_devices_select ON public.push_devices
    FOR SELECT
    TO authenticated
    USING (user_id = auth.user_id());

DROP POLICY IF EXISTS push_devices_delete ON public.push_devices;
CREATE POLICY push_devices_delete ON public.push_devices
    FOR DELETE
    TO authenticated
    USING (user_id = auth.user_id());

GRANT SELECT, DELETE ON public.push_devices TO authenticated;

-- Registers the caller's phone, or refreshes last_seen when it already is.
-- Called on every signed-in launch; POST /rpc/register_push_device.
CREATE OR REPLACE FUNCTION public.register_push_device(token text, platform text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    caller text := auth.user_id();
BEGIN
    IF caller IS NULL OR caller = '' THEN
        RAISE EXCEPTION 'register_push_device: not signed in' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.push_devices AS d (token, user_id, platform, last_seen)
    VALUES (register_push_device.token, caller, register_push_device.platform, now())
    ON CONFLICT ON CONSTRAINT push_devices_pkey DO UPDATE
        SET user_id = EXCLUDED.user_id,
            platform = EXCLUDED.platform,
            last_seen = EXCLUDED.last_seen;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_push_device(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.register_push_device(text, text) TO authenticated;
