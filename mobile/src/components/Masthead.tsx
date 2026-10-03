import { Activity as ActivityIcon, List, LogOut } from 'lucide-react-native';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Animated, { interpolate, LinearTransition, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { accountInitials } from '@/lib/account';
import { projectColorClass } from '@/lib/colors';
import { EASE_SIZE } from '@/lib/motion';
import { useRunningTimer } from '@/lib/running-timer';
import { useSession } from '@/lib/session';
import { formatDuration, parseInstant } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { isRunning } from '@/sync/timer';

export type Page = 'now' | 'log';

// The desktop's SIZE_TRANSITION, for the Activity tab growing into the
// running pill.
const resize = LinearTransition.duration(300).easing(EASE_SIZE);

// The desktop masthead (Masthead.tsx) at phone width: the Activity / Log
// segmented control on the left, the account square on the right. The active
// highlight rides the pager's scroll position, so it follows a swipe
// continuously. Off the Activity page a running timer turns its tab into the
// running pill.
export function Masthead({ page, progress, onPage }: { page: Page; progress: SharedValue<number>; onPage: (page: Page) => void }) {
    const onLog = page === 'log';
    const { account, signOut } = useSession();
    const { state } = useRunningTimer();
    const running = isRunning(state.timer) ? state.timer : null;
    const showRunning = running !== null && onLog;
    const date = new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }).toLowerCase();

    const tabs = useSharedValue({ x0: 0, w0: 0, x1: 0, w1: 0 });
    const measure = (i: 0 | 1) => (e: LayoutChangeEvent) => {
        const { x, width } = e.nativeEvent.layout;
        tabs.value = i === 0 ? { ...tabs.value, x0: x, w0: width } : { ...tabs.value, x1: x, w1: width };
    };
    const highlight = useAnimatedStyle(() => {
        const t = tabs.value;
        const p = Math.min(1, Math.max(0, progress.value));
        return { transform: [{ translateX: interpolate(p, [0, 1], [t.x0, t.x1]) }], width: interpolate(p, [0, 1], [t.w0, t.w1]) };
    });

    const tabText = (active: boolean) =>
        cn('text-[15px]', active ? 'font-sans-semibold text-navigation-active-foreground' : 'font-sans-medium text-navigation-muted-foreground');

    return (
        <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
            <View className="flex-row items-center gap-1 rounded-xl bg-navigation p-[3px]">
                <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 3, bottom: 3, left: 0 }, highlight]}>
                    <View className="flex-1 rounded-[9px] bg-navigation-active shadow-sm shadow-black/10" />
                </Animated.View>
                <Animated.View layout={resize} onLayout={measure(0)}>
                    <Pressable
                        onPress={() => onPage('now')}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: !onLog }}
                        className={cn(
                            'h-9 flex-row items-center gap-2 rounded-[9px] pl-3.5 pr-3',
                            showRunning && 'max-w-[220px] bg-running-card shadow-sm shadow-black/10',
                        )}
                    >
                        <Icon
                            as={ActivityIcon}
                            className={cn('size-[15px]', showRunning ? 'text-running-card-foreground' : onLog ? 'text-navigation-muted-foreground' : 'text-navigation-active-foreground')}
                        />
                        {showRunning ? (
                            <RunningLabel title={running.d || running.p || 'Activity'} project={running.p} start={running.s} />
                        ) : (
                            <Text className={tabText(!onLog)}>Activity</Text>
                        )}
                    </Pressable>
                </Animated.View>
                <Animated.View layout={resize} onLayout={measure(1)}>
                    <Pressable
                        onPress={() => onPage('log')}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: onLog }}
                        className="h-9 flex-row items-center gap-2 rounded-[9px] pl-3.5 pr-3"
                    >
                        <Icon as={List} className={cn('size-[15px]', onLog ? 'text-navigation-active-foreground' : 'text-navigation-muted-foreground')} />
                        <Text className={tabText(onLog)}>Log</Text>
                    </Pressable>
                </Animated.View>
            </View>
            <DropdownMenu>
                <DropdownMenuTrigger className="rounded-[10px] p-2 active:bg-muted" accessibilityLabel="Account">
                    <View className="size-7 items-center justify-center rounded-lg bg-muted">
                        <Text className="font-sans-semibold text-xs leading-none text-foreground/70">
                            {accountInitials(account?.user.name, account?.user.email)}
                        </Text>
                    </View>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52">
                    <Text className="px-2 pb-1 pt-0.5 text-[13px] text-muted-foreground">{date}</Text>
                    <Text numberOfLines={1} className="px-2 pb-1 text-[13px] text-muted-foreground">
                        {account?.user.email}
                    </Text>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onPress={signOut}>
                        <Icon as={LogOut} className="size-4 text-foreground opacity-70" />
                        <Text>Sign out</Text>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </View>
    );
}

function RunningLabel({ title, project, start }: { title: string; project: string; start: string }) {
    const now = useNow();
    return (
        <>
            <Text numberOfLines={1} className="shrink font-sans-semibold text-[15px] text-running-card-foreground">
                {title}
            </Text>
            <View className="ml-0.5 flex-row items-center gap-1">
                <View className={cn('size-[5px] rounded-full', project ? projectColorClass(project) : 'bg-[#f5c451]')} />
                <Text className="font-mono-medium text-[13px] text-running-card-foreground" style={{ fontVariant: ['tabular-nums'] }}>
                    {formatDuration(now - parseInstant(start).getTime())}
                </Text>
            </View>
        </>
    );
}
