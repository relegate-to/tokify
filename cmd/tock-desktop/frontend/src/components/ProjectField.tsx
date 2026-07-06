import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { projectColor } from '@/lib/colors';
import { Input } from '@/components/ui/input';

export function ProjectField({
    value,
    onChange,
    suggestions,
    onSubmit,
    placeholder = 'project (optional)',
    size = 'sm',
}: {
    value: string;
    onChange: (v: string) => void;
    suggestions: string[];
    onSubmit?: () => void;
    placeholder?: string;
    size?: 'sm' | 'xs';
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && onSubmit) {
                        e.preventDefault();
                        onSubmit();
                    }
                }}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                className={cn(size === 'xs' ? 'h-7' : 'h-8')}
            />
            {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {suggestions.map((p) => {
                        const active = value === p;
                        return (
                            <button
                                key={p}
                                type="button"
                                onClick={() => onChange(active ? '' : p)}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors',
                                    active
                                        ? 'border-foreground bg-foreground text-background'
                                        : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                                )}
                            >
                                {active ? (
                                    <Check className="size-3" />
                                ) : (
                                    <span
                                        aria-hidden
                                        className="size-1.5 rounded-full"
                                        style={{
                                            backgroundColor: projectColor(p),
                                        }}
                                    />
                                )}
                                {p}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
