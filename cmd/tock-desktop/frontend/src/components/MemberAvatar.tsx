import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';

// MemberAvatar is the tinted initial disc from the Time-tracker nav design: a
// person's first initial on a deterministic per-identity color (same hashing as
// project tags, so someone keeps one color everywhere they appear). Used for
// team rosters and to tag shared activity rows by author.
export function MemberAvatar({
    seed,
    label,
    stacked,
    className,
}: {
    // seed drives the color — pass a stable identity (user id), not the display
    // label, so the color survives a rename.
    seed: string;
    label: string;
    stacked?: boolean;
    className?: string;
}) {
    const color = projectColor(seed);
    const initial = label.trim()[0]?.toUpperCase() || '?';
    return (
        <span
            title={label}
            className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold',
                stacked && '-ml-2',
                className,
            )}
            style={{
                backgroundColor: `color-mix(in oklab, ${color} 22%, transparent)`,
                color,
            }}
        >
            {initial}
        </span>
    );
}
