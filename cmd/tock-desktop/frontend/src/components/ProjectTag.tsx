import { Users } from 'lucide-react';

import type { neonsync } from '../../wailsjs/go/models';
import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { useProjectShare } from '@/lib/project-shares';
import { useTeamNames } from '@/lib/teams-cache';
import { memberLabel } from '@/lib/member-label';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from '@/components/ui/hover-card';
import { Separator } from '@/components/ui/separator';
import { MemberAvatar } from '@/components/MemberAvatar';

const MAX_ROSTER = 6;

export function ProjectTag({
    project,
    className,
    team,
}: {
    project: string;
    className?: string;
    // Force the team marker on regardless of the local roster — used for pulled-in
    // shared entries, which are team-shared by definition but whose project isn't
    // one of yours. Left undefined for your own projects, where it's derived from
    // whether the project is shared with anyone.
    team?: boolean;
}) {
    const share = useProjectShare(project);
    const members = share?.Members ?? [];
    const isTeam = team ?? members.length > 0;
    // Only your own shared projects carry roster data worth a card; a forced marker
    // (a pulled-in entry) has none, so it stays a plain icon with a tooltip.
    const hasCard = members.length > 0;

    const badge = (
        <span
            className={cn(
                'inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground',
                hasCard && 'cursor-default',
                className,
            )}
        >
            <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: projectColor(project) }}
            />
            <span className="truncate">{project}</span>
            {isTeam && (
                <span
                    className="inline-flex shrink-0 text-muted-foreground/60"
                    title={hasCard ? undefined : 'Shared with a team'}
                    aria-label="Shared with a team"
                >
                    <Users className="size-3" />
                </span>
            )}
        </span>
    );

    if (!hasCard) return badge;

    return (
        <HoverCard openDelay={150} closeDelay={100}>
            <HoverCardTrigger asChild>{badge}</HoverCardTrigger>
            <HoverCardContent align="start" side="top" className="w-64 p-0">
                <ProjectShareCard
                    project={project}
                    members={members}
                    audienceIDs={share?.AudienceIDs ?? []}
                />
            </HoverCardContent>
        </HoverCard>
    );
}

function ProjectShareCard({
    project,
    members,
    audienceIDs,
}: {
    project: string;
    members: neonsync.TeamMember[];
    audienceIDs: string[];
}) {
    const teamNames = useTeamNames(audienceIDs);
    const roster = members.slice(0, MAX_ROSTER);
    const overflow = members.length - roster.length;

    return (
        <div className="flex flex-col">
            <div className="p-3.5 pb-3">
                <div className="flex items-center gap-2">
                    <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: projectColor(project) }}
                    />
                    <span className="truncate text-sm font-semibold">{project}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                    Shared with {members.length}{' '}
                    {members.length === 1 ? 'person' : 'people'}
                </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5 p-3.5 py-3">
                {roster.map((m) => (
                    <div key={m.UserID} className="flex items-center gap-2">
                        <MemberAvatar
                            seed={m.UserID}
                            label={memberLabel(m)}
                            titled={false}
                            className="size-6"
                        />
                        <span className="truncate text-sm">{memberLabel(m)}</span>
                    </div>
                ))}
                {overflow > 0 && (
                    <div className="pl-8 text-xs text-muted-foreground">
                        +{overflow} more
                    </div>
                )}
            </div>

            {teamNames.length > 0 && (
                <>
                    <Separator />
                    <div className="p-3.5 pt-3">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            {teamNames.length === 1 ? 'Via team' : 'Via teams'}
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
        </div>
    );
}
