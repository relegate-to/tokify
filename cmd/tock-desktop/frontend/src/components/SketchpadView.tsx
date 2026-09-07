import { useEffect, useState } from 'react';

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

    useEffect(() => {
        try {
            localStorage.setItem(SKETCHPAD_KEY, text);
        } catch {
            // The pad remains usable for this session if local storage is unavailable.
        }
    }, [text]);

    return (
        <section className="flex min-h-full flex-1 flex-col">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-1 flex-col">
                <header className="mb-7 flex items-center gap-4">
                    <h2 className="text-[11px] font-medium uppercase tracking-[0.2em] text-navigation-muted-foreground">
                        Notes
                    </h2>
                    <span aria-hidden className="h-px flex-1 bg-border/70" />
                </header>
                <textarea
                    className="swiper-no-swiping min-h-[420px] w-full flex-1 resize-none bg-transparent pb-16 text-[18px] leading-8 tracking-[-0.01em] text-foreground outline-none placeholder:text-muted-foreground/35"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="Write…"
                    aria-label="Sketchpad"
                    spellCheck
                />
            </div>
        </section>
    );
}
