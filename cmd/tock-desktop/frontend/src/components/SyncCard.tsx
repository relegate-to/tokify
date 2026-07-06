import { useEffect, useState } from 'react';
import { Cloud, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { SyncNow, SyncSetEnabled, SyncStatus } from '../../wailsjs/go/main/App';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { neonsync } from '../../wailsjs/go/models';

import { cn } from '@/lib/utils';
import { authErrorText } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

export function SyncCard({ signedIn }: { signedIn: boolean }) {
    const [status, setStatus] = useState<neonsync.SyncStatus | null>(null);
    const [toggling, setToggling] = useState(false);
    const [syncing, setSyncing] = useState(false);

    useEffect(() => {
        if (!signedIn) {
            setStatus(null);
            return;
        }
        let cancelled = false;
        SyncStatus()
            .then((s) => {
                if (!cancelled) setStatus(s);
            })
            .catch(() => {
                if (!cancelled) setStatus(null);
            });
        return () => {
            cancelled = true;
        };
    }, [signedIn]);

    // Background auto-sync runs on a timer in Go; refresh the card when it fires
    // so "Last synced" stays current without reopening the panel.
    useEffect(() => {
        if (!signedIn) return;
        return EventsOn('sync:updated', (s: neonsync.SyncStatus) => setStatus(s));
    }, [signedIn]);

    const toggleEnabled = (v: boolean) => {
        if (toggling) return;
        setToggling(true);
        SyncSetEnabled(v)
            .then(setStatus)
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setToggling(false));
    };

    const runSync = () => {
        if (syncing) return;
        setSyncing(true);
        const t = toast.loading('Syncing…');
        SyncNow()
            .then((s) => {
                setStatus(s);
                toast.success('Synced', {
                    id: t,
                    description: `${s.entry_count} ${
                        s.entry_count === 1 ? 'entry' : 'entries'
                    } encrypted`,
                });
            })
            .catch((e) => toast.error(authErrorText(e), { id: t }))
            .finally(() => setSyncing(false));
    };

    const configured = !!status?.configured;
    const enabled = !!status?.enabled;
    const lastSyncLabel = status?.last_sync
        ? format(new Date(status.last_sync), "d MMM yyyy 'at' HH:mm")
        : 'Never';

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Cloud className="size-4 opacity-70" />
                    Sync
                </CardTitle>
                <CardDescription className="flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5 shrink-0 opacity-70" />
                    End-to-end encrypted. Only you can read your history.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {!signedIn ? (
                    <p className="py-1 text-sm text-muted-foreground">
                        Sign in above to sync your activities across devices.
                    </p>
                ) : !configured ? (
                    <p className="py-1 text-sm text-muted-foreground">
                        Set a Neon Data API URL to turn on encrypted sync.
                    </p>
                ) : (
                    <>
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex min-w-0 flex-col">
                                <span className="text-sm">
                                    Sync across devices
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    Your local log stays the source of truth.
                                </span>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={enabled}
                                disabled={toggling}
                                onClick={() => toggleEnabled(!enabled)}
                                className={cn(
                                    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                                    enabled ? 'bg-foreground' : 'bg-muted',
                                )}
                            >
                                <span
                                    className={cn(
                                        'inline-block size-4 rounded-full bg-background shadow transition-transform',
                                        enabled
                                            ? 'translate-x-[1.125rem]'
                                            : 'translate-x-0.5',
                                    )}
                                />
                            </button>
                        </div>

                        {enabled && (
                            <div className="flex flex-col gap-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                                <Separator />
                                <div className="flex items-center justify-between gap-3 text-sm">
                                    <span className="text-muted-foreground">
                                        Last synced
                                    </span>
                                    <span className="tabular-nums">
                                        {lastSyncLabel}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between gap-3 text-sm">
                                    <span className="text-muted-foreground">
                                        Entries in the cloud
                                    </span>
                                    <span className="font-mono tabular-nums">
                                        {status?.entry_count ?? 0}
                                    </span>
                                </div>
                                {!status?.unlocked && (
                                    <p className="text-xs text-muted-foreground">
                                        Sign in again to unlock your encryption
                                        key on this device.
                                    </p>
                                )}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="self-start"
                                    onClick={runSync}
                                    disabled={syncing || !status?.unlocked}
                                >
                                    {syncing ? (
                                        <Loader2
                                            data-icon="inline-start"
                                            className="animate-spin"
                                        />
                                    ) : (
                                        <RefreshCw data-icon="inline-start" />
                                    )}
                                    Sync now
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
