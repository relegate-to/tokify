import { useEffect, useMemo, useState } from 'react';
import {
    ArrowLeft,
    Copy,
    Link2,
    Loader2,
    RefreshCw,
    ShieldCheck,
    Trash2,
    Users,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import {
    SharingCreateLink,
    SharingListLinks,
    SharingRevokeLink,
    SyncStatus,
} from '../../wailsjs/go/main/App';
import { neonsync } from '../../wailsjs/go/models';

import { authErrorText } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@/components/ui/empty';
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

const SHARE_BASE_URL =
    import.meta.env.VITE_TOKIFY_SHARE_BASE_URL || 'https://tokify.app/share';

const SINCE_OPTIONS = [
    { label: '7 days', value: 7 },
    { label: '30 days', value: 30 },
    { label: '90 days', value: 90 },
    { label: 'All time', value: 0 },
];

const EXPIRY_OPTIONS = [
    { label: '24 hours', value: 24 },
    { label: '7 days', value: 24 * 7 },
    { label: '30 days', value: 24 * 30 },
];

function linkURL(link: neonsync.LinkShare) {
    return `${SHARE_BASE_URL.replace(/\/$/, '')}/${link.AudienceID}#${link.Secret}`;
}

function formatDate(value: string) {
    if (!value) return 'No expiry';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return format(d, "d MMM yyyy 'at' HH:mm");
}

async function copyText(text: string, label: string) {
    try {
        await navigator.clipboard.writeText(text);
        toast.success(label);
    } catch {
        toast.error('Could not copy to clipboard');
    }
}

export function SharingView({
    projects,
    onBack,
}: {
    projects: string[];
    onBack: () => void;
}) {
    const [links, setLinks] = useState<neonsync.LinkShareInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [revoking, setRevoking] = useState<string | null>(null);
    const [status, setStatus] = useState<neonsync.SyncStatus | null>(null);
    const [project, setProject] = useState('');
    const [sinceDays, setSinceDays] = useState(30);
    const [validForHours, setValidForHours] = useState(24 * 7);
    const [createdURL, setCreatedURL] = useState('');

    const sortedProjects = useMemo(
        () => [...projects].filter(Boolean).sort((a, b) => a.localeCompare(b)),
        [projects],
    );

    const loadLinks = () => {
        setLoading(true);
        Promise.all([SyncStatus(), SharingListLinks()])
            .then(([nextStatus, nextLinks]) => {
                setStatus(nextStatus);
                setLinks(nextLinks ?? []);
            })
            .catch((e) => {
                setLinks([]);
                toast.error(authErrorText(e));
            })
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        loadLinks();
    }, []);

    const canCreate = !!status?.configured && !!status?.unlocked;
    const filterProjects = project === '' ? [] : [project];
    const scopeLabel = project ? project : 'all projects';

    const createLink = () => {
        if (creating) return;
        setCreating(true);
        setCreatedURL('');
        const t = toast.loading('Creating encrypted link…');
        SharingCreateLink(filterProjects, sinceDays, validForHours)
            .then((link) => {
                const url = linkURL(link);
                setCreatedURL(url);
                toast.success('Link created', {
                    id: t,
                    description: 'Copy it now; the fragment secret is only shown here.',
                });
                return SharingListLinks();
            })
            .then((nextLinks) => setLinks(nextLinks ?? []))
            .catch((e) => toast.error(authErrorText(e), { id: t }))
            .finally(() => setCreating(false));
    };

    const revokeLink = (audienceID: string) => {
        if (revoking) return;
        setRevoking(audienceID);
        SharingRevokeLink(audienceID)
            .then(() => {
                toast.success('Link revoked');
                setLinks((current) =>
                    current.filter((link) => link.AudienceID !== audienceID),
                );
            })
            .catch((e) => toast.error(authErrorText(e)))
            .finally(() => setRevoking(null));
    };

    return (
        <div className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300">
            <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon-xs" onClick={onBack} title="Back">
                    <ArrowLeft />
                </Button>
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Sharing
                </h2>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Link2 className="opacity-70" />
                        Create a view-only link
                    </CardTitle>
                    <CardDescription>
                        Share a filtered slice of your completed activity. The
                        URL fragment is the read key, so treat it like a password.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    {!canCreate && (
                        <Alert>
                            <ShieldCheck />
                            <AlertTitle>Sign in and unlock sync first</AlertTitle>
                            <AlertDescription>
                                Link sharing uses the same encrypted identity as
                                sync. Open Account, sign in, and make sure sync
                                is configured on this device.
                            </AlertDescription>
                        </Alert>
                    )}

                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="share-project">Project</FieldLabel>
                            <select
                                id="share-project"
                                value={project}
                                onChange={(e) => setProject(e.target.value)}
                                disabled={creating || !canCreate}
                                className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                            >
                                <option value="">All projects</option>
                                {sortedProjects.map((p) => (
                                    <option key={p} value={p}>
                                        {p}
                                    </option>
                                ))}
                            </select>
                            <FieldDescription>
                                Pick a project or share the full filtered history.
                            </FieldDescription>
                        </Field>

                        <Field>
                            <FieldLabel>History window</FieldLabel>
                            <div className="flex flex-wrap gap-2">
                                {SINCE_OPTIONS.map((option) => (
                                    <Button
                                        key={option.value}
                                        type="button"
                                        variant={
                                            sinceDays === option.value
                                                ? 'secondary'
                                                : 'outline'
                                        }
                                        size="sm"
                                        disabled={creating || !canCreate}
                                        onClick={() => setSinceDays(option.value)}
                                    >
                                        {option.label}
                                    </Button>
                                ))}
                            </div>
                        </Field>

                        <Field>
                            <FieldLabel>Expires after</FieldLabel>
                            <div className="flex flex-wrap gap-2">
                                {EXPIRY_OPTIONS.map((option) => (
                                    <Button
                                        key={option.value}
                                        type="button"
                                        variant={
                                            validForHours === option.value
                                                ? 'secondary'
                                                : 'outline'
                                        }
                                        size="sm"
                                        disabled={creating || !canCreate}
                                        onClick={() => setValidForHours(option.value)}
                                    >
                                        {option.label}
                                    </Button>
                                ))}
                            </div>
                        </Field>
                    </FieldGroup>

                    <div className="rounded-xl border bg-muted/30 p-3 text-sm">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Scope</span>
                            <span className="font-medium">{scopeLabel}</span>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">Access</span>
                            <span>Read-only until {validForHours / 24}d expiry</span>
                        </div>
                    </div>

                    <Button
                        className="self-start"
                        onClick={createLink}
                        disabled={creating || !canCreate}
                    >
                        {creating ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <Link2 data-icon="inline-start" />
                        )}
                        Create link
                    </Button>

                    {createdURL && (
                        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                            <div className="flex items-center gap-2">
                                <Badge variant="secondary">New link</Badge>
                                <span className="text-xs text-muted-foreground">
                                    Copy before closing this view
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Input
                                    value={createdURL}
                                    readOnly
                                    className="font-mono text-xs"
                                    onFocus={(e) => e.currentTarget.select()}
                                />
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => copyText(createdURL, 'Link copied')}
                                >
                                    <Copy data-icon="inline-start" />
                                    Copy
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Active links</CardTitle>
                    <CardDescription>
                        Revoke a link to immediately close its anonymous read path.
                    </CardDescription>
                    <CardAction>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={loadLinks}
                            disabled={loading}
                            title="Refresh links"
                        >
                            <RefreshCw className={cn(loading && 'animate-spin')} />
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                            <Loader2 className="animate-spin" />
                            Loading links
                        </div>
                    ) : links.length === 0 ? (
                        <Empty>
                            <EmptyHeader>
                                <EmptyTitle>No active links</EmptyTitle>
                                <EmptyDescription>
                                    Create one above when you need to share a
                                    read-only slice of time.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {links.map((link, index) => (
                                <div key={link.AudienceID} className="flex flex-col gap-3">
                                    {index > 0 && <Separator />}
                                    <div className="flex items-center gap-3">
                                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                            <Users className="opacity-70" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate font-mono text-xs">
                                                {link.AudienceID}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                Expires {formatDate(link.ValidUntil)}
                                            </div>
                                        </div>
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            disabled={revoking === link.AudienceID}
                                            onClick={() => revokeLink(link.AudienceID)}
                                        >
                                            {revoking === link.AudienceID ? (
                                                <Loader2
                                                    data-icon="inline-start"
                                                    className="animate-spin"
                                                />
                                            ) : (
                                                <Trash2 data-icon="inline-start" />
                                            )}
                                            Revoke
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
