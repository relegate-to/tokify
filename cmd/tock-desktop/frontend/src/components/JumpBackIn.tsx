import type { Activity } from '@/types';
import { ActivityRow } from '@/components/ActivityRow';

// The recents ledger is ActivityRow in its ledger variant: the design's dense
// hairline-ruled row, with the Log page's hover actions, context menu, and edit
// dialog behind it.
export function JumpBackIn({
    items,
    contextLabel,
    projects,
    removingKeys,
    onResume,
    onUpdate,
    onRemove,
}: {
    items: Activity[];
    contextLabel: string;
    projects: string[];
    removingKeys: Set<string>;
    onResume: (orig: Activity) => void;
    onUpdate: (
        orig: Activity,
        description: string,
        project: string,
        startISO: string,
        endISO: string,
    ) => void;
    onRemove: (orig: Activity) => void;
}) {
    return (
        <section aria-label="Jump back in">
            <div className="mb-3.5 flex items-baseline justify-between gap-4 px-1">
                <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                    Jump back in
                </h3>
                {contextLabel && (
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-navigation-muted-foreground">
                        {contextLabel}
                    </span>
                )}
            </div>
            <ul className="flex flex-col">
                {items.map((a) => (
                    <ActivityRow
                        key={String(a.start_time)}
                        activity={a}
                        projects={projects}
                        isRemoving={removingKeys.has(String(a.start_time))}
                        variant="ledger"
                        onUpdate={onUpdate}
                        onRemove={onRemove}
                        onResume={onResume}
                    />
                ))}
            </ul>
        </section>
    );
}
