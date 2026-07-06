import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';

export function ProjectTag({
    project,
    className,
}: {
    project: string;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground',
                className,
            )}
        >
            <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: projectColor(project) }}
            />
            <span className="truncate">{project}</span>
        </span>
    );
}
