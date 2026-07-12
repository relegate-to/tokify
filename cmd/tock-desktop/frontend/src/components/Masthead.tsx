import { useEffect, useRef, useState } from 'react';
import { Download, Settings as SettingsIcon, User } from 'lucide-react';

import type { View } from '@/types';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

export function Masthead({
    view,
    onView,
    showAccount,
    projects,
}: {
    view: View;
    onView: (v: View) => void;
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
    const tabsValue = view === 'now' || view === 'history' ? view : '';
    const [introTokify, setIntroTokify] = useState(false);
    const [hover, setHover] = useState(false);
    const [open, setOpen] = useState(false);
    const [openedAsTokify, setOpenedAsTokify] = useState(false);
    const [nudgeKey, setNudgeKey] = useState(0);

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

    return (
        <>
        <header
            className="flex shrink-0 items-center justify-between border-b bg-background/80 pb-2 pl-28 pr-4 pt-3 backdrop-blur"
            style={dragStyle}
        >
            <div className="flex items-center gap-4" style={noDragStyle}>
                <Tabs value={tabsValue} onValueChange={(v) => onView(v as View)}>
                    <TabsList>
                        <TabsTrigger value="now">Now</TabsTrigger>
                        <TabsTrigger value="history">History</TabsTrigger>
                    </TabsList>
                </Tabs>
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
