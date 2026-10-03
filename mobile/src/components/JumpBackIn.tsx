import { Play } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { formatClock, parseSyncTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Entry } from '@/sync/entries';

// The desktop's Jump back in: the last few distinct activities as a ruled
// ledger, each one tap from running again.
export function JumpBackIn({ items, contextLabel, onResume }: { items: Entry[]; contextLabel: string; onResume: (e: Entry) => void }) {
    return (
        <View accessibilityLabel="Jump back in">
            <View className="mb-3 flex-row items-baseline justify-between px-1">
                <Text className="font-sans-semibold text-sm tracking-[-0.1px]">Jump back in</Text>
                {contextLabel ? (
                    <Text className="font-mono text-[11px] uppercase tracking-[1.3px] text-navigation-muted-foreground">{contextLabel}</Text>
                ) : null}
            </View>
            {items.map((e) => (
                <Pressable
                    key={e.id}
                    onPress={() => onResume(e)}
                    accessibilityRole="button"
                    accessibilityLabel={`Start ${e.description} again`}
                    className="flex-row items-center gap-2.5 border-t border-border px-1 py-3 active:bg-accent"
                >
                    <View className={cn('size-[7px] rounded-[2px]', projectColorClass(e.project))} />
                    <View className="flex-1">
                        <Text numberOfLines={1} className="font-sans-medium text-[15px]">
                            {e.description}
                        </Text>
                        <Text numberOfLines={1} className="text-[13px] text-ink-faint">
                            {[e.project, formatClock(parseSyncTime(e.start))].filter(Boolean).join('   ')}
                        </Text>
                    </View>
                    <View className="size-8 items-center justify-center rounded-lg bg-muted">
                        <Icon as={Play} className="size-3.5 text-foreground" />
                    </View>
                </Pressable>
            ))}
        </View>
    );
}
