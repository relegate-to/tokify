import { useState, type CSSProperties } from "react";
import { Share2, Square } from "lucide-react";

import type { Activity } from "@/types";
import { cn } from "@/lib/utils";
import { projectColor } from "@/lib/colors";
import { EASE_OUT, EASE_THUNK } from "@/lib/motion";
import { formatClock, formatDuration } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { Button } from "@/components/ui/button";
import { ProjectTag } from "@/components/ProjectTag";

const STOP_ANIM_MS = 380;

export function NowRunning({
  activity,
  onStop,
  onShare,
}: {
  activity: Activity;
  onStop: () => void;
  onShare: () => void;
}) {
  const since = new Date(activity.start_time as any);
  const now = useNow();
  const ms = now - since.getTime();
  const seconds = Math.floor(ms / 1000) % 60;
  const minutePct = (seconds / 60) * 100;
  const [stopping, setStopping] = useState(false);
  const accent = activity.project ? projectColor(activity.project) : "#f5c451";
  const shareLabel = activity.project
    ? `Share ${activity.project} activities`
    : "Share activities";

  const handleStop = () => {
    if (stopping) return;
    setStopping(true);
    window.setTimeout(onStop, STOP_ANIM_MS);
  };

  return (
    <section
      aria-label="Currently running"
      className={cn(
        "relative flex min-h-[140px] flex-col justify-center overflow-hidden rounded-[16px] border border-running-card-border bg-running-card px-[26px] py-[26px] text-running-card-foreground shadow-[0_16px_32px_-16px_rgba(17,19,24,0.35)]",
        stopping
          ? "animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards"
          : "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-6",
      )}
      style={
        {
          "--activity-accent": accent,
          animationDuration: stopping ? `${STOP_ANIM_MS}ms` : "520ms",
          animationTimingFunction: stopping ? EASE_OUT : EASE_THUNK,
        } as CSSProperties
      }
    >
      <div className="relative flex min-w-0 items-center gap-6">
        <div
          className="shrink-0 font-mono text-[2.625rem] font-bold leading-none tabular-nums tracking-[-0.02em] text-[var(--activity-accent)]"
          aria-live="polite"
        >
          {formatDuration(ms)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-[19px] font-semibold leading-snug tracking-[-0.01em]">
            {activity.description || "No description"}
          </p>
          <div className="flex min-w-0 items-center gap-1.5 text-sm text-running-card-muted">
            {activity.project && (
              <>
                <ProjectTag
                  project={activity.project}
                  className="max-w-48 text-sm text-running-card-muted"
                />
                <span aria-hidden>·</span>
              </>
            )}
            <span className="shrink-0">since {formatClock(since)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*<Button
            type="button"
            onClick={onShare}
            variant="ghost"
            size="icon-sm"
            aria-label={shareLabel}
            title={shareLabel}
            className="text-[var(--activity-accent)] hover:bg-running-card-control-hover hover:text-[var(--activity-accent)]"
          >
            <Share2 />
          </Button>*/}
          <Button
            type="button"
            onClick={handleStop}
            variant="destructive"
            disabled={stopping}
            className="bg-running-stop px-3 text-running-stop-foreground shadow-[0_10px_24px_-14px_rgba(239,68,68,0.6)] transition-transform hover:bg-running-stop-hover active:scale-95 dark:bg-running-stop dark:hover:bg-running-stop-hover"
          >
            <Square
              data-icon="inline-start"
              fill="currentColor"
              className="p-0.5"
              strokeWidth={0}
            />
            Stop
          </Button>
        </div>
      </div>
      <div
        className="mt-[18px] h-[3px] overflow-hidden rounded-full bg-running-card-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={60}
        aria-valuenow={seconds}
        aria-label="Progress through current minute"
      >
        <div
          className={cn(
            "h-full rounded-full bg-[var(--activity-accent)] transition-[width] ease-linear",
            stopping ? "duration-300" : "duration-1000",
          )}
          style={{
            width: stopping ? "100%" : `${minutePct}%`,
            backgroundColor: accent,
          }}
        />
      </div>
    </section>
  );
}
