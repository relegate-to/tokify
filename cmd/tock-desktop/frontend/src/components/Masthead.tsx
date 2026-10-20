import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Activity as ActivityIcon,
  BarChart3,
  Download,
  FileText,
  FolderKanban,
  List,
  Mail,
  Power,
  Settings as SettingsIcon,
  Share2,
  Redo2,
  Undo2,
  User,
  Users,
} from "lucide-react";

import type { Activity, UndoState, View } from "@/types";
import type { main, neonauth } from "../../wailsjs/go/models";
import { cn } from "@/lib/utils";
import { accountDisplayName, accountInitials } from "@/lib/account";
import { formatTotal } from "@/lib/time";
import { projectColor } from "@/lib/colors";
import { useNow } from "@/lib/use-now";
import {
  activityTitle,
  buildActivityShorthandTitle,
} from "@/lib/activity-label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExportDialog } from "@/components/ExportDialog";
import { Quit } from "../../wailsjs/runtime/runtime";

const dragStyle = {
  // Wails draggable hint and webkit equivalent
  ["--wails-draggable" as any]: "drag",
  WebkitAppRegion: "drag",
} as React.CSSProperties;

const noDragStyle = {
  ["--wails-draggable" as any]: "no-drag",
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

const SIZE_TRANSITION = "width 0.3s cubic-bezier(0.16, 1, 0.3, 1)";
const TAB_GROUP_PADDING_X = 6;
const TAB_GROUP_GAP = 4;
const TAB_PADDING = 12;
const TAB_ICON_WIDTH = 13;
const TAB_CONTENT_GAP = 7;
// A touch more air before the timer than between the icon and the label, so the
// readout reads as its own thing.
const TIMER_MARGIN = 2;
const RUNNING_ACTIVITY_LABEL_MIN_WIDTH = 28;
// Kept clear between the tabs and the controls on the right.
const HEADER_BREATHING_ROOM = 24;
const HISTORY_TAB_WIDTH = 68;
const LOG_ICON_PANEL_WIDTH = 88;
const LOG_VIEWS: View[] = ["history", "reports", "charts", "stats"];

export function Masthead({
  view,
  onView,
  running,
  showAccount,
  account,
  projects,
  invites,
  hasShared,
  undoState,
  onUndo,
  onRedo,
  menuBar,
}: {
  view: View;
  onView: (v: View) => void;
  running: Activity | null;
  showAccount: boolean;
  account: neonauth.Status | null;
  projects: string[];
  invites: main.TeamView[];
  hasShared: boolean;
  undoState: UndoState;
  onUndo: () => void;
  onRedo: () => void;
  menuBar: boolean;
}) {
  const date = new Date()
    .toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
    })
    .toLowerCase();
  const [open, setOpen] = useState(false);
  const [runningShorthand, setRunningShorthand] = useState<string | null>(null);
  const [logHover, setLogHover] = useState(false);
  const hasRunning = !!running;
  const runningStart = running ? new Date(running.start_time as any).getTime() : 0;
  // The tab reads whole minutes ("0m", "1h 5m"), so it only needs to hear
  // about them.
  const now = useNow(hasRunning, 60_000, runningStart);

  const [exportOpen, setExportOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const runningMs = running ? now - runningStart : 0;
  const runningDuration = formatTotal(runningMs);
  const runningAccent = running?.project
    ? projectColor(running.project)
    : "#f5c451";
  const runningTitle = activityTitle(running?.description, running?.project);
  const logSelected = LOG_VIEWS.includes(view);
  const nowSelected = view === "now" || view === "sketchpad";
  const chipInk = nowSelected
    ? "var(--navigation-active-foreground)"
    : "var(--running-card-foreground)";
  const showLogIcons = logSelected || logHover;

  // The tab's width animates, so it has to be explicit — measured from the
  // rendered text rather than guessed from a character count, which left a gap
  // after short labels and squeezed the timer against the edge on long ones.
  // Hidden copies of the title and its shorthand inherit the tab's current
  // weight. The label may grow into whatever the header has free, so the full
  // title shows whenever it fits and the shorthand only when it doesn't.
  const headerRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const titleGhostRef = useRef<HTMLSpanElement>(null);
  const shortGhostRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState({
    title: 0,
    short: 0,
    timer: 0,
    room: Infinity,
  });
  const measure = () => {
    // Rounded up from the exact width: offsetWidth rounds to the nearest pixel,
    // and half a pixel short is enough to truncate the label to an ellipsis.
    const width = (el: Element | null) =>
      el ? Math.ceil(el.getBoundingClientRect().width) : 0;
    const timer = width(timerRef.current);
    let room = Infinity;
    const header = headerRef.current;
    if (header && controlsRef.current) {
      const style = getComputedStyle(header);
      room = Math.floor(
        header.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          width(controlsRef.current) -
          HEADER_BREATHING_ROOM -
          TAB_GROUP_PADDING_X -
          TAB_GROUP_GAP -
          HISTORY_TAB_WIDTH -
          // Held back even while the log icons are tucked away, so hovering
          // Log doesn't squeeze the label.
          LOG_ICON_PANEL_WIDTH -
          nowTabWidth(0, timer),
      );
    }
    const next = {
      title: width(titleGhostRef.current),
      short: width(shortGhostRef.current),
      timer,
      room,
    };
    setMeasured((cur) =>
      cur.title === next.title &&
      cur.short === next.short &&
      cur.timer === next.timer &&
      cur.room === next.room
        ? cur
        : next,
    );
  };
  useLayoutEffect(measure);
  // Web fonts landing late change the text's width, and resizing the window or
  // an invitation badge appearing changes the room.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const el of [
      headerRef.current,
      controlsRef.current,
      titleGhostRef.current,
    ]) {
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, []);
  // Size changes animate only after the first paint, so the tab doesn't slide
  // open at launch.
  const [sized, setSized] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSized(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const sizeTransition = sized ? SIZE_TRANSITION : "none";

  const labelRoom = Math.max(RUNNING_ACTIVITY_LABEL_MIN_WIDTH, measured.room);
  const showShorthand =
    hasRunning && !!runningShorthand && measured.title > labelRoom;
  const runningLabel = showShorthand ? runningShorthand : runningTitle;
  const activityLabelWidth = hasRunning
    ? Math.min(
        labelRoom,
        Math.max(
          RUNNING_ACTIVITY_LABEL_MIN_WIDTH,
          showShorthand ? measured.short : measured.title,
        ),
      )
    : measured.title;
  const activityTabWidth = nowTabWidth(
    activityLabelWidth,
    hasRunning ? measured.timer : 0,
  );
  const tabGroupWidth =
    activityTabWidth + HISTORY_TAB_WIDTH + TAB_GROUP_GAP + TAB_GROUP_PADDING_X;
  const tabGroupExpandedWidth =
    tabGroupWidth + (showLogIcons ? LOG_ICON_PANEL_WIDTH : 0);

  const tabStyle = (name: "now" | "history"): CSSProperties => {
    const active = name === "history" ? logSelected : nowSelected;
    const runningInactive = name === "now" && hasRunning && !active;
    if (runningInactive) {
      return {
        display: "flex",
        alignItems: "center",
        gap: 7,
        border: "none",
        background: "var(--running-card)",
        color: "var(--running-card-foreground)",
        fontWeight: 600,
        fontSize: 13.5,
        padding: `4px ${TAB_PADDING}px`,
        borderRadius: 8,
        cursor: "pointer",
        boxShadow: "var(--navigation-shadow)",
        overflow: "hidden",
        width: activityTabWidth,
        transition: `${sizeTransition}, background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease`,
      };
    }
    return {
      display: "flex",
      alignItems: "center",
      gap: 7,
      border: "none",
      background: active ? "var(--navigation-active)" : "transparent",
      color: active
        ? "var(--navigation-active-foreground)"
        : "var(--navigation-muted-foreground)",
      fontWeight: active ? 600 : 500,
      fontSize: 13.5,
      padding: `4px ${TAB_PADDING}px`,
      borderRadius: 8,
      cursor: "pointer",
      boxShadow: active ? "var(--navigation-shadow)" : "none",
      overflow: "hidden",
      width: name === "now" ? activityTabWidth : HISTORY_TAB_WIDTH,
      transition: `${sizeTransition}, background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease`,
    };
  };

  const handleOpenChange = (next: boolean) => setOpen(next);

  // Radix dismisses the menu on a bubble-phase document listener, which a
  // child calling stopPropagation (e.g. a text input) can swallow — leaving
  // the menu open. A capture-phase listener runs before any child handler, so
  // an outside press always closes it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      // The menu renders in a portal, and the shadcn content component can't
      // take a ref under React 18, so find it by its slot instead. Treating a
      // press on an item as outside closed the menu before the item's click.
      if (
        target instanceof Element &&
        target.closest('[data-slot="dropdown-menu-content"]')
      ) {
        return;
      }
      handleOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    setRunningShorthand(null);

    if (!hasRunning)
      return () => {
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
        ref={headerRef}
        className={cn(
          "absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-background/75 pb-4 pr-4 pt-3 backdrop-blur-md",
          menuBar ? "pl-4" : "pl-28",
        )}
        style={menuBar ? noDragStyle : dragStyle}
      >
        <div className="flex items-center gap-4" style={noDragStyle}>
          <div
            className="inline-flex items-center gap-1 overflow-hidden rounded-[10px] bg-navigation p-[3px]"
            style={{
              width: tabGroupExpandedWidth,
              transition: sizeTransition,
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              className={cn(
                "tt-tab-btn shrink-0 hover:text-navigation-active-foreground [&_svg]:size-[13px]",
                running &&
                  !nowSelected &&
                  "tt-tab-btn-running hover:bg-navigation hover:text-running-card-foreground",
              )}
              style={tabStyle("now")}
              onClick={() => onView("now")}
              aria-pressed={nowSelected}
            >
              <span
                ref={titleGhostRef}
                aria-hidden
                className="pointer-events-none invisible absolute whitespace-nowrap"
              >
                {runningTitle}
              </span>
              {hasRunning && runningShorthand && (
                <span
                  ref={shortGhostRef}
                  aria-hidden
                  className="pointer-events-none invisible absolute whitespace-nowrap"
                >
                  {runningShorthand}
                </span>
              )}
              <span className="inline-flex items-center gap-[7px] whitespace-nowrap">
                <ActivityIcon />
                <span
                  className="truncate"
                  style={{
                    width: activityLabelWidth,
                    transition: sizeTransition,
                  }}
                  title={runningTitle}
                >
                  {runningLabel}
                </span>
                {running && (
                  <span
                    ref={timerRef}
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-[11.5px] font-semibold tabular-nums"
                    style={{
                      marginLeft: TIMER_MARGIN,
                      // A project color alone can vanish against the tab, so it
                      // is pulled toward the tab's own text color: darker on a
                      // light tab, lighter on a dark one.
                      color: `color-mix(in oklab, ${runningAccent} 60%, ${chipInk})`,
                    }}
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
                tabIndex={-1}
                className="tt-tab-btn shrink-0 hover:text-navigation-active-foreground [&_svg]:size-[13px]"
                style={tabStyle("history")}
                onClick={() => onView("history")}
                aria-pressed={logSelected}
              >
                <span className="inline-flex items-center gap-[7px] whitespace-nowrap">
                  <List />
                  Log
                </span>
              </button>
              <div
                className={cn(
                  "ml-0 flex items-center gap-0 overflow-hidden pl-0 opacity-0 transition-[width,opacity,padding-left,margin-left] duration-200 ease-out",
                  showLogIcons && "ml-0.5 gap-0.5 pl-1 opacity-100",
                )}
                style={{
                  width: showLogIcons ? LOG_ICON_PANEL_WIDTH - 8 : 0,
                }}
              >
                <LogIconButton
                  icon={FileText}
                  label="Reports"
                  active={view === "reports"}
                  onClick={() => onView("reports")}
                />
                <LogIconButton
                  icon={BarChart3}
                  label="Charts"
                  active={view === "charts"}
                  onClick={() => onView("charts")}
                />
                <LogIconButton
                  icon={ActivityIcon}
                  label="Stats"
                  active={view === "stats"}
                  onClick={() => onView("stats")}
                />
              </div>
            </div>
          </div>
        </div>
        <div
          ref={controlsRef}
          className="flex items-center gap-2"
          style={noDragStyle}
        >
          <InviteBadge invites={invites} onOpen={() => onView("teams")} />
          <DropdownMenu open={open} onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>
              {showAccount ? (
                <button
                  ref={triggerRef}
                  type="button"
                  className="flex select-none items-center gap-2 rounded-[9px] border border-transparent py-1.5 pl-[7px] pr-3 outline-none compact:pr-[7px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-muted"
                >
                  <span
                    aria-hidden
                    className="relative flex size-[21px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-muted text-[10.5px] font-semibold leading-none text-foreground/70 [&_svg]:size-3"
                  >
                    {account?.signed_in ? (
                      accountInitials(account.name, account.email)
                    ) : (
                      <User />
                    )}
                    {/* Layered over the initials rather than replacing them, so a
                        broken or still-decoding picture leaves the pill intact.
                        The square keeps this marker reading as "you" — the tinted
                        circles elsewhere are other people. */}
                    {account?.signed_in && account.image && (
                      <img
                        src={account.image}
                        alt=""
                        draggable={false}
                        className="absolute inset-0 size-full object-cover"
                      />
                    )}
                  </span>
                  <span className="max-w-40 truncate text-sm text-foreground/90 compact:hidden">
                    {account?.signed_in
                      ? accountDisplayName(account.name, account.email)
                      : "Account"}
                  </span>
                </button>
              ) : (
                <button
                  ref={triggerRef}
                  type="button"
                  className="select-none rounded-md px-2 py-1 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-muted"
                >
                  {date}
                </button>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {showAccount && (
                <>
                  <div className="px-2 pb-1 pt-0.5 text-[12.5px] text-muted-foreground">
                    {date}
                  </div>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                disabled={!undoState.can_undo}
                onSelect={onUndo}
                title={undoState.undo_label}
              >
                <Undo2 className="size-4 opacity-70" />
                {undoState.undo_label ? `Undo ${undoState.undo_label}` : "Undo"}
                <span className="ml-auto pl-6 font-mono text-[11px] text-muted-foreground">⌘Z</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!undoState.can_redo}
                onSelect={onRedo}
                title={undoState.redo_label}
              >
                <Redo2 className="size-4 opacity-70" />
                {undoState.redo_label ? `Redo ${undoState.redo_label}` : "Redo"}
                <span className="ml-auto pl-6 font-mono text-[11px] text-muted-foreground">⇧⌘Z</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onView("projects")}>
                <FolderKanban className="size-4 opacity-70" />
                Projects
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onView("settings")}>
                <SettingsIcon className="size-4 opacity-70" />
                Settings
              </DropdownMenuItem>
              {showAccount && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onView("account")}>
                    <User className="size-4 opacity-70" />
                    Account
                  </DropdownMenuItem>
                </>
              )}
              {showAccount && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onView("teams")}>
                    <Users className="size-4 opacity-70" />
                    Teams
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setExportOpen(true)}>
                    <Download className="size-4 opacity-70" />
                    Export…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onView("sharing")}>
                    <Share2 className="size-4 opacity-70" />
                    Share link…
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => Quit()}
                className="text-destructive data-[highlighted]:text-destructive"
              >
                <Power className="size-4 text-destructive opacity-70" />
                Quit Tokify
                <span className="ml-auto pl-6 font-mono text-[11px] text-destructive/60">⌘Q</span>
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
  const label = count === 1 ? "Invitation" : `${count} invitations`;
  const inviter = invites[0].InvitedBy.trim() || "Someone";
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
    TAB_PADDING * 2 +
      TAB_ICON_WIDTH +
      TAB_CONTENT_GAP +
      label +
      (timer > 0 ? TAB_CONTENT_GAP + TIMER_MARGIN + timer : 0),
  );
}

function LogIconButton({
  icon: Icon,
  label,
  active = false,
  onClick,
}: {
  icon: typeof List;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      tabIndex={-1}
      title={label}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md border bg-transparent leading-none transition-[background-color,border-color,color] duration-150 [&_svg]:size-[13px]",
        active
          ? "border-border/70 bg-background text-foreground hover:bg-background hover:text-foreground dark:bg-background/80 dark:hover:bg-background/80"
          : "border-transparent text-muted-foreground hover:bg-background/75 hover:text-foreground dark:hover:bg-background/45",
      )}
      onClick={onClick}
    >
      <Icon />
    </button>
  );
}
