import { Play } from 'lucide-react-native';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { EntryMenu, useEntryActions } from '@/components/EntryActions';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { formatClock, parseSyncTime } from '@/lib/time';
import { EASE_OUT, enter } from '@/lib/motion';
import { useTap } from '@/lib/use-tap';
import { cn } from '@/lib/utils';
import type { Entry } from '@/sync/entries';

// The desktop's Jump back in: the last few distinct activities as a ruled
// ledger, each one tap from running again (after a check when that would stop
// the running one), with the Log's edit and delete on a long press.
export function JumpBackIn({ items, contextLabel, onEdit }: { items: Entry[]; contextLabel: string; onEdit: (e: Entry) => void }) {
    return (
        <View accessibilityLabel="Jump back in">
            <View className="mb-3 flex-row items-baseline justify-between px-1">
                <Text className="font-sans-semibold text-base tracking-[-0.2px]">Jump back in</Text>
                {contextLabel ? (
                    <Text className="font-mono text-xs uppercase tracking-[1.4px] text-navigation-muted-foreground">{contextLabel}</Text>
                ) : null}
            </View>
            {items.map((e) => (
                <QuickStart key={e.id} entry={e} onEdit={onEdit} />
            ))}
        </View>
    );
}

function QuickStart({ entry: e, onEdit }: { entry: Entry; onEdit: (e: Entry) => void }) {
    const { resume } = useEntryActions();
    const tap = useTap(() => resume(e));
    return (
        <Animated.View entering={enter({ dy: -4, duration: 300, easing: EASE_OUT })}>
            <EntryMenu
                entry={e}
                onEdit={() => onEdit(e)}
                {...tap}
                accessibilityRole="button"
                accessibilityLabel={`Start ${e.description} again`}
                className="-mx-5 px-5 active:bg-accent"
            >
                <View className="flex-row items-center gap-3 border-t border-border px-1 py-3.5">
                    <View className={cn('size-2 rounded-[2px]', projectColorClass(e.project))} />
                    <View className="flex-1 gap-0.5">
                        <Text numberOfLines={1} className="font-sans-medium text-base">
                            {e.description}
                        </Text>
                        <Text numberOfLines={1} className="text-sm text-ink-faint">
                            {[e.project, formatClock(parseSyncTime(e.start))].filter(Boolean).join('   ')}
                        </Text>
                    </View>
                    <View className="size-10 items-center justify-center rounded-xl bg-muted">
                        <Icon as={Play} className="size-4 text-foreground" />
                    </View>
                </View>
            </EntryMenu>
        </Animated.View>
    );
}
