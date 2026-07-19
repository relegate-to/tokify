import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

import type { SharedMeta } from '@/types';
import { readInviteEmails } from '@/lib/invite-emails';
import { useSharedTeamsWith } from '@/lib/teams-cache';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from '@/components/ui/hover-card';
import { Separator } from '@/components/ui/separator';
import { MemberAvatar } from '@/components/MemberAvatar';

// The author card behind a shared entry's avatar. Everything here is read from
// cache — the locally-saved invite email and the polled team roster — so hovering
// never issues a request.
export function SharedAuthorBadge({ shared }: { shared: SharedMeta }) {
    const name = shared.authorName.trim() || 'Someone';
    const email = readInviteEmails()[shared.authorId] || '';
    const sharedTeams = useSharedTeamsWith(shared.authorId);

    // Prefer the cached roster's team names; if the poll hasn't populated it yet,
    // fall back to the team this very entry arrived through.
    const teamNames = sharedTeams.length
        ? sharedTeams.map((t) => t.Name.trim() || 'Untitled team')
        : shared.teamName.trim()
          ? [shared.teamName.trim()]
          : [];

    const [copied, setCopied] = useState(false);
    const copyEmail = () => {
        navigator.clipboard
            .writeText(email)
            .then(() => {
                setCopied(true);
                toast.success('Email copied');
                setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => toast.error('Could not copy email'));
    };

    return (
        <HoverCard openDelay={150} closeDelay={100}>
            <HoverCardTrigger asChild>
                <MemberAvatar
                    seed={shared.authorId}
                    label={name}
                    titled={false}
                    className="cursor-default"
                />
            </HoverCardTrigger>
            <HoverCardContent align="end" side="top" className="w-72 p-0">
                <div className="flex items-start gap-3 p-3.5">
                    <MemberAvatar
                        seed={shared.authorId}
                        label={name}
                        titled={false}
                        className="size-10 text-sm"
                    />
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{name}</div>
                        {email ? (
                            <div className="mt-0.5 flex items-center gap-1">
                                <span className="truncate text-xs text-muted-foreground">
                                    {email}
                                </span>
                                <button
                                    type="button"
                                    onClick={copyEmail}
                                    title="Copy email"
                                    className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    {copied ? (
                                        <Check className="size-3 text-emerald-500" />
                                    ) : (
                                        <Copy className="size-3" />
                                    )}
                                </button>
                            </div>
                        ) : (
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                No saved email
                            </div>
                        )}
                    </div>
                </div>

                {teamNames.length > 0 && (
                    <>
                        <Separator />
                        <div className="p-3.5">
                            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                In teams with you
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {teamNames.map((n) => (
                                    <span
                                        key={n}
                                        className="inline-flex max-w-full items-center truncate rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
                                    >
                                        {n}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </HoverCardContent>
        </HoverCard>
    );
}
