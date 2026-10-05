import { router } from 'expo-router';
import { Activity as ActivityIcon, BarChart3, FileText, List, LogOut, Settings as SettingsIcon, Users } from 'lucide-react-native';
import { useEffect, type ComponentProps } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
    interpolate,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { useCSSVariable } from 'uniwind';

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
import { EASE_SIZE, LivePulse } from '@/lib/motion';
import { useRunningTimer } from '@/lib/running-timer';
import { useSession } from '@/lib/session';
import { formatDuration, parseInstant } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { isRunning } from '@/sync/timer';

type ViewAnim = ComponentProps<typeof Animated.View>['style'];
type TextAnim = ComponentProps<typeof Animated.Text>['style'];

export type Page = 'sketchpad' | 'now' | 'log' | 'reports' | 'charts' | 'stats';

const LOG_VIEWS: { page: Page; label: string; icon: typeof FileText }[] = [
    { page: 'reports', label: 'Reports', icon: FileText },
    { page: 'charts', label: 'Charts', icon: BarChart3 },
    { page: 'stats', label: 'Stats', icon: ActivityIcon },
];

const PAD = 3;
const GAP = 4;
const ICON = 32;
const ICON_GAP = 2;
const ICONS_WIDTH = 4 + LOG_VIEWS.length * ICON + (LOG_VIEWS.length - 1) * ICON_GAP;
// The running title's widest on Activity. On the Log pages, where the view
// icons need the room, it folds away to leave the live dot and the time.
const TITLE_MAX = 150;
const TITLE_GAP = 8;
const LABEL = { fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15 } as const;
// The desktop's SIZE_TRANSITION.
const resize = { duration: 300, easing: EASE_SIZE };
const COLOR_VARS = [
    '--color-navigation-active-foreground',
    '--color-navigation-muted-foreground',
    '--color-running-card-foreground',
] as const;

const clamp = (v: number, lo: number, hi: number) => {
    'worklet';
    return Math.min(hi, Math.max(lo, v));
};

// The desktop masthead (Masthead.tsx) at phone width: the Activity / Log
// segmented control on the left, the account square on the right. Every part
// of it is drawn from the pager's scroll position (progress: 0 on Activity, 1
// on Log, 2-4 on its views), so the highlight, the tab widths, the Log view
// icons and the running pill's colours all follow a swipe as it happens.
export function Masthead({ page, progress, onPage }: { page: Page; progress: SharedValue<number>; onPage: (page: Page) => void }) {
    // Every page after Activity belongs to Log, as the desktop's LOG_VIEWS do;
    // the sketchpad before it counts as Activity.
    const onLog = page !== 'now' && page !== 'sketchpad';
    const { account, signOut } = useSession();
    const { state } = useRunningTimer();
    const running = isRunning(state.timer) ? state.timer : null;
    const date = new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }).toLowerCase();
    const [activeInk, mutedInk, runningInk] = useCSSVariable([...COLOR_VARS]).map(String);

    // The Activity tab's natural width, from an unconstrained copy of its
    // contents, eased as the label changes like the desktop's label width.
    const activityWidth = useSharedValue(0);
    const titleWidth = useSharedValue(0);
    const logWidth = useSharedValue(0);
    const live = useSharedValue(running ? 1 : 0);
    useEffect(() => {
        live.value = withTiming(running ? 1 : 0, { duration: 180 });
    }, [running, live]);
    const measureActivity = (e: LayoutChangeEvent) => {
        const w = Math.ceil(e.nativeEvent.layout.width);
        activityWidth.value = activityWidth.value === 0 ? w : withTiming(w, resize);
    };
    const measureTitle = (e: LayoutChangeEvent) => {
        const w = Math.ceil(e.nativeEvent.layout.width);
        titleWidth.value = titleWidth.value === 0 ? w : withTiming(w, resize);
    };

    // Each style reads the shared values itself (Reanimated re-runs a style
    // only for the values its own closure touches) and hands them to these
    // pure helpers.
    const hasTitle = running !== null;
    const shownTitle = (t: number, title: number) => {
        'worklet';
        return Math.min(title, TITLE_MAX + TITLE_GAP) * (1 - t);
    };
    const tabWidth = (t: number, natural: number, title: number) => {
        'worklet';
        return hasTitle ? natural - title + shownTitle(t, title) : natural;
    };
    const titleFold = useAnimatedStyle(() => {
        const t = clamp(progress.value, 0, 1);
        return { width: shownTitle(t, titleWidth.value), opacity: 1 - t };
    });
    const titleCap = { maxWidth: TITLE_MAX };

    const activityStyle = useAnimatedStyle(() => ({ width: tabWidth(clamp(progress.value, 0, 1), activityWidth.value, titleWidth.value) }));
    const highlight = useAnimatedStyle(() => {
        const t = clamp(progress.value, 0, 1);
        const tab = tabWidth(t, activityWidth.value, titleWidth.value);
        return {
            transform: [{ translateX: PAD + interpolate(t, [0, 1], [0, tab + GAP]) }],
            width: interpolate(t, [0, 1], [tab, logWidth.value]),
        };
    });
    const icons = useAnimatedStyle(() => ({ width: clamp(progress.value, 0, 1) * ICONS_WIDTH, opacity: clamp(progress.value, 0, 1) }));
    // The view icons' own highlight slides between Reports, Charts and Stats,
    // and fades out on the way back to Log.
    const iconHighlight = useAnimatedStyle(() => ({
        opacity: clamp(progress.value - 1, 0, 1),
        transform: [{ translateX: 4 + (clamp(progress.value, 2, 2 + LOG_VIEWS.length - 1) - 2) * (ICON + ICON_GAP) }],
    }));
    // Off Activity a running timer turns its tab into the running pill.
    const pill = useAnimatedStyle(() => ({ opacity: clamp(progress.value, 0, 1) * live.value }));
    const activityInk = useAnimatedStyle(() => ({
        color: interpolateColor(clamp(progress.value, 0, 1) * live.value, [0, 1], [interpolateColor(clamp(progress.value, 0, 1), [0, 1], [activeInk, mutedInk]), runningInk]),
    }));
    const logInk = useAnimatedStyle(() => ({ color: interpolateColor(clamp(progress.value, 0, 1), [0, 1], [mutedInk, activeInk]) }));
    const activityActiveIcon = useAnimatedStyle(() => ({ opacity: 1 - clamp(progress.value, 0, 1) }));
    const logActiveIcon = useAnimatedStyle(() => ({ opacity: clamp(progress.value, 0, 1) }));

    const activityContent = (measure: boolean) => (
        <>
            <View className="mr-2">
                <TabIcon icon={ActivityIcon} active={activityActiveIcon} restClass={running ? 'text-running-card-foreground' : undefined} />
            </View>
            {running ? (
                <RunningLabel
                    title={running.d || running.p || 'Activity'}
                    project={running.p}
                    start={running.s}
                    ink={activityInk}
                    fold={measure ? undefined : titleFold}
                    cap={measure ? undefined : titleCap}
                    onTitleLayout={measure ? measureTitle : undefined}
                />
            ) : (
                <Animated.Text style={[LABEL, activityInk]}>Activity</Animated.Text>
            )}
        </>
    );

    return (
        <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
            <View className="flex-row items-center gap-1 overflow-hidden rounded-xl bg-navigation p-[3px]">
                <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: PAD, bottom: PAD, left: 0 }, highlight]}>
                    <View className="flex-1 rounded-[9px] bg-navigation-active shadow-sm shadow-black/10" />
                </Animated.View>
                <View pointerEvents="none" style={{ position: 'absolute', opacity: 0, left: 0, top: 0, width: 1000 }}>
                    <View onLayout={measureActivity} className="h-9 flex-row items-center self-start pl-3.5 pr-3">
                        {activityContent(true)}
                    </View>
                </View>
                <Animated.View style={[{ overflow: 'hidden' }, activityStyle]}>
                    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }, pill]}>
                        <View className="flex-1 rounded-[9px] bg-running-card shadow-sm shadow-black/10" />
                    </Animated.View>
                    <Pressable
                        onPress={() => onPage('now')}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: !onLog }}
                        className="h-9 flex-row items-center pl-3.5 pr-3"
                    >
                        {activityContent(false)}
                    </Pressable>
                </Animated.View>
                <Pressable
                    onPress={() => onPage('log')}
                    onLayout={(e) => (logWidth.value = e.nativeEvent.layout.width)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: onLog }}
                    className="h-9 flex-row items-center gap-2 pl-3.5 pr-3"
                >
                    <TabIcon icon={List} active={logActiveIcon} />
                    <Animated.Text style={[LABEL, logInk]}>Log</Animated.Text>
                </Pressable>
                <Animated.View style={[{ overflow: 'hidden' }, icons]}>
                    <View className="flex-row items-center pl-1" style={{ width: ICONS_WIDTH, gap: ICON_GAP }}>
                        <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, width: ICON, height: ICON }, iconHighlight]}>
                            <View className="flex-1 rounded-lg bg-navigation-active shadow-sm shadow-black/10" />
                        </Animated.View>
                        {LOG_VIEWS.map((v, i) => (
                            <LogIcon key={v.page} view={v} index={i} progress={progress} selected={page === v.page} onPress={() => onPage(v.page)} />
                        ))}
                    </View>
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
                    <DropdownMenuItem onPress={() => router.push('/teams')}>
                        <Icon as={Users} className="size-4 text-foreground opacity-70" />
                        <Text>Teams</Text>
                    </DropdownMenuItem>
                    <DropdownMenuItem onPress={() => router.push('/settings')}>
                        <Icon as={SettingsIcon} className="size-4 text-foreground opacity-70" />
                        <Text>Settings</Text>
                    </DropdownMenuItem>
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

// The tab icon in its resting and active inks, cross-faded, since an icon's
// colour can't be animated directly.
function TabIcon({ icon, active, restClass }: { icon: typeof List; active: ViewAnim; restClass?: string }) {
    return (
        <View className="size-[15px]">
            <Icon as={icon} className={cn('absolute size-[15px] text-navigation-muted-foreground', restClass)} />
            <Animated.View style={[{ position: 'absolute' }, active]}>
                <Icon as={icon} className="size-[15px] text-navigation-active-foreground" />
            </Animated.View>
        </View>
    );
}

function LogIcon({
    view,
    index,
    progress,
    selected,
    onPress,
}: {
    view: (typeof LOG_VIEWS)[number];
    index: number;
    progress: SharedValue<number>;
    selected: boolean;
    onPress: () => void;
}) {
    const active = useAnimatedStyle(() => ({ opacity: clamp(1 - Math.abs(progress.value - 2 - index), 0, 1) }));
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityLabel={view.label}
            accessibilityState={{ selected }}
            className="items-center justify-center"
            style={{ width: ICON, height: ICON }}
        >
            <TabIcon icon={view.icon} active={active} />
        </Pressable>
    );
}

// The running title, then the live dot and the time. The title sits in a
// fold (with the gap after it) that the masthead narrows to nothing on the
// Log pages; the measuring copy leaves it unfolded and reports its width.
function RunningLabel({
    title,
    project,
    start,
    ink,
    fold,
    cap,
    onTitleLayout,
}: {
    title: string;
    project: string;
    start: string;
    ink: TextAnim;
    fold?: ViewAnim;
    cap?: TextAnim;
    onTitleLayout?: (e: LayoutChangeEvent) => void;
}) {
    const now = useNow();
    return (
        <>
            <Animated.View style={[{ overflow: 'hidden' }, fold]}>
                <View onLayout={onTitleLayout} className="flex-row self-start" style={{ paddingRight: TITLE_GAP }}>
                    <Animated.Text numberOfLines={1} style={[LABEL, ink, cap]}>
                        {title}
                    </Animated.Text>
                </View>
            </Animated.View>
            <View className="shrink-0 flex-row items-center gap-1.5">
                <LivePulse className={cn('size-[5px]', project ? projectColorClass(project) : 'bg-[#f5c451]')} />
                <Animated.Text style={[{ fontFamily: 'IBMPlexMono_500Medium', fontSize: 13, fontVariant: ['tabular-nums'] }, ink]}>
                    {formatDuration(now - parseInstant(start).getTime())}
                </Animated.Text>
            </View>
        </>
    );
}
