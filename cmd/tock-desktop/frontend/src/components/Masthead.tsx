import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import {
    Activity as ActivityIcon,
    Download,
    List,
    Settings as SettingsIcon,
    Share2,
    User,
    Users,
} from 'lucide-react';

import type { Activity, View } from '@/types';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/time';
import { projectColor } from '@/lib/colors';
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
const HISTORY_TAB_WIDTH = 66;

export function Masthead({
    view,
    onView,
    running,
    showAccount,
    projects,
}: {
    view: View;
    onView: (v: View) => void;
    running: Activity | null;
    showAccount: boolean;
    projects: string[];
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
    const hasRunning = !!running;
    const runningStart = running ? new Date(running.start_time as any) : null;
    const runningMs = runningStart ? Date.now() - runningStart.getTime() : 0;
    const runningDuration = formatDuration(runningMs);
    const runningAccent = running?.project ? projectColor(running.project) : '#f5c451';
    const runningTitle = activityTitle(
        running?.description,
        running?.project,
    );
    const runningLabel = running ? runningShorthand || runningTitle : runningTitle;
    const activityLabelWidth = hasRunning
        ? labelWidth(runningLabel, 220)
        : IDLE_ACTIVITY_LABEL_WIDTH;
    const activityTabWidth = nowTabWidth(
        activityLabelWidth,
        hasRunning ? timerWidth(runningDuration) : 0,
    );
    const tabGroupWidth = activityTabWidth + HISTORY_TAB_WIDTH + TAB_GROUP_GAP + TAB_GROUP_PADDING_X;

    const tabStyle = (name: 'now' | 'history'): CSSProperties => {
        const active = view === name;
        const runningInactive = name === 'now' && hasRunning && !active;
        if (runningInactive) {
            return {
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                border: 'none',
                background: '#1a1a1a',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: 13.5,
                padding: '4px 10px 4px 12px',
                borderRadius: 8,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(20,20,25,0.12)',
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
            background: active ? '#ffffff' : 'transparent',
            color: active ? '#1a1a1a' : '#9a9a9f',
            fontWeight: active ? 600 : 500,
            fontSize: 13.5,
            padding: '4px 10px 4px 12px',
            borderRadius: 8,
            cursor: 'pointer',
            boxShadow: active ? '0 1px 3px rgba(20,20,25,0.12)' : 'none',
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
            className="flex shrink-0 items-center justify-between border-b bg-background/80 pb-2 pl-28 pr-4 pt-3 backdrop-blur"
            style={dragStyle}
        >
            <div className="flex items-center gap-4" style={noDragStyle}>
                <div
                    className="inline-flex items-center gap-1 overflow-hidden rounded-[10px] bg-[#f2f2f3] p-[3px] dark:bg-muted"
                    style={{
                        width: tabGroupWidth,
                        transition: SIZE_TRANSITION,
                    }}
                >
                    <button
                        type="button"
                        className={cn(
                            'tt-tab-btn shrink-0 hover:text-[#1a1a1a] [&_svg]:size-[13px]',
                            running && view !== 'now' &&
                                'tt-tab-btn-running hover:bg-[#2a2a2a] hover:text-white',
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
                    <button
                        type="button"
                        className="tt-tab-btn shrink-0 hover:text-[#1a1a1a] [&_svg]:size-[13px]"
                        style={tabStyle('history')}
                        onClick={() => onView('history')}
                        aria-pressed={view === 'history'}
                    >
                        <span className="inline-flex items-center gap-[7px] whitespace-nowrap">
                            <List />
                            Log
                        </span>
                    </button>
                </div>
            </div>
            <div style={noDragStyle}>
                <DropdownMenu open={open} onOpenChange={handleOpenChange}>
                    <DropdownMenuTrigger asChild>
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
                    </DropdownMenuTrigger>
                    <DropdownMenuContent ref={contentRef}>
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
                        <DropdownMenuItem disabled>
                            <Users className="size-4 opacity-70" />
                            Teams
                            {projects.length > 0 && (
                                <span className="ml-auto flex items-center">
                                    <span className="size-3 rounded-full border border-background bg-emerald-200" />
                                    <span className="-ml-1 size-3 rounded-full border border-background bg-violet-200" />
                                </span>
                            )}
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
        />
        </>
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

function labelWidth(label: string, max: number) {
    const wideChars = [...label].filter((char) => /[MW@#%&]/.test(char)).length;
    const width = Math.ceil(label.length * 7 + wideChars * 1.5 + 6);

    return Math.min(max, Math.max(IDLE_ACTIVITY_LABEL_WIDTH, width));
}

function timerWidth(duration: string) {
    return Math.ceil(5 + 4 + duration.length * 7.2 + 2);
}
