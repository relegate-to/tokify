import * as React from 'react';

import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';

// MemberAvatar is the identity disc from the Time-tracker nav design: a person's
// published picture when they have one, and otherwise their first initial on a
// deterministic per-identity color (same hashing as project tags, so someone
// keeps one color everywhere they appear). Used for team rosters and to tag
// shared activity rows by author.
//
// The initial is always rendered as the ground and the picture layered over it,
// so a slow or broken image degrades to the tinted disc with no layout shift and
// no empty frame in between. That ground is also why the picture needs no
// fade-in: there is never an empty frame to hide, and a data: URI decodes before
// a load handler could run anyway.
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
        // image is the person's published avatar (a data: URI or an https URL).
        // Empty or absent falls back to the initial.
        image?: string;
        stacked?: boolean;
        titled?: boolean;
        className?: string;
    } & Omit<React.ComponentPropsWithoutRef<'span'>, 'title'>
>(function MemberAvatar(
    { seed, label, image, stacked, titled = true, className, ...props },
    ref,
) {
    const color = projectColor(seed);
    const initial = label.trim()[0]?.toUpperCase() || '?';

    // Remember which src failed rather than a bare "broken" flag: a new picture
    // then gets a fresh attempt with no effect to reset the flag, and no render
    // where a stale failure suppresses a good image.
    const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
    const wanted = (image ?? '').trim();
    const src = wanted && wanted !== failedSrc ? wanted : '';

    return (
        <span
            ref={ref}
            title={titled ? label : undefined}
            className={cn(
                'relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-card text-[10px] font-semibold',
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
            {src && (
                <img
                    src={src}
                    alt=""
                    draggable={false}
                    onError={() => setFailedSrc(wanted)}
                    className="absolute inset-0 size-full object-cover"
                />
            )}
        </span>
    );
});
