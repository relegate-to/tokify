import { Activity as ActivityIcon, BarChart3, FileText, List, LogOut } from 'lucide-react-native';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, FadeOut, interpolate, LinearTransition, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

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

export type Page = 'sketchpad' | 'now' | 'log' | 'reports' | 'charts' | 'stats';

const LOG_VIEWS: { page: Page; label: string; icon: typeof FileText }[] = [
    { page: 'reports', label: 'Reports', icon: FileText },
    { page: 'charts', label: 'Charts', icon: BarChart3 },
    { page: 'stats', label: 'Stats', icon: ActivityIcon },
];

// The desktop's SIZE_TRANSITION, for the Activity tab growing into the
// running pill.
const resize = LinearTransition.duration(300).easing(EASE_SIZE);

// The desktop masthead (Masthead.tsx) at phone width: the Activity / Log
// segmented control on the left, the account square on the right. The active
// highlight rides the pager's scroll position, so it follows a swipe
// continuously. Off the Activity page a running timer turns its tab into the
// running pill.
export function Masthead({ page, progress, onPage }: { page: Page; progress: SharedValue<number>; onPage: (page: Page) => void }) {
    // Every page after Activity belongs to Log, as the desktop's LOG_VIEWS do;
    // the sketchpad before it counts as Activity.
    const onLog = page !== 'now' && page !== 'sketchpad';
    const { account, signOut } = useSession();
    const { state } = useRunningTimer();
    const running = isRunning(state.timer) ? state.timer : null;
    // As on the desktop: the tab names the running timer whenever one runs, and
    // takes the running card's colours only off the Activity page.
    const showRunning = running !== null && onLog;
    const date = new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }).toLowerCase();

    // One value per measurement: both tabs report layout in the same frame, so
    // a shared object would let one tab's write clobber the other's.
    const x0 = useSharedValue(0);
    const w0 = useSharedValue(0);
    const x1 = useSharedValue(0);
    const w1 = useSharedValue(0);
    const measure = (x: SharedValue<number>, w: SharedValue<number>) => (e: LayoutChangeEvent) => {
        x.value = e.nativeEvent.layout.x;
        w.value = e.nativeEvent.layout.width;
    };
    const highlight = useAnimatedStyle(() => {
        const p = Math.min(1, Math.max(0, progress.value));
        return { transform: [{ translateX: interpolate(p, [0, 1], [x0.value, x1.value]) }], width: interpolate(p, [0, 1], [w0.value, w1.value]) };
    });

    const tabText = (active: boolean) =>
        cn('text-[15px]', active ? 'font-sans-semibold text-navigation-active-foreground' : 'font-sans-medium text-navigation-muted-foreground');

    return (
        <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
            <View className="flex-row items-center gap-1 rounded-xl bg-navigation p-[3px]">
                <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 3, bottom: 3, left: 0 }, highlight]}>
                    <View className="flex-1 rounded-[9px] bg-navigation-active shadow-sm shadow-black/10" />
                </Animated.View>
                <Animated.View layout={resize} onLayout={measure(x0, w0)}>
                    <Pressable
                        onPress={() => onPage('now')}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: !onLog }}
                        className={cn(
                            'h-9 flex-row items-center gap-2 rounded-[9px] pl-3.5 pr-3',
                            running && (onLog ? 'max-w-[132px]' : 'max-w-[220px]'),
                            showRunning && 'bg-running-card shadow-sm shadow-black/10',
                        )}
                    >
                        <Icon
                            as={ActivityIcon}
                            className={cn('size-[15px]', showRunning ? 'text-running-card-foreground' : onLog ? 'text-navigation-muted-foreground' : 'text-navigation-active-foreground')}
                        />
                        {running ? (
                            <RunningLabel title={running.d || running.p || 'Activity'} project={running.p} start={running.s} inverted={showRunning} />
                        ) : (
                            <Text className={tabText(!onLog)}>Activity</Text>
                        )}
                    </Pressable>
                </Animated.View>
                <Animated.View layout={resize} onLayout={measure(x1, w1)}>
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
                {onLog ? (
                    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} layout={resize}>
                        <View className="flex-row items-center gap-0.5 pr-1">
                            {LOG_VIEWS.map((v) => (
                                <Pressable
                                    key={v.page}
                                    onPress={() => onPage(v.page)}
                                    accessibilityRole="tab"
                                    accessibilityLabel={v.label}
                                    accessibilityState={{ selected: page === v.page }}
                                    className={cn('size-8 items-center justify-center rounded-lg', page === v.page && 'bg-navigation-active shadow-sm shadow-black/10')}
                                >
                                    <Icon
                                        as={v.icon}
                                        className={cn('size-[15px]', page === v.page ? 'text-navigation-active-foreground' : 'text-navigation-muted-foreground')}
                                    />
                                </Pressable>
                            ))}
                        </View>
                    </Animated.View>
                ) : null}
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

function RunningLabel({ title, project, start, inverted }: { title: string; project: string; start: string; inverted: boolean }) {
    const now = useNow();
    const ink = inverted ? 'text-running-card-foreground' : 'text-navigation-active-foreground';
    return (
        <>
            <Text numberOfLines={1} className={cn('shrink font-sans-semibold text-[15px]', ink)}>
                {title}
            </Text>
            <View className="ml-0.5 flex-row items-center gap-1">
                <View className={cn('size-[5px] rounded-full', project ? projectColorClass(project) : 'bg-[#f5c451]')} />
                <Text className={cn('font-mono-medium text-[13px]', ink)} style={{ fontVariant: ['tabular-nums'] }}>
                    {formatDuration(now - parseInstant(start).getTime())}
                </Text>
            </View>
        </>
    );
}
