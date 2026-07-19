import * as React from 'react';

import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';

// MemberAvatar is the tinted initial disc from the Time-tracker nav design: a
// person's first initial on a deterministic per-identity color (same hashing as
// project tags, so someone keeps one color everywhere they appear). Used for
// team rosters and to tag shared activity rows by author.
//
// It forwards its ref and spreads extra props so it can be dropped straight into
// a Radix `asChild` trigger (e.g. a HoverCard). Pass `titled={false}` to drop the
// native tooltip when a richer hover surface supplies the details instead.
export const MemberAvatar = React.forwardRef<
    HTMLSpanElement,
    {
        // seed drives the color — pass a stable identity (user id), not the
        // display label, so the color survives a rename.
        seed: string;
        label: string;
        stacked?: boolean;
        titled?: boolean;
        className?: string;
    } & Omit<React.ComponentPropsWithoutRef<'span'>, 'title'>
>(function MemberAvatar(
    { seed, label, stacked, titled = true, className, ...props },
    ref,
) {
    const color = projectColor(seed);
    const initial = label.trim()[0]?.toUpperCase() || '?';
    return (
        <span
            ref={ref}
            title={titled ? label : undefined}
            className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold',
                stacked && '-ml-2',
                className,
            )}
            style={{
                backgroundColor: `color-mix(in oklab, ${color} 22%, transparent)`,
                color,
            }}
            {...props}
        >
            {initial}
        </span>
    );
});
