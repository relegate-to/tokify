import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

export function FinishTodoDialog({
    description,
    onAnswer,
}: {
    description: string | null;
    onAnswer: (done: boolean, always: boolean) => void;
}) {
    const [always, setAlways] = useState(false);

    useEffect(() => {
        if (description !== null) setAlways(false);
    }, [description]);

    return (
        <Dialog open={description !== null} onOpenChange={(open) => !open && onAnswer(false, false)}>
            <DialogContent showCloseButton={false}>
                <DialogHeader>
                    <DialogTitle>Is this to-do done?</DialogTitle>
                    <DialogDescription className="break-words">
                        You stopped “{description}”. Tick it off in your notes?
                    </DialogDescription>
                </DialogHeader>
                <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted-foreground select-none">
                    <input
                        type="checkbox"
                        checked={always}
                        onChange={(e) => setAlways(e.target.checked)}
                        className="size-3.5 cursor-pointer accent-foreground"
                    />
                    Always tick off to-dos when I stop them
                </label>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onAnswer(false, false)}>
                        Not yet
                    </Button>
                    <Button autoFocus onClick={() => onAnswer(true, always)}>
                        Mark done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
