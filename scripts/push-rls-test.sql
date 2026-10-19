-- RLS test suite for push_schema.sql. Run by scripts/sharing-rls-test.sh after
-- sharing-rls-test.sql, whose helpers (test_as, expect_ok, expect_fail,
-- assert_count) it reuses.

\set ON_ERROR_STOP on

RESET role;

SELECT expect_ok('alice',
    $q$SELECT public.register_push_device('tok-a', 'android')$q$,
    'push_devices: alice registers her phone');
RESET role;
SELECT assert_count('alice', $q$SELECT count(*) FROM public.push_devices$q$, 1,
    'push_devices: alice sees her own device');
SELECT assert_count('bob', $q$SELECT count(*) FROM public.push_devices$q$, 0,
    'push_devices: bob cannot see alice''s device');

-- Writes other than registration are refused outright.
SELECT expect_fail('bob',
    $q$INSERT INTO public.push_devices (token, user_id, platform) VALUES ('tok-b', 'bob', 'android')$q$,
    'push_devices: no direct inserts, even of own rows');
RESET role;
SELECT expect_fail('alice',
    $q$UPDATE public.push_devices SET user_id = 'bob' WHERE token = 'tok-a'$q$,
    'push_devices: no direct updates');
RESET role;

-- A foreign delete reaches no rows.
SELECT test_as('bob', $q$DELETE FROM public.push_devices WHERE token = 'tok-a'$q$);
RESET role;
SELECT assert_count('alice', $q$SELECT count(*) FROM public.push_devices WHERE token = 'tok-a'$q$, 1,
    'push_devices: bob''s delete reaches no rows');

-- Registering again refreshes last_seen and keeps one row.
UPDATE public.push_devices SET last_seen = now() - interval '30 days' WHERE token = 'tok-a';
SELECT expect_ok('alice',
    $q$SELECT public.register_push_device('tok-a', 'android')$q$,
    'push_devices: alice registers the same phone again');
RESET role;
SELECT assert_count('alice',
    $q$SELECT count(*) FROM public.push_devices WHERE last_seen > now() - interval '1 minute'$q$, 1,
    'push_devices: re-registering refreshes last_seen without a second row');

-- The phone signs in as bob without alice signing out: the token follows the
-- account that holds it now.
SELECT expect_ok('bob',
    $q$SELECT public.register_push_device('tok-a', 'android')$q$,
    'push_devices: bob registers the token alice held');
RESET role;
SELECT assert_count('alice', $q$SELECT count(*) FROM public.push_devices$q$, 0,
    'push_devices: alice no longer has the moved token');
SELECT assert_count('bob', $q$SELECT count(*) FROM public.push_devices WHERE token = 'tok-a'$q$, 1,
    'push_devices: bob owns the moved token');

SELECT expect_fail('alice',
    $q$SELECT public.register_push_device('tok-c', 'windows')$q$,
    'push_devices: unknown platform refused');
RESET role;
SELECT expect_fail('alice',
    $q$SELECT public.register_push_device('', 'android')$q$,
    'push_devices: empty token refused');
RESET role;
SELECT expect_fail('',
    $q$SELECT public.register_push_device('tok-c', 'android')$q$,
    'push_devices: registering without a signed-in user refused');
RESET role;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'push_test_anon') THEN
        CREATE ROLE push_test_anon NOLOGIN;
    END IF;
    IF has_function_privilege('push_test_anon', 'public.register_push_device(text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'FAIL: register_push_device is executable beyond authenticated';
    END IF;
    RAISE NOTICE 'PASS: register_push_device is not granted to PUBLIC';
END $$;

-- Sign-out removes the caller's own token.
SELECT expect_ok('bob',
    $q$DELETE FROM public.push_devices WHERE token = 'tok-a'$q$,
    'push_devices: bob removes his device');
RESET role;
SELECT assert_count('bob', $q$SELECT count(*) FROM public.push_devices$q$, 0,
    'push_devices: bob''s device is gone');

\echo '==================================================================='
\echo 'ALL PUSH RLS ASSERTIONS PASSED'
\echo '==================================================================='
