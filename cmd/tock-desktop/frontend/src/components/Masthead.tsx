import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import {
    Activity as ActivityIcon,
    BarChart3,
    Download,
    FileText,
    List,
    Mail,
    Settings as SettingsIcon,
    Share2,
    User,
    Users,
} from 'lucide-react';

import type { Activity, View } from '@/types';
import type { main, neonauth } from '../../wailsjs/go/models';
import { cn } from '@/lib/utils';
import { accountDisplayName, accountInitials } from '@/lib/account';
import { formatDuration } from '@/lib/time';
import { projectColor } from '@/lib/colors';
import { useNow } from '@/lib/use-now';
import {
    activityTitle,
    buildActivityShorthandTitle,
} from '@/lib/activity-label';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExportDialog } from '@/components/ExportDialog';

const dragStyle = {
    // Wails draggable hint and webkit equivalent
    ['--wails-draggable' as any]: 'drag',
    WebkitAppRegion: 'drag',
} as React.CSSProperties;

const noDragStyle = {
    ['--wails-draggable' as any]: 'no-drag',
    WebkitAppRegion: 'no-drag',
} as React.CSSProperties;

const MASTHEAD_INTRO_SHOW_MS = 2000;
const MASTHEAD_INTRO_HIDE_MS = 4000;
const SIZE_TRANSITION = 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
const TAB_GROUP_PADDING_X = 6;
const TAB_GROUP_GAP = 4;
const TAB_PADDING_X = 22;
const TAB_ICON_WIDTH = 13;
const TAB_CONTENT_GAP = 7;
const IDLE_ACTIVITY_LABEL_WIDTH = 64;
const RUNNING_ACTIVITY_LABEL_MIN_WIDTH = 28;
const RUNNING_ACTIVITY_LABEL_MAX_WIDTH = 160;
const HISTORY_TAB_WIDTH = 66;
const LOG_ICON_PANEL_WIDTH = 88;
const LOG_VIEWS: View[] = ['history', 'reports', 'charts', 'stats'];

export function Masthead({
    view,
    onView,
    running,
    showAccount,
    account,
    projects,
    invites,
    hasShared,
}: {
    view: View;
    onView: (v: View) => void;
    running: Activity | null;
    showAccount: boolean;
    account: neonauth.Status | null;
    projects: string[];
    invites: main.TeamView[];
    hasShared: boolean;
}) {
    const date = new Date()
        .toLocaleDateString(undefined, {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
        })
        .toLowerCase();
    const [introTokify, setIntroTokify] = useState(false);
    const [hover, setHover] = useState(false);
    const [open, setOpen] = useState(false);
    const [openedAsTokify, setOpenedAsTokify] = useState(false);
    const [nudgeKey, setNudgeKey] = useState(0);
    const [runningShorthand, setRunningShorthand] = useState<string | null>(null);
    const [logHover, setLogHover] = useState(false);
    const hasRunning = !!running;
    const now = useNow(hasRunning);

    useEffect(() => {
        const showId = window.setTimeout(
            () => setIntroTokify(true),
            MASTHEAD_INTRO_SHOW_MS,
        );
        const hideId = window.setTimeout(
            () => setIntroTokify(false),
            MASTHEAD_INTRO_HIDE_MS,
        );
        return () => {
            window.clearTimeout(showId);
            window.clearTimeout(hideId);
        };
    }, []);

    const showTokify = introTokify || hover || (open && openedAsTokify);
    const [exportOpen, setExportOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const runningStart = running ? new Date(running.start_time as any) : null;
    const runningMs = runningStart ? now - runningStart.getTime() : 0;
    const runningDuration = formatDuration(runningMs);
    const runningAccent = running?.project ? projectColor(running.project) : '#f5c451';
    const runningTitle = activityTitle(
        running?.description,
        running?.project,
    );
    const runningLabel = running ? runningShorthand || runningTitle : runningTitle;
    const logSelected = LOG_VIEWS.includes(view);
    const showLogIcons = logSelected || logHover;
    const activityLabelWidth = hasRunning
        ? labelWidth(
              runningLabel,
              RUNNING_ACTIVITY_LABEL_MAX_WIDTH,
              RUNNING_ACTIVITY_LABEL_MIN_WIDTH,
          )
        : IDLE_ACTIVITY_LABEL_WIDTH;
    const activityTabWidth = nowTabWidth(
        activityLabelWidth,
        hasRunning ? timerWidth(runningDuration) : 0,
    );
    const tabGroupWidth = activityTabWidth + HISTORY_TAB_WIDTH + TAB_GROUP_GAP + TAB_GROUP_PADDING_X;
    const tabGroupExpandedWidth = tabGroupWidth + (showLogIcons ? LOG_ICON_PANEL_WIDTH : 0);

    const tabStyle = (name: 'now' | 'history'): CSSProperties => {
        const active = name === 'history' ? logSelected : view === name;
        const runningInactive = name === 'now' && hasRunning && !active;
        if (runningInactive) {
            return {
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                border: 'none',
                background: 'var(--running-card)',
                color: 'var(--running-card-foreground)',
                fontWeight: 600,
                fontSize: 13.5,
                padding: '4px 10px 4px 12px',
                borderRadius: 8,
                cursor: 'pointer',
                boxShadow: 'var(--navigation-shadow)',
                overflow: 'hidden',
                width: activityTabWidth,
                transition: `${SIZE_TRANSITION}, background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease`,
            };
        }
        return {
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            border: 'none',
            background: active ? 'var(--navigation-active)' : 'transparent',
            color: active
                ? 'var(--navigation-active-foreground)'
                : 'var(--navigation-muted-foreground)',
            fontWeight: active ? 600 : 500,
            fontSize: 13.5,
            padding: '4px 10px 4px 12px',
            borderRadius: 8,
            cursor: 'pointer',
            boxShadow: active ? 'var(--navigation-shadow)' : 'none',
            overflow: 'hidden',
            width: name === 'now' ? activityTabWidth : HISTORY_TAB_WIDTH,
            transition: `${SIZE_TRANSITION}, background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease`,
        };
    };

    const handleOpenChange = (next: boolean) => {
        if (next) {
            const tokifyNow = introTokify || hover;
            setOpenedAsTokify(tokifyNow);
            if (tokifyNow) setNudgeKey((k) => k + 1);
        } else {
            setOpenedAsTokify(false);
        }
        setOpen(next);
    };

    // Radix dismisses the menu on a bubble-phase document listener, which a
    // child calling stopPropagation (e.g. a text input) can swallow — leaving
    // the menu open and the label stuck on "Tokify". A capture-phase listener
    // runs before any child handler, so an outside press always closes it.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (triggerRef.current?.contains(target)) return;
            if (contentRef.current?.contains(target)) return;
            handleOpenChange(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () =>
            document.removeEventListener('pointerdown', onPointerDown, true);
    }, [open]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
                return;
            }
            if (!(event.metaKey || event.ctrlKey)) return;
            if (event.key === '1') {
                event.preventDefault();
                onView('now');
            }
            if (event.key === '2') {
                event.preventDefault();
                onView('history');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onView]);

    useEffect(() => {
        let cancelled = false;
        setRunningShorthand(null);

        if (!hasRunning) return () => {
            cancelled = true;
        };

        buildActivityShorthandTitle(runningTitle)
            .then((label) => {
                if (!cancelled) setRunningShorthand(label);
            })
            .catch(() => {
                if (!cancelled) setRunningShorthand(null);
            });

        return () => {
            cancelled = true;
        };
    }, [hasRunning, runningTitle]);

    return (
        <>
        <header
            className="absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-background/75 pb-4 pl-28 pr-4 pt-3 backdrop-blur-md"
            style={dragStyle}
        >
            <div className="flex items-center gap-4" style={noDragStyle}>
                <div
                    className="inline-flex items-center gap-1 overflow-hidden rounded-[10px] bg-navigation p-[3px]"
                    style={{
                        width: tabGroupExpandedWidth,
                        transition: SIZE_TRANSITION,
                    }}
                >
                    <button
                        type="button"
                        className={cn(
                            'tt-tab-btn shrink-0 hover:text-navigation-active-foreground [&_svg]:size-[13px]',
                            running && view !== 'now' &&
                                'tt-tab-btn-running hover:bg-navigation hover:text-running-card-foreground',
                        )}
                        style={tabStyle('now')}
                        onClick={() => onView('now')}
                        aria-pressed={view === 'now'}
                    >
                        <span
                            className="inline-flex items-center gap-[7px] whitespace-nowrap"
                        >
                            <ActivityIcon />
                            <span
                                className="truncate"
                                style={{
                                    width: activityLabelWidth,
                                    transition: SIZE_TRANSITION,
                                }}
                                title={runningTitle}
                            >
                                {runningLabel}
                            </span>
                            {running && (
                                <span
                                    className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold tabular-nums"
                                    style={{ color: runningAccent, marginLeft: 2 }}
                                >
                                    <span className="size-[5px] shrink-0 rounded-full bg-current" />
                                    {runningDuration}
                                </span>
                            )}
                        </span>
                    </button>
                    <div
                        className="flex shrink-0 items-center"
                        onMouseEnter={() => setLogHover(true)}
                        onMouseLeave={() => setLogHover(false)}
                    >
                        <button
                            type="button"
                            className="tt-tab-btn shrink-0 hover:text-navigation-active-foreground [&_svg]:size-[13px]"
                            style={tabStyle('history')}
                            onClick={() => onView('history')}
                            aria-pressed={logSelected}
                        >
                            <span className="inline-flex items-center gap-[7px] whitespace-nowrap">
                                <List />
                                Log
                            </span>
                        </button>
                        <div
                            className={cn(
                                'ml-0 flex items-center gap-0 overflow-hidden pl-0 opacity-0 transition-[width,opacity,padding-left,margin-left] duration-200 ease-out',
                                showLogIcons &&
                                    'ml-0.5 gap-0.5 pl-1 opacity-100',
                            )}
                            style={{
                                width: showLogIcons ? LOG_ICON_PANEL_WIDTH - 8 : 0,
                            }}
                        >
                            <LogIconButton
                                icon={FileText}
                                label="Reports"
                                active={view === 'reports'}
                                visible={showLogIcons}
                                onClick={() => onView('reports')}
                            />
                            <LogIconButton
                                icon={BarChart3}
                                label="Charts"
                                active={view === 'charts'}
                                visible={showLogIcons}
                                onClick={() => onView('charts')}
                            />
                            <LogIconButton
                                icon={ActivityIcon}
                                label="Stats"
                                active={view === 'stats'}
                                visible={showLogIcons}
                                onClick={() => onView('stats')}
                            />
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2" style={noDragStyle}>
                <InviteBadge invites={invites} onOpen={() => onView('teams')} />
                <DropdownMenu open={open} onOpenChange={handleOpenChange}>
                    <DropdownMenuTrigger asChild>
                        {showAccount ? (
                        <button
                            ref={triggerRef}
                            type="button"
                            onMouseEnter={() => setHover(true)}
                            onMouseLeave={() => setHover(false)}
                            className="flex select-none items-center gap-2 rounded-[9px] border border-transparent py-1.5 pl-[7px] pr-3 outline-none transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-muted"
                        >
                            <span
                                aria-hidden
                                className="flex size-[21px] shrink-0 items-center justify-center rounded-[6px] bg-muted text-[10.5px] font-semibold leading-none text-foreground/70 [&_svg]:size-3"
                            >
                                {account?.signed_in ? (
                                    accountInitials(account.name, account.email)
                                ) : (
                                    <User />
                                )}
                            </span>
                            <span className="max-w-40 truncate text-sm text-foreground/90">
                                {account?.signed_in
                                    ? accountDisplayName(
                                          account.name,
                                          account.email,
                                      )
                                    : 'Account'}
                            </span>
                        </button>
                        ) : (
                        <button
                            ref={triggerRef}
                            type="button"
                            onMouseEnter={() => setHover(true)}
                            onMouseLeave={() => setHover(false)}
                            className="relative grid select-none overflow-hidden rounded-md px-2 py-1 outline-none transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-muted"
                        >
                            <span className="invisible col-start-1 row-start-1 px-1 text-xs font-medium uppercase tracking-[0.2em]">
                                Tokify
                            </span>
                            <span className="invisible col-start-1 row-start-1 px-1 text-xs tabular-nums">
                                {date}
                            </span>
                            <span
                                aria-hidden={!showTokify}
                                className={cn(
                                    'absolute inset-0 flex items-center justify-center pl-[0.2em] text-xs font-medium uppercase tracking-[0.2em] transition-[translate,opacity] duration-300 ease-out',
                                    showTokify
                                        ? 'translate-x-0 opacity-100'
                                        : '-translate-x-full opacity-0',
                                )}
                            >
                                <span
                                    key={nudgeKey}
                                    className={cn(
                                        'inline-block',
                                        nudgeKey > 0 &&
                                            'animate-[tokify-nudge_240ms_ease-out]',
                                    )}
                                >
                                    Tokify
                                </span>
                            </span>
                            <span
                                aria-hidden={showTokify}
                                className={cn(
                                    'absolute inset-0 flex items-center justify-center text-xs tabular-nums text-muted-foreground transition-[translate,opacity] duration-300 ease-out',
                                    showTokify
                                        ? 'translate-x-full opacity-0'
                                        : 'translate-x-0 opacity-100',
                                )}
                            >
                                {date}
                            </span>
                        </button>
                        )}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent ref={contentRef}>
                        {showAccount && (
                            <>
                                <div className="px-2 pb-1 pt-0.5 text-[12.5px] text-muted-foreground">
                                    {date}
                                </div>
                                <DropdownMenuSeparator />
                            </>
                        )}
                        <DropdownMenuItem onSelect={() => onView('settings')}>
                            <SettingsIcon className="size-4 opacity-70" />
                            Settings
                        </DropdownMenuItem>
                        {showAccount && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onSelect={() => onView('account')}
                                >
                                    <User className="size-4 opacity-70" />
                                    Account
                                </DropdownMenuItem>
                            </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onView('sharing')}>
                            <Share2 className="size-4 opacity-70" />
                            Sharing
                            <span className="ml-auto size-3 rounded-full bg-amber-200" />
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onView('teams')}>
                            <Users className="size-4 opacity-70" />
                            Teams
                            <span className="ml-auto flex items-center">
                                <span className="size-3 rounded-full border border-background bg-emerald-200" />
                                <span className="-ml-1 size-3 rounded-full border border-background bg-violet-200" />
                            </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setExportOpen(true)}>
                            <Download className="size-4 opacity-70" />
                            Export…
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>
        <ExportDialog
            open={exportOpen}
            onOpenChange={setExportOpen}
            projects={projects}
            hasShared={hasShared}
        />
        </>
    );
}

// An invitation waiting to be accepted: an incoming, gentle signal, so it wears
// the app's amber attention accent and reads as a plain fact ("Invitation")
// rather than a count until there's more than one. Clicking opens Teams, where
// the invite can be accepted or declined.
function InviteBadge({
    invites,
    onOpen,
}: {
    invites: main.TeamView[];
    onOpen: () => void;
}) {
    if (invites.length === 0) return null;
    const count = invites.length;
    const label = count === 1 ? 'Invitation' : `${count} invitations`;
    const inviter = invites[0].InvitedBy.trim() || 'Someone';
    const title =
        count === 1
            ? `${inviter} invited you to their team`
            : `You have ${count} team invitations`;
    return (
        <button
            type="button"
            onClick={onOpen}
            title={title}
            aria-label={title}
            className="flex select-none items-center gap-1.5 rounded-[9px] border border-amber-300/60 bg-amber-100/70 py-1.5 pl-2 pr-2.5 text-[13px] font-medium leading-none text-amber-900 outline-none transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-0 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/15 animate-in fade-in-0 slide-in-from-right-1 duration-300 [&_svg]:size-3.5"
        >
            <Mail />
            {label}
        </button>
    );
}

function nowTabWidth(label: number, timer: number) {
    return Math.ceil(
        TAB_PADDING_X +
            TAB_ICON_WIDTH +
            TAB_CONTENT_GAP +
            label +
            (timer > 0 ? TAB_CONTENT_GAP + timer : 0),
    );
}

function LogIconButton({
    icon: Icon,
    label,
    active = false,
    visible,
    onClick,
}: {
    icon: typeof List;
    label: string;
    active?: boolean;
    visible: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            tabIndex={visible ? 0 : -1}
            title={label}
            className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-md border bg-transparent leading-none transition-[background-color,border-color,color] duration-150 [&_svg]:size-[13px]',
                active
                    ? 'border-border/70 bg-background text-foreground hover:bg-background hover:text-foreground dark:bg-background/80 dark:hover:bg-background/80'
                    : 'border-transparent text-muted-foreground hover:bg-background/75 hover:text-foreground dark:hover:bg-background/45',
            )}
            onClick={onClick}
        >
            <Icon />
        </button>
    );
}

function labelWidth(label: string, max: number, min = IDLE_ACTIVITY_LABEL_WIDTH) {
    const wideChars = [...label].filter((char) => /[MW@#%&]/.test(char)).length;
    const width = Math.ceil(label.length * 7 + wideChars * 1.5 + 6);

    return Math.min(max, Math.max(min, width));
}

function timerWidth(duration: string) {
    return Math.ceil(5 + 4 + duration.length * 7.2 + 2);
}
