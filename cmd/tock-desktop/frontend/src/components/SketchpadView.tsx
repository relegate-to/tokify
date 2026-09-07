import { useEffect, useMemo, useState } from 'react';
import { PencilLine } from 'lucide-react';

const SKETCHPAD_KEY = 'tokify.sketchpad';

function readSketchpad() {
    try {
        return localStorage.getItem(SKETCHPAD_KEY) ?? '';
    } catch {
        return '';
    }
}

export function SketchpadView() {
    const [text, setText] = useState(readSketchpad);
    const wordCount = useMemo(() => {
        const trimmed = text.trim();
        return trimmed ? trimmed.split(/\s+/).length : 0;
    }, [text]);

    useEffect(() => {
        try {
            localStorage.setItem(SKETCHPAD_KEY, text);
        } catch {
            // The pad remains usable for this session if local storage is unavailable.
        }
    }, [text]);

    return (
        <section className="flex min-h-full flex-1 flex-col">
            <div className="mb-4 flex items-end justify-between gap-6">
                <div>
                    <div className="mb-1 flex items-center gap-2">
                        <PencilLine className="size-4 text-muted-foreground" />
                        <h2 className="text-[15px] font-semibold text-foreground">
                            Sketchpad
                        </h2>
                    </div>
                    <p className="text-[13px] text-muted-foreground">
                        A quiet place for the thought beside the task.
                    </p>
                </div>
                <span className="shrink-0 text-[11px] text-navigation-muted-foreground">
                    Private on this Mac
                </span>
            </div>

            <div className="tokify-sketchpad-paper relative flex min-h-[420px] flex-1 overflow-hidden rounded-2xl border border-subtle-surface-border bg-card shadow-sm">
                <div
                    aria-hidden
                    className="absolute inset-y-0 left-11 w-px bg-red-300/35 dark:bg-red-300/20"
                />
                <textarea
                    className="swiper-no-swiping relative z-10 min-h-full w-full resize-none bg-transparent px-16 pb-14 pt-[21px] text-[15px] leading-7 text-foreground outline-none placeholder:text-muted-foreground/55"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="Write anything…"
                    aria-label="Sketchpad"
                    spellCheck
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center justify-between border-t border-border/50 bg-card/90 px-4 py-2 text-[11px] text-navigation-muted-foreground backdrop-blur-sm">
                    <span>Saved automatically</span>
                    <span className="tabular-nums">
                        {wordCount} {wordCount === 1 ? 'word' : 'words'}
                    </span>
                </div>
            </div>
        </section>
    );
}
