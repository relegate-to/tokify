-- RLS test suite for sharing_schema.sql. Run by scripts/sharing-rls-test.sh
-- inside an ephemeral postgres container, AFTER the Neon-env stub, schema.sql,
-- and sharing_schema.sql have been applied (twice, for idempotency).
--
-- Conventions used throughout:
--   * Each scenario switches identity with `SET ROLE authenticated;` +
--     `SET app.user_id = '<user>'` so auth.user_id() (stubbed to read
--     app.user_id) returns that user. `RESET ROLE` returns to the superuser to
--     seed fixtures that bypass RLS.
--   * ON_ERROR_STOP is on in the harness, so any unexpected error aborts.
--   * expect_ok(sql)      — runs sql; a raised error fails the run.
--   * expect_fail(sql)    — runs sql; if it SUCCEEDS, we RAISE (unexpected
--                           success = policy hole = test failure).
--   * assert_count(sql,n) — runs a scalar-count query as the CURRENT identity
--                           and RAISEs unless it equals n.
-- These helpers are plain superuser-owned functions; they SET LOCAL role inside
-- so they run the payload as the intended caller.

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------------
-- Test helpers (superuser-owned; created once).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test_as(uid text, sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('SET LOCAL role authenticated');
    PERFORM set_config('app.user_id', uid, true);
    EXECUTE sql;
END;
$$;

-- Runs `sql` as `uid`; RAISEs if it does NOT error (expected-failure probe).
CREATE OR REPLACE FUNCTION expect_fail(uid text, sql text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        PERFORM test_as(uid, sql);
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'PASS (expected failure): %', label;
        RETURN;
    END;
    RAISE EXCEPTION 'FAIL (expected failure but succeeded): %', label;
END;
$$;

-- Runs `sql` as `uid`; RAISEs if it errors (expected-success probe).
CREATE OR REPLACE FUNCTION expect_ok(uid text, sql text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM test_as(uid, sql);
    RAISE NOTICE 'PASS (expected success): %', label;
END;
$$;

-- Asserts a scalar count run AS `uid` equals `want`.
CREATE OR REPLACE FUNCTION assert_count(uid text, sql text, want bigint, label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got bigint;
BEGIN
    EXECUTE format('SET LOCAL role authenticated');
    PERFORM set_config('app.user_id', uid, true);
    EXECUTE sql INTO got;
    RESET role;
    IF got IS DISTINCT FROM want THEN
        RAISE EXCEPTION 'FAIL (count): % — got %, want %', label, got, want;
    END IF;
    RAISE NOTICE 'PASS (count %): %', want, label;
END;
$$;

-- ==========================================================================
-- Fixtures (seeded as superuser, RLS bypassed for setup).
--   alice = author + audience creator/admin
--   bob   = member
--   carol = non-member
-- ==========================================================================
RESET role;

INSERT INTO public.identities (user_id, pub_enc, pub_sig) VALUES
    ('alice', 'aQ==', 'aS=='),
    ('bob',   'Yg==', 'Yr=='),
    ('carol', 'Yw==', 'Y3==');

-- Audience A, created by alice.
INSERT INTO public.audiences (id, created_by, current_epoch) VALUES ('audA', 'alice', 0);

-- alice bootstraps herself as admin; bob is a member. (Seeded directly.)
INSERT INTO public.audience_members (audience_id, member_id, role) VALUES
    ('audA', 'alice', 'admin'),
    ('audA', 'bob',   'member');

-- Epoch 1 announcement (also bumps audiences.current_epoch via trigger).
INSERT INTO public.audience_epochs (audience_id, epoch, epoch_pubkey, prev_epoch, admin_id, admin_sig)
    VALUES ('audA', 1, 'ep1', '', 'alice', 'sig1');

-- A share so the audience will accept grants.
INSERT INTO public.shares (id, audience_id, epoch, filter_ciphertext, created_by)
    VALUES ('shr1', 'audA', 1, 'filt', 'alice');

-- alice's entries (author_id == user_id).
INSERT INTO public.entries (id, user_id, ciphertext, nonce, contribution_status) VALUES
    ('e_appr', 'alice', 'ct1', 'n1', 'approved'),
    ('e_pend', 'alice', 'ct2', 'n2', 'pending'),
    ('e_rev',  'alice', 'ct3', 'n3', 'approved'),   -- will get a revoked grant
    ('e_exp',  'alice', 'ct4', 'n4', 'approved'),   -- will get an expired grant
    ('e_bob',  'bob',   'ctB', 'nB', 'approved');   -- bob's own entry (not shared)

-- Live grants from alice to audA for approved + pending + rev + exp entries.
INSERT INTO public.entry_audience_grants
    (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig, valid_from, valid_until, revoked)
VALUES
    ('e_appr', 'audA', 1, 'alice', 'wd1', 'gs1', now() - interval '1h', NULL,                    false),
    ('e_pend', 'audA', 1, 'alice', 'wd2', 'gs2', now() - interval '1h', NULL,                    false),
    ('e_rev',  'audA', 1, 'alice', 'wd3', 'gs3', now() - interval '1h', NULL,                    true),
    ('e_exp',  'audA', 1, 'alice', 'wd4', 'gs4', now() - interval '2h', now() - interval '1h',   false);

RESET role;

-- ==========================================================================
-- Assertions
-- ==========================================================================
DO $$
BEGIN
    -- current_epoch followed the audience_epochs insert (bump trigger).
    IF (SELECT current_epoch FROM public.audiences WHERE id = 'audA') <> 1 THEN
        RAISE EXCEPTION 'FAIL: current_epoch did not follow epoch insert';
    END IF;
    RAISE NOTICE 'PASS: current_epoch follows audience_epochs insert';
END $$;

-- ---- READ visibility (three-tier) ----------------------------------------
-- carol (non-member) sees nothing, anywhere.
SELECT assert_count('carol', 'SELECT count(*) FROM public.entries', 0,
    'carol sees no entries');
SELECT assert_count('carol', 'SELECT count(*) FROM public.entry_audience_grants', 0,
    'carol sees no grants');
SELECT assert_count('carol', 'SELECT count(*) FROM public.audiences', 0,
    'carol sees no audiences');
SELECT assert_count('carol', 'SELECT count(*) FROM public.audience_members', 0,
    'carol sees no members');
SELECT assert_count('carol', 'SELECT count(*) FROM public.shares', 0,
    'carol sees no shares');

-- bob sees alice's approved entry via a live grant, but NOT the revoked,
-- expired, pending, or bob-nonshared ones. Plus bob sees his own e_bob.
-- => visible to bob: e_appr + e_bob = 2.
SELECT assert_count('bob', 'SELECT count(*) FROM public.entries', 2,
    'bob sees only e_appr (live grant) + e_bob (own)');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_appr'$q$, 1,
    'bob sees e_appr');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_rev'$q$, 0,
    'bob does NOT see revoked-grant entry');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_exp'$q$, 0,
    'bob does NOT see expired-grant entry');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_pend'$q$, 0,
    'plain member bob does NOT see pending entry');

-- alice (author) sees all her own entries incl pending + rejected-status.
SELECT assert_count('alice',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_pend'$q$, 1,
    'author alice sees her pending entry');

-- admin alice sees the pending entry via the approval-queue branch even for a
-- non-own entry. Seed a pending entry authored by bob, granted to audA.
RESET role;
INSERT INTO public.entries (id, user_id, ciphertext, nonce, contribution_status)
    VALUES ('e_bpend', 'bob', 'ctBP', 'nBP', 'pending');
INSERT INTO public.entry_audience_grants
    (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
    VALUES ('e_bpend', 'audA', 1, 'bob', 'wdBP', 'gsBP');
RESET role;

SELECT assert_count('alice',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_bpend'$q$, 1,
    'audience admin alice sees bob-authored pending entry (approval queue)');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.entries WHERE id = 'e_bpend'$q$, 1,
    'author bob sees his own pending entry');
-- carol still cannot; and a plain member would not — but our only plain member
-- is bob, who authored it. That path is covered by e_pend above.

-- ---- GRANT INSERT forgery / race / no-share ------------------------------
-- bob cannot insert a grant for ALICE's entry (forgery: author_id mismatch
-- AND entry not authored by bob).
SELECT expect_fail('bob',
    $q$INSERT INTO public.entry_audience_grants
       (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
       VALUES ('e_appr','audA',1,'bob','x','x')$q$,
    'bob cannot forge a grant for alice''s entry');

-- bob cannot even claim author_id=alice (author_id must equal caller).
SELECT expect_fail('bob',
    $q$INSERT INTO public.entry_audience_grants
       (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
       VALUES ('e_appr','audA',1,'alice','x','x')$q$,
    'bob cannot forge a grant claiming author_id=alice');

-- alice cannot insert a grant on a STALE epoch (0) — race guard. Current is 1.
SELECT expect_fail('alice',
    $q$INSERT INTO public.entry_audience_grants
       (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
       VALUES ('e_appr','audA',0,'alice','x','x')$q$,
    'alice cannot insert grant on stale epoch 0');

-- Bump to epoch 2, then a grant at epoch 1 must fail (stale after bump).
RESET role;
SELECT expect_ok('alice',
    $q$INSERT INTO public.audience_epochs
       (audience_id, epoch, epoch_pubkey, prev_epoch, admin_id, admin_sig)
       VALUES ('audA',2,'ep2','hash1','alice','sig2')$q$,
    'admin alice bumps to epoch 2');
DO $$
BEGIN
    IF (SELECT current_epoch FROM public.audiences WHERE id='audA') <> 2 THEN
        RAISE EXCEPTION 'FAIL: current_epoch did not follow bump to 2';
    END IF;
    RAISE NOTICE 'PASS: current_epoch followed bump to 2';
END $$;
SELECT expect_fail('alice',
    $q$INSERT INTO public.entry_audience_grants
       (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
       VALUES ('e_appr','audA',1,'alice','x','x')$q$,
    'alice cannot insert grant on now-stale epoch 1 after bump');
-- ...but a grant at the NEW current epoch 2 works (needs a fresh entry to avoid
-- PK clash on (entry_id, audience_id)).
RESET role;
INSERT INTO public.entries (id, user_id, ciphertext, nonce)
    VALUES ('e_e2', 'alice', 'ct5', 'n5');
RESET role;
SELECT expect_ok('alice',
    $q$INSERT INTO public.entry_audience_grants
       (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
       VALUES ('e_e2','audA',2,'alice','wd5','gs5')$q$,
    'alice inserts grant on current epoch 2');

-- alice cannot insert a grant for an audience with NO share row.
RESET role;
INSERT INTO public.audiences (id, created_by, current_epoch) VALUES ('audNoShare','alice',0);
INSERT INTO public.audience_members (audience_id, member_id, role) VALUES ('audNoShare','alice','admin');
INSERT INTO public.audience_epochs (audience_id, epoch, epoch_pubkey, prev_epoch, admin_id, admin_sig)
    VALUES ('audNoShare',1,'epx','','alice','sigx');
INSERT INTO public.entries (id, user_id, ciphertext, nonce) VALUES ('e_ns','alice','ctN','nN');
RESET role;
SELECT expect_fail('alice',
    $q$INSERT INTO public.entry_audience_grants
       (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
       VALUES ('e_ns','audNoShare',1,'alice','x','x')$q$,
    'alice cannot grant into audience with no share row');

-- ---- APPROVAL flip + entries column guard --------------------------------
-- admin alice CAN flip contribution_status of bob's pending entry to approved.
SELECT expect_ok('alice',
    $q$UPDATE public.entries SET contribution_status='approved' WHERE id='e_bpend'$q$,
    'admin alice approves bob-authored pending entry');
-- now plain member bob's approval is moot; verify it is approved.
DO $$
BEGIN
    IF (SELECT contribution_status FROM public.entries WHERE id='e_bpend') <> 'approved' THEN
        RAISE EXCEPTION 'FAIL: approval flip did not persist';
    END IF;
    RAISE NOTICE 'PASS: approval flip persisted';
END $$;
-- admin alice CANNOT overwrite bob's ciphertext (column-guard trigger raises).
SELECT expect_fail('alice',
    $q$UPDATE public.entries SET ciphertext='HACKED' WHERE id='e_bpend'$q$,
    'admin alice cannot overwrite another author''s ciphertext');

-- ---- MEMBERSHIP / EPOCH admin gating -------------------------------------
-- bob (non-admin) cannot add a member.
SELECT expect_fail('bob',
    $q$INSERT INTO public.audience_members (audience_id, member_id, role)
       VALUES ('audA','carol','member')$q$,
    'non-admin bob cannot add a member');
-- bob cannot bump an epoch.
SELECT expect_fail('bob',
    $q$INSERT INTO public.audience_epochs
       (audience_id, epoch, epoch_pubkey, prev_epoch, admin_id, admin_sig)
       VALUES ('audA',3,'ep3','h','bob','s')$q$,
    'non-admin bob cannot bump an epoch');

-- Creator bootstrap self-admin insert works: new audience, no members yet.
RESET role;
INSERT INTO public.audiences (id, created_by, current_epoch) VALUES ('audB','alice',0);
RESET role;
SELECT expect_ok('alice',
    $q$INSERT INTO public.audience_members (audience_id, member_id, role)
       VALUES ('audB','alice','admin')$q$,
    'creator alice bootstraps herself as admin of audB');
-- A non-creator cannot bootstrap-self-admin someone else's empty audience.
RESET role;
INSERT INTO public.audiences (id, created_by, current_epoch) VALUES ('audC','alice',0);
RESET role;
SELECT expect_fail('bob',
    $q$INSERT INTO public.audience_members (audience_id, member_id, role)
       VALUES ('audC','bob','admin')$q$,
    'non-creator bob cannot bootstrap-self-admin alice''s audience');

-- ---- INVITE CONSENT ------------------------------------------------------
-- An admin can only plant an 'invited' row, and only the invitee can accept.
-- Otherwise an admin could make carol an accepted member unasked, and carol's
-- client would reconcile grants into the audience.
SELECT expect_fail('alice',
    $q$INSERT INTO public.audience_members (audience_id, member_id, role)
       VALUES ('audA','carol','member')$q$,
    'admin alice cannot add carol with the default active status');
SELECT expect_fail('alice',
    $q$INSERT INTO public.audience_members (audience_id, member_id, role, status)
       VALUES ('audA','carol','member','active')$q$,
    'admin alice cannot add carol as active');
SELECT expect_ok('alice',
    $q$INSERT INTO public.audience_members (audience_id, member_id, role, status)
       VALUES ('audA','carol','member','invited')$q$,
    'admin alice can invite carol');
SELECT expect_fail('alice',
    $q$UPDATE public.audience_members SET status='active'
       WHERE audience_id='audA' AND member_id='carol'$q$,
    'admin alice cannot accept carol''s invitation for her');
SELECT expect_ok('alice',
    $q$UPDATE public.audience_members SET role='admin'
       WHERE audience_id='audA' AND member_id='carol'$q$,
    'admin alice can still re-role a pending invitee');
SELECT expect_ok('carol',
    $q$UPDATE public.audience_members SET status='active'
       WHERE audience_id='audA' AND member_id='carol'$q$,
    'invitee carol accepts her own invitation');
RESET role;
DO $$
BEGIN
    IF (SELECT status FROM public.audience_members
         WHERE audience_id='audA' AND member_id='carol') <> 'active' THEN
        RAISE EXCEPTION 'FAIL: carol''s accept did not land';
    END IF;
    RAISE NOTICE 'PASS: carol''s accept landed';
END $$;
DELETE FROM public.audience_members WHERE audience_id='audA' AND member_id='carol';

-- An author who is also a grant admin passes entries_update either way, so the
-- guard must stop them handing an entry to another user.
SELECT expect_fail('alice',
    $q$UPDATE public.entries SET user_id='bob' WHERE id='e_appr'$q$,
    'author alice cannot reassign her entry to bob');

-- ---- GRANT REVOKE + column guard -----------------------------------------
-- Seed a bob-authored grant (bob is member, epoch 2 current). Need a share on
-- audA (exists) and a bob entry granted to audA at current epoch.
RESET role;
INSERT INTO public.entries (id, user_id, ciphertext, nonce) VALUES ('e_bg','bob','ctBG','nBG');
INSERT INTO public.entry_audience_grants
    (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
    VALUES ('e_bg','audA',2,'bob','wdBG','gsBG');
RESET role;
-- admin alice CAN set revoked on bob's grant (records revoked_by=alice).
SELECT expect_ok('alice',
    $q$UPDATE public.entry_audience_grants
       SET revoked=true, revoked_by='alice' WHERE entry_id='e_bg' AND audience_id='audA'$q$,
    'admin alice revokes bob''s grant');
-- admin alice CANNOT change the wrapped_dek (column-guard trigger raises).
SELECT expect_fail('alice',
    $q$UPDATE public.entry_audience_grants
       SET wrapped_dek='HACKED' WHERE entry_id='e_bg' AND audience_id='audA'$q$,
    'admin alice cannot change a grant''s wrapped_dek');
-- Revoking with a mismatched revoked_by is rejected by the guard.
RESET role;
INSERT INTO public.entries (id, user_id, ciphertext, nonce) VALUES ('e_bg2','bob','ctBG2','nBG2');
INSERT INTO public.entry_audience_grants
    (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
    VALUES ('e_bg2','audA',2,'bob','wdBG2','gsBG2');
RESET role;
SELECT expect_fail('alice',
    $q$UPDATE public.entry_audience_grants
       SET revoked=true, revoked_by='bob' WHERE entry_id='e_bg2' AND audience_id='audA'$q$,
    'revoked_by must equal the revoking caller');

-- ---- EPOCH KEY read isolation --------------------------------------------
RESET role;
INSERT INTO public.audience_epoch_keys (audience_id, epoch, member_id, wrapped_epoch_privkey) VALUES
    ('audA', 1, 'alice', 'wa_alice'),
    ('audA', 1, 'bob',   'wa_bob');
RESET role;
-- bob reads only his own epoch-key row, never alice's.
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.audience_epoch_keys$q$, 1,
    'bob sees only his own epoch-key row');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.audience_epoch_keys WHERE member_id='alice'$q$, 0,
    'bob cannot read alice''s epoch-key row');
-- bob (non-admin) cannot insert an epoch key.
SELECT expect_fail('bob',
    $q$INSERT INTO public.audience_epoch_keys (audience_id, epoch, member_id, wrapped_epoch_privkey)
       VALUES ('audA',2,'bob','x')$q$,
    'non-admin bob cannot insert an epoch key');

-- ---- SHARES admin gating -------------------------------------------------
SELECT expect_fail('bob',
    $q$INSERT INTO public.shares (id, audience_id, epoch, filter_ciphertext, created_by)
       VALUES ('shrBad','audA',2,'f','bob')$q$,
    'non-admin bob cannot create a share');
SELECT assert_count('bob', 'SELECT count(*) FROM public.shares', 1,
    'member bob can read the audA share');

-- ==========================================================================
-- LINK SHARES (e2ee-sharing-link-shares.md §7): the anonymous role must have
-- ZERO table privileges and reach exactly one door — the SECURITY DEFINER RPC —
-- which returns only the named link's ciphertext.
-- ==========================================================================
RESET role;
-- Let the superuser SET ROLE anonymous (sharing_schema.sql created the role).
GRANT anonymous TO postgres;

-- Runs `sql` AS the anonymous role; RAISEs if it does NOT error.
CREATE OR REPLACE FUNCTION expect_fail_anon(sql text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        SET LOCAL role anonymous;
        EXECUTE sql;
    EXCEPTION WHEN OTHERS THEN
        RESET role;
        RAISE NOTICE 'PASS (expected failure, anon): %', label;
        RETURN;
    END;
    RESET role;
    RAISE EXCEPTION 'FAIL (expected failure but succeeded, anon): %', label;
END;
$$;

-- Calls the RPC AS the anonymous role (exercises the EXECUTE grant + door).
CREATE OR REPLACE FUNCTION link_fetch_as_anon(token text)
RETURNS json LANGUAGE plpgsql AS $$
DECLARE r json;
BEGIN
    SET LOCAL role anonymous;
    SELECT public.sharing_link_fetch(token) INTO r;
    RESET role;
    RETURN r;
END;
$$;

-- ---- Link fixtures: a dedicated audience frozen at epoch 1 with a synthetic
-- member that is deliberately NOT in audience_members, and one granted entry.
RESET role;
INSERT INTO public.audiences (id, created_by, current_epoch) VALUES ('audL', 'alice', 0);
INSERT INTO public.audience_members (audience_id, member_id, role) VALUES ('audL', 'alice', 'admin');
INSERT INTO public.audience_epochs (audience_id, epoch, epoch_pubkey, prev_epoch, admin_id, admin_sig)
    VALUES ('audL', 1, 'epL', '', 'alice', 'sigL');
INSERT INTO public.shares (id, audience_id, epoch, filter_ciphertext, created_by)
    VALUES ('shrL', 'audL', 1, 'filtL', 'alice');
INSERT INTO public.audience_epoch_keys (audience_id, epoch, member_id, wrapped_epoch_privkey)
    VALUES ('audL', 1, 'synthL', 'wek_synth');   -- synthL is NOT an audience_members row
INSERT INTO public.entries (id, user_id, ciphertext, nonce, contribution_status)
    VALUES ('e_link', 'alice', 'ctL', 'nL', 'approved');
INSERT INTO public.entry_audience_grants (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
    VALUES ('e_link', 'audL', 1, 'alice', 'wdL', 'gsL');
-- token_hash stored exactly as the RPC recomputes it from the presented token.
INSERT INTO public.link_shares
    (id, audience_id, token_hash, member_id, wrapped_identity, identity_nonce, salt_enc,
     trust_bundle, trust_bundle_nonce, created_by)
VALUES
    ('lnk1', 'audL', encode(sha256(convert_to('plainL', 'UTF8')), 'hex'), 'synthL',
     'wid', 'idn', 'slt', 'tb', 'tbn', 'alice');
RESET role;

-- ---- anonymous has NO direct read on any base table or on link_shares.
SELECT expect_fail_anon('SELECT count(*) FROM public.link_shares',           'anon cannot read link_shares');
SELECT expect_fail_anon('SELECT count(*) FROM public.entries',               'anon cannot read entries');
SELECT expect_fail_anon('SELECT count(*) FROM public.entry_audience_grants', 'anon cannot read grants');
SELECT expect_fail_anon('SELECT count(*) FROM public.audiences',             'anon cannot read audiences');
SELECT expect_fail_anon('SELECT count(*) FROM public.audience_epoch_keys',   'anon cannot read epoch keys');

-- ---- anonymous CAN call the RPC and gets exactly the named link's ciphertext.
DO $$
DECLARE res json;
BEGIN
    res := link_fetch_as_anon('plainL');
    IF res IS NULL THEN
        RAISE EXCEPTION 'FAIL: RPC returned NULL for a live token';
    END IF;
    IF res->>'audience_id' <> 'audL' THEN
        RAISE EXCEPTION 'FAIL: RPC wrong audience %', res->>'audience_id';
    END IF;
    IF res->>'member_id' <> 'synthL' THEN
        RAISE EXCEPTION 'FAIL: RPC wrong synthetic member %', res->>'member_id';
    END IF;
    IF res->>'trust_bundle' <> 'tb' THEN
        RAISE EXCEPTION 'FAIL: RPC did not return the trust bundle';
    END IF;
    IF json_array_length(res->'entries') <> 1 THEN
        RAISE EXCEPTION 'FAIL: RPC entries length % (want 1)', json_array_length(res->'entries');
    END IF;
    IF json_array_length(res->'epoch_keys') <> 1 THEN
        RAISE EXCEPTION 'FAIL: RPC epoch_keys length % (want 1)', json_array_length(res->'epoch_keys');
    END IF;
    RAISE NOTICE 'PASS: anon RPC returns the live link slice';
END $$;

-- Unknown token reveals nothing.
DO $$
BEGIN
    IF link_fetch_as_anon('not-a-real-token') IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL: unknown token returned data';
    END IF;
    RAISE NOTICE 'PASS: unknown token returns NULL';
END $$;

-- Revoked link is denied by the RPC's own live-row check (§8).
RESET role;
UPDATE public.link_shares SET revoked = true WHERE id = 'lnk1';
RESET role;
DO $$
BEGIN
    IF link_fetch_as_anon('plainL') IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL: revoked link still served';
    END IF;
    RAISE NOTICE 'PASS: revoked link denied by RPC';
END $$;
RESET role;
UPDATE public.link_shares SET revoked = false WHERE id = 'lnk1';   -- restore for delete test
RESET role;

-- ---- link_shares own-row RLS: creator sees theirs, others see none.
SELECT assert_count('alice', 'SELECT count(*) FROM public.link_shares', 1,
    'alice sees her own link_shares row');
SELECT assert_count('carol', 'SELECT count(*) FROM public.link_shares', 0,
    'carol sees no link_shares');
SELECT expect_fail('carol',
    $q$INSERT INTO public.link_shares
        (id, audience_id, token_hash, member_id, wrapped_identity, identity_nonce, salt_enc,
         trust_bundle, trust_bundle_nonce, created_by)
       VALUES ('lnkX','audL','deadbeef','synthX','w','n','s','tb','tbn','alice')$q$,
    'carol cannot forge a link_shares row as alice');

-- ---- Change tracking (Section 7) ------------------------------------------
-- Cursors are stashed in session GUCs so queries run as other roles can read
-- them. mark(name) records audA's current seq / structure_seq.
RESET role;
CREATE OR REPLACE FUNCTION mark(name text) RETURNS void LANGUAGE sql AS $$
    SELECT set_config('test.' || name, seq::text, false),
           set_config('test.' || name || '_s', structure_seq::text, false)
      FROM public.audience_changes WHERE audience_id = 'audA';
$$;
CREATE OR REPLACE FUNCTION audA_seq() RETURNS bigint LANGUAGE sql AS $$
    SELECT seq FROM public.audience_changes WHERE audience_id = 'audA';
$$;
CREATE OR REPLACE FUNCTION audA_structure_seq() RETURNS bigint LANGUAGE sql AS $$
    SELECT structure_seq FROM public.audience_changes WHERE audience_id = 'audA';
$$;

SELECT assert_count('bob', $q$SELECT count(*) FROM public.audience_changes WHERE audience_id='audA'$q$, 1,
    'member bob sees audA''s change row');
SELECT assert_count('carol', 'SELECT count(*) FROM public.audience_changes', 0,
    'non-member carol sees no change rows');
SELECT expect_fail('bob',
    $q$UPDATE public.audience_changes SET seq = 0$q$,
    'bob cannot write audience_changes');
SELECT expect_fail('bob',
    $q$SELECT public.sharing_bump('audA', true)$q$,
    'sharing_bump is not callable through the API');

RESET role;
SELECT mark('c0');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.sharing_audience_delta('audA', current_setting('test.c0')::bigint)$q$, 0,
    'delta at the current cursor is empty');

-- A re-push of an unchanged entry (fresh nonce, same id) must not count.
RESET role;
SELECT test_as('alice', $q$UPDATE public.entries SET ciphertext='ct1b', nonce='n1b' WHERE id='e_appr'$q$);
RESET role;
DO $$
BEGIN
    IF audA_seq() <> current_setting('test.c0')::bigint THEN
        RAISE EXCEPTION 'FAIL: re-encrypting an entry moved the audience cursor';
    END IF;
    RAISE NOTICE 'PASS: re-encrypting an entry leaves the cursor alone';
END $$;

-- A client cannot rewrite a grant's change_seq.
RESET role;
SELECT test_as('alice', $q$UPDATE public.entry_audience_grants SET change_seq = 0 WHERE entry_id='e_appr'$q$);
RESET role;
DO $$
BEGIN
    IF (SELECT change_seq FROM public.entry_audience_grants WHERE entry_id='e_appr' AND audience_id='audA') = 0 THEN
        RAISE EXCEPTION 'FAIL: client PATCH rewrote grant change_seq';
    END IF;
    RAISE NOTICE 'PASS: grant change_seq is pinned against client writes';
END $$;

-- A new grant appears in the delta with its entry, and is not structural.
RESET role;
SELECT test_as('alice', $q$
    INSERT INTO public.entries (id, user_id, ciphertext, nonce) VALUES ('e_new','alice','ctN','nN');
    INSERT INTO public.entry_audience_grants (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig, valid_from)
    VALUES ('e_new','audA',(SELECT current_epoch FROM public.audiences WHERE id='audA'),'alice','wdN','gsN', now() - interval '1h')
$q$);
RESET role;
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.sharing_audience_delta('audA', current_setting('test.c0')::bigint)
       WHERE entry_id='e_new' AND entry->>'ciphertext' = 'ctN'$q$, 1,
    'new grant shows up in bob''s delta with its entry');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.sharing_audience_delta('audA', current_setting('test.c0')::bigint)$q$, 1,
    'delta holds only the new grant');
DO $$
BEGIN
    IF audA_seq() <= current_setting('test.c0')::bigint THEN
        RAISE EXCEPTION 'FAIL: grant insert did not move the cursor';
    END IF;
    IF audA_structure_seq() <> current_setting('test.c0_s')::bigint THEN
        RAISE EXCEPTION 'FAIL: grant insert counted as structural';
    END IF;
    RAISE NOTICE 'PASS: grant insert moves seq but not structure_seq';
END $$;

-- An entry that becomes invisible to bob (back to pending) is still reported,
-- with a NULL entry, so bob's client knows to drop it.
RESET role;
SELECT mark('c1');
SELECT test_as('alice', $q$UPDATE public.entries SET contribution_status='pending' WHERE id='e_new'$q$);
RESET role;
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.sharing_audience_delta('audA', current_setting('test.c1')::bigint)
       WHERE entry_id='e_new' AND entry IS NULL$q$, 1,
    'entry hidden from bob is reported with a NULL entry');

-- A tombstone flip is reported with deleted=true.
RESET role;
UPDATE public.entries SET contribution_status='approved' WHERE id='e_new';
SELECT mark('c2');
SELECT test_as('alice', $q$UPDATE public.entries SET deleted=true WHERE id='e_new'$q$);
RESET role;
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.sharing_audience_delta('audA', current_setting('test.c2')::bigint)
       WHERE entry_id='e_new' AND (entry->>'deleted')::boolean$q$, 1,
    'tombstoned entry is reported as deleted');

-- A deleted grant leaves a removal record members can read, not a delta row.
RESET role;
SELECT mark('c3');
SELECT test_as('alice', $q$DELETE FROM public.entry_audience_grants WHERE entry_id='e_new' AND audience_id='audA'$q$);
RESET role;
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.grant_removals
       WHERE audience_id='audA' AND entry_id='e_new' AND seq > current_setting('test.c3')::bigint$q$, 1,
    'grant delete is recorded in grant_removals');
SELECT assert_count('bob',
    $q$SELECT count(*) FROM public.sharing_audience_delta('audA', current_setting('test.c3')::bigint)$q$, 0,
    'deleted grant is absent from the delta');
SELECT assert_count('carol', 'SELECT count(*) FROM public.grant_removals', 0,
    'non-member carol sees no removals');

-- Removals older than 30 days are pruned on the next delete, advancing the floor.
RESET role;
UPDATE public.grant_removals SET removed_at = now() - interval '31 days' WHERE entry_id='e_new';
SELECT test_as('alice', $q$
    INSERT INTO public.entries (id, user_id, ciphertext, nonce) VALUES ('e_new2','alice','ctN2','nN2');
    INSERT INTO public.entry_audience_grants (entry_id, audience_id, epoch, author_id, wrapped_dek, author_sig)
    VALUES ('e_new2','audA',(SELECT current_epoch FROM public.audiences WHERE id='audA'),'alice','wdN2','gsN2');
    DELETE FROM public.entry_audience_grants WHERE entry_id='e_new2' AND audience_id='audA'
$q$);
RESET role;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.grant_removals WHERE entry_id='e_new') THEN
        RAISE EXCEPTION 'FAIL: 31-day-old removal was not pruned';
    END IF;
    IF (SELECT removals_floor FROM public.audience_changes WHERE audience_id='audA')
       <= current_setting('test.c3')::bigint THEN
        RAISE EXCEPTION 'FAIL: pruning did not advance removals_floor';
    END IF;
    RAISE NOTICE 'PASS: old removals pruned and floor advanced';
END $$;

-- Membership changes are structural. An invitee sees the change row (so the
-- client lists the team) but no grants, removals, or delta rows.
RESET role;
SELECT mark('c4');
SELECT test_as('alice', $q$INSERT INTO public.audience_members (audience_id, member_id, role, status)
                           VALUES ('audA','carol','member','invited')$q$);
RESET role;
DO $$
BEGIN
    IF audA_structure_seq() <= current_setting('test.c4_s')::bigint THEN
        RAISE EXCEPTION 'FAIL: member insert did not move structure_seq';
    END IF;
    RAISE NOTICE 'PASS: membership change is structural';
END $$;
SELECT assert_count('carol', $q$SELECT count(*) FROM public.audience_changes WHERE audience_id='audA'$q$, 1,
    'invitee carol sees audA''s change row');
SELECT assert_count('carol', 'SELECT count(*) FROM public.sharing_audience_delta(''audA'', 0)', 0,
    'invitee carol gets an empty delta');
SELECT assert_count('carol', 'SELECT count(*) FROM public.grant_removals', 0,
    'invitee carol sees no removals');
RESET role;
DELETE FROM public.audience_members WHERE audience_id='audA' AND member_id='carol';

-- ---- audiences DELETE is creator-only. bob (a member, not the creator)
-- cannot delete audA; alice can delete her link audience, and the cascade
-- reaps its link_shares row.
RESET role;
SELECT test_as('bob', $q$DELETE FROM public.audiences WHERE id='audA'$q$);
RESET role;
SELECT assert_count('alice', $q$SELECT count(*) FROM public.audiences WHERE id='audA'$q$, 1,
    'non-creator bob cannot delete audA');
RESET role;
SELECT test_as('alice', $q$DELETE FROM public.audiences WHERE id='audL'$q$);
RESET role;
SELECT assert_count('alice', $q$SELECT count(*) FROM public.audiences WHERE id='audL'$q$, 0,
    'alice deletes her own link audience');
SELECT assert_count('alice', $q$SELECT count(*) FROM public.link_shares WHERE audience_id='audL'$q$, 0,
    'deleting the link audience cascades its link_shares row away');

-- The creator deleting a whole team cascades through the change-tracking
-- triggers without tripping them (the audience is gone before its members and
-- grants are), and reaps the team's change row and removals.
RESET role;
SELECT test_as('alice', $q$DELETE FROM public.audiences WHERE id='audA'$q$);
RESET role;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.audiences WHERE id='audA')
       OR EXISTS (SELECT 1 FROM public.audience_changes WHERE audience_id='audA')
       OR EXISTS (SELECT 1 FROM public.grant_removals WHERE audience_id='audA')
       OR EXISTS (SELECT 1 FROM public.entry_audience_grants WHERE audience_id='audA') THEN
        RAISE EXCEPTION 'FAIL: team delete left rows behind';
    END IF;
    RAISE NOTICE 'PASS: creator deletes a team and the cascade reaps its tracking rows';
END $$;

\echo '==================================================================='
\echo 'ALL RLS ASSERTIONS PASSED'
\echo '==================================================================='
