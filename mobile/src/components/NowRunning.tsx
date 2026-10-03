import { Pencil } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { EditActivityDialog } from '@/components/EditActivityDialog';
import { Icon } from '@/components/ui/icon';

import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { formatClock, formatStopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

// The desktop's running card (NowRunning.tsx) in its compact, stacked form:
// inverted against the page so the one thing that is live reads first.
export function NowRunning({
    description,
    project,
    start,
    projects,
    onStop,
    onEdit,
}: {
    description: string;
    project: string;
    start: Date;
    projects: string[];
    onStop: () => void;
    onEdit: (description: string, project: string) => Promise<void> | void;
}) {
    const now = useNow();
    const [editing, setEditing] = useState(false);
    return (
        <View accessibilityLabel="Currently running" className="gap-4 rounded-2xl bg-running-card px-5 py-5">
            <View className="gap-2">
                <View className="flex-row items-center gap-2">
                    <View className="size-1.5 rounded-full bg-live-dot-hero" />
                    <Text className="font-mono text-[11px] uppercase tracking-[1.5px] text-running-card-faint">
                        Running since {formatClock(start)}
                    </Text>
                </View>
                <Text numberOfLines={2} className="font-sans-semibold text-[26px] leading-[31px] tracking-[-0.5px] text-running-card-foreground">
                    {description || 'No description'}
                </Text>
                <View className="flex-row items-center gap-2">
                    <View className={cn('size-[7px] rounded-[2px]', projectColorClass(project))} />
                    <Text numberOfLines={1} className="font-sans-medium text-sm text-running-card-muted">
                        {project || 'No project'}
                    </Text>
                </View>
            </View>
            <View className="flex-row items-center border-t border-running-card-faint/20 pt-4">
                <Text
                    accessibilityLiveRegion="polite"
                    className="mr-auto font-mono-medium text-[30px] tracking-[-0.5px] text-running-card-foreground"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {formatStopwatch(now - start.getTime())}
                </Text>
                <Pressable
                    onPress={() => setEditing(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Edit running activity"
                    className="mr-1.5 size-10 items-center justify-center rounded-[10px] active:bg-running-card-foreground/10"
                >
                    <Icon as={Pencil} className="size-4 text-running-card-muted" />
                </Pressable>
                <Pressable
                    onPress={onStop}
                    accessibilityRole="button"
                    className="flex-row items-center gap-2.5 rounded-[10px] bg-running-stop px-5 py-3 active:scale-95"
                >
                    <View className="size-[9px] rounded-[2px] bg-running-stop-glyph" />
                    <Text className="font-sans-semibold text-sm text-running-stop-foreground">Stop</Text>
                </Pressable>
            </View>
            <EditActivityDialog
                open={editing}
                onOpenChange={setEditing}
                subtitle={`Started ${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} — still running.`}
                initial={{ description, project }}
                projects={projects}
                onSave={(e) => onEdit(e.description, e.project)}
            />
        </View>
    );
}
