import { useEffect, useMemo, useState } from 'react';
import {
    ArrowLeft,
    Clock,
    FolderKanban,
    ListChecks,
    Loader2,
    LogOut,
    MailCheck,
    Timer,
} from 'lucide-react';

import {
    AuthResendVerification,
    AuthSignIn,
    AuthSignOut,
    AuthSignUp,
    AuthStatus,
    AuthVerifyEmail,
} from '../../wailsjs/go/main/App';
import { neonauth } from '../../wailsjs/go/models';

import type { Activity } from '@/types';
import { authErrorText } from '@/lib/errors';
import { formatTotal } from '@/lib/time';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SyncCard } from '@/components/SyncCard';

export function AccountView({
    running,
    recent,
    projects,
    onBack,
}: {
    running: Activity | null;
    recent: Activity[];
    projects: string[];
    onBack: () => void;
}) {
    const [status, setStatus] = useState<neonauth.Status | null>(null);
    const [loading, setLoading] = useState(true);
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    // Set to the pending email after a sign-up that requires verification; while
    // present the card shows the code-entry step instead of the sign-in tabs.
    const [pendingEmail, setPendingEmail] = useState('');
    const [code, setCode] = useState('');
    const [notice, setNotice] = useState('');

    useEffect(() => {
        let cancelled = false;
        AuthStatus()
            .then((s) => {
                if (!cancelled) setStatus(s);
            })
            .catch(() => {
                if (!cancelled) setStatus(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const submitAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting) return;
        setError('');
        setSubmitting(true);
        try {
            const next =
                mode === 'signin'
                    ? await AuthSignIn(email.trim(), password)
                    : await AuthSignUp(email.trim(), password, name.trim());
            if (next.pending_verification) {
                // Account created; Neon Auth emailed a code. Hold the password so
                // verifyEmail can sign in once the code is confirmed.
                setPendingEmail(next.email || email.trim());
                setCode('');
                setNotice('');
                return;
            }
            setStatus(next);
            setPassword('');
        } catch (err) {
            setError(authErrorText(err));
        } finally {
            setSubmitting(false);
        }
    };

    const verifyEmail = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting) return;
        setError('');
        setSubmitting(true);
        try {
            const next = await AuthVerifyEmail(
                pendingEmail,
                password,
                code.trim(),
            );
            setStatus(next);
            setPassword('');
            setCode('');
            setPendingEmail('');
            setNotice('');
        } catch (err) {
            setError(authErrorText(err));
        } finally {
            setSubmitting(false);
        }
    };

    const resendCode = async () => {
        if (submitting) return;
        setError('');
        setNotice('');
        setSubmitting(true);
        try {
            await AuthResendVerification(pendingEmail);
            setNotice('A new code is on its way.');
        } catch (err) {
            setError(authErrorText(err));
        } finally {
            setSubmitting(false);
        }
    };

    const cancelPending = () => {
        if (submitting) return;
        setPendingEmail('');
        setCode('');
        setError('');
        setNotice('');
    };

    const signOut = async () => {
        if (submitting) return;
        setError('');
        setSubmitting(true);
        try {
            await AuthSignOut();
            setStatus(await AuthStatus());
            setPassword('');
        } catch (err) {
            setError(authErrorText(err));
        } finally {
            setSubmitting(false);
        }
    };

    const stats = useMemo(() => {
        const all: Activity[] = running ? [running, ...recent] : recent;
        let totalMs = 0;
        let longestMs = 0;
        const projectSet = new Set<string>();
        const dayKeys = new Set<string>();
        let firstStart: number | null = null;
        for (const a of all) {
            const start = new Date(a.start_time as any).getTime();
            const end = a.end_time
                ? new Date(a.end_time as any).getTime()
                : Date.now();
            const dur = Math.max(0, end - start);
            totalMs += dur;
            if (dur > longestMs) longestMs = dur;
            if (a.project) projectSet.add(a.project);
            const d = new Date(start);
            dayKeys.add(
                `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
            );
            if (firstStart === null || start < firstStart) firstStart = start;
        }
        const days = dayKeys.size;
        return {
            totalMs,
            activityCount: all.length,
            projectCount: projectSet.size || projects.length,
            days,
            longestMs,
            avgPerDayMs: days > 0 ? Math.round(totalMs / days) : 0,
            firstStart,
        };
    }, [running, recent, projects]);

    const signedInName = (status?.name ?? '').trim();
    const signedInEmail = (status?.email ?? '').trim();
    const initials = useMemo(() => {
        const source = signedInName || signedInEmail;
        if (!source) return 'YOU';
        const parts = source
            .replace(/@.*$/, '')
            .split(/[\s._-]+/)
            .filter(Boolean);
        if (parts.length === 0) return source.slice(0, 2).toUpperCase();
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }, [signedInName, signedInEmail]);

    const accountDescription = !status?.configured
        ? 'Accounts are optional. Your time is always saved on this Mac.'
        : status.signed_in
          ? "You're signed in."
          : pendingEmail
            ? `Enter the code we emailed to ${pendingEmail}.`
            : mode === 'signin'
              ? 'Sign in to your Tokify account.'
              : 'Create a Tokify account.';

    return (
        <div className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300">
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onBack}
                    title="Back"
                >
                    <ArrowLeft />
                </Button>
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Account
                </h2>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Account</CardTitle>
                    <CardDescription>{accountDescription}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    {loading ? (
                        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            Checking your account
                        </div>
                    ) : !status?.configured ? (
                        <div className="flex flex-col gap-1.5 py-1 text-sm text-muted-foreground">
                            <span>No account service connected yet.</span>
                            <span className="text-xs">
                                Set a Neon Auth URL to sign in.
                            </span>
                        </div>
                    ) : status.signed_in ? (
                        <div className="flex items-center gap-4">
                            <div
                                aria-hidden
                                className="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium tracking-wide text-foreground/80"
                            >
                                {initials}
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm font-medium">
                                    {signedInName || 'Signed in'}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                    {signedInEmail || 'No email'}
                                </span>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={signOut}
                                disabled={submitting}
                            >
                                {submitting ? (
                                    <Loader2
                                        data-icon="inline-start"
                                        className="animate-spin"
                                    />
                                ) : (
                                    <LogOut data-icon="inline-start" />
                                )}
                                Sign out
                            </Button>
                        </div>
                    ) : pendingEmail ? (
                        <form
                            onSubmit={verifyEmail}
                            className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-top-1 duration-200"
                        >
                            <div className="flex items-start gap-3">
                                <div
                                    aria-hidden
                                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/70"
                                >
                                    <MailCheck className="size-4" />
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    We emailed a verification code to{' '}
                                    <span className="font-medium text-foreground">
                                        {pendingEmail}
                                    </span>
                                    . Enter it below to finish setting up your
                                    account.
                                </p>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label
                                    htmlFor="auth-code"
                                    className="text-xs text-muted-foreground"
                                >
                                    Verification code
                                </label>
                                <Input
                                    id="auth-code"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                    placeholder="123456"
                                    autoComplete="one-time-code"
                                    inputMode="numeric"
                                    autoFocus
                                    spellCheck={false}
                                    className="font-mono tracking-[0.3em]"
                                    required
                                />
                            </div>
                            {error && (
                                <p className="text-xs text-destructive">
                                    {error}
                                </p>
                            )}
                            {notice && (
                                <p className="text-xs text-muted-foreground">
                                    {notice}
                                </p>
                            )}
                            <Button
                                type="submit"
                                size="sm"
                                disabled={submitting || !code.trim()}
                            >
                                {submitting && (
                                    <Loader2
                                        data-icon="inline-start"
                                        className="animate-spin"
                                    />
                                )}
                                Verify email
                            </Button>
                            <div className="flex items-center justify-between">
                                <button
                                    type="button"
                                    onClick={cancelPending}
                                    disabled={submitting}
                                    className="text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    onClick={resendCode}
                                    disabled={submitting}
                                    className="text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
                                >
                                    Resend code
                                </button>
                            </div>
                        </form>
                    ) : (
                        <>
                            <Tabs
                                value={mode}
                                onValueChange={(v) => {
                                    setMode(v as 'signin' | 'signup');
                                    setError('');
                                }}
                            >
                                <TabsList className="w-full">
                                    <TabsTrigger
                                        value="signin"
                                        className="flex-1"
                                    >
                                        Sign in
                                    </TabsTrigger>
                                    <TabsTrigger
                                        value="signup"
                                        className="flex-1"
                                    >
                                        Create account
                                    </TabsTrigger>
                                </TabsList>
                            </Tabs>
                            <form
                                key={mode}
                                onSubmit={submitAuth}
                                className="flex flex-col gap-3 animate-in fade-in-0 slide-in-from-top-1 duration-200"
                            >
                                {mode === 'signup' && (
                                    <div className="flex flex-col gap-1.5">
                                        <label
                                            htmlFor="auth-name"
                                            className="text-xs text-muted-foreground"
                                        >
                                            Name
                                        </label>
                                        <Input
                                            id="auth-name"
                                            value={name}
                                            onChange={(e) =>
                                                setName(e.target.value)
                                            }
                                            placeholder="Your name"
                                            autoComplete="name"
                                            spellCheck={false}
                                        />
                                    </div>
                                )}
                                <div className="flex flex-col gap-1.5">
                                    <label
                                        htmlFor="auth-email"
                                        className="text-xs text-muted-foreground"
                                    >
                                        Email
                                    </label>
                                    <Input
                                        id="auth-email"
                                        type="email"
                                        value={email}
                                        onChange={(e) =>
                                            setEmail(e.target.value)
                                        }
                                        placeholder="you@example.com"
                                        autoComplete="email"
                                        spellCheck={false}
                                        required
                                    />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <label
                                        htmlFor="auth-password"
                                        className="text-xs text-muted-foreground"
                                    >
                                        Password
                                    </label>
                                    <Input
                                        id="auth-password"
                                        type="password"
                                        value={password}
                                        onChange={(e) =>
                                            setPassword(e.target.value)
                                        }
                                        placeholder={
                                            mode === 'signin'
                                                ? 'Your password'
                                                : 'At least 8 characters'
                                        }
                                        autoComplete={
                                            mode === 'signin'
                                                ? 'current-password'
                                                : 'new-password'
                                        }
                                        required
                                    />
                                </div>
                                {error && (
                                    <p className="text-xs text-destructive">
                                        {error}
                                    </p>
                                )}
                                <Button
                                    type="submit"
                                    size="sm"
                                    className="mt-1"
                                    disabled={submitting}
                                >
                                    {submitting && (
                                        <Loader2
                                            data-icon="inline-start"
                                            className="animate-spin"
                                        />
                                    )}
                                    {mode === 'signin'
                                        ? 'Sign in'
                                        : 'Create account'}
                                </Button>
                            </form>
                        </>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Overview</CardTitle>
                    <CardDescription>
                        A snapshot of your tracked time so far.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <StatBlock
                            icon={<Timer className="size-3.5" />}
                            label="Total time"
                            value={formatTotal(stats.totalMs)}
                        />
                        <StatBlock
                            icon={<ListChecks className="size-3.5" />}
                            label="Activities"
                            value={stats.activityCount.toString()}
                        />
                        <StatBlock
                            icon={<FolderKanban className="size-3.5" />}
                            label="Projects"
                            value={stats.projectCount.toString()}
                        />
                        <StatBlock
                            icon={<Clock className="size-3.5" />}
                            label="Active days"
                            value={stats.days.toString()}
                        />
                    </div>
                    {(stats.longestMs > 0 || stats.firstStart !== null) && (
                        <>
                            <Separator className="my-4" />
                            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                                {stats.longestMs > 0 && (
                                    <div className="flex items-center justify-between gap-3">
                                        <dt className="text-muted-foreground">
                                            Longest session
                                        </dt>
                                        <dd className="font-mono tabular-nums">
                                            {formatTotal(stats.longestMs)}
                                        </dd>
                                    </div>
                                )}
                                {stats.days > 0 && (
                                    <div className="flex items-center justify-between gap-3">
                                        <dt className="text-muted-foreground">
                                            Avg per active day
                                        </dt>
                                        <dd className="font-mono tabular-nums">
                                            {formatTotal(stats.avgPerDayMs)}
                                        </dd>
                                    </div>
                                )}
                                {stats.firstStart !== null && (
                                    <div className="flex items-center justify-between gap-3 sm:col-span-2">
                                        <dt className="text-muted-foreground">
                                            Tracking since
                                        </dt>
                                        <dd className="tabular-nums">
                                            {new Date(
                                                stats.firstStart,
                                            ).toLocaleDateString(undefined, {
                                                day: '2-digit',
                                                month: 'short',
                                                year: 'numeric',
                                            })}
                                        </dd>
                                    </div>
                                )}
                            </dl>
                        </>
                    )}
                </CardContent>
            </Card>

            <SyncCard signedIn={!!status?.signed_in} />
        </div>
    );
}

function StatBlock({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
}) {
    return (
        <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {icon}
                {label}
            </span>
            <span className="font-mono text-lg leading-tight tabular-nums">
                {value}
            </span>
        </div>
    );
}
