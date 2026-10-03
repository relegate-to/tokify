import { Activity as ActivityIcon, List, LogOut } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

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
import { useRunningTimer } from '@/lib/running-timer';
import { useSession } from '@/lib/session';
import { formatDuration, parseInstant } from '@/lib/time';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { isRunning } from '@/sync/timer';

// The desktop masthead (Masthead.tsx) at phone width: the Activity / Log
// segmented control on the left, the account square on the right. Off the
// Activity view, a running timer turns its tab into the running pill.
export type Page = 'now' | 'log';

export function Masthead({ page, onPage }: { page: Page; onPage: (page: Page) => void }) {
    const onLog = page === 'log';
    const { account, signOut } = useSession();
    const { state } = useRunningTimer();
    const running = isRunning(state.timer) ? state.timer : null;
    const showRunning = running !== null && onLog;
    const date = new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }).toLowerCase();

    return (
        <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
            <View className="flex-row items-center gap-1 rounded-[10px] bg-navigation p-[3px]">
                <Pressable
                    onPress={() => onPage('now')}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: !onLog }}
                    className={cn(
                        'h-[30px] flex-row items-center gap-[7px] rounded-lg pl-3 pr-2.5',
                        !onLog && 'bg-navigation-active shadow-sm shadow-black/10',
                        showRunning && 'max-w-[220px] bg-running-card shadow-sm shadow-black/10',
                    )}
                >
                    <Icon
                        as={ActivityIcon}
                        className={cn(
                            'size-[13px]',
                            showRunning ? 'text-running-card-foreground' : onLog ? 'text-navigation-muted-foreground' : 'text-navigation-active-foreground',
                        )}
                    />
                    {showRunning ? (
                        <RunningLabel title={running.d || running.p || 'Activity'} project={running.p} start={running.s} />
                    ) : (
                        <Text
                            className={cn(
                                'text-[13.5px]',
                                onLog ? 'font-sans-medium text-navigation-muted-foreground' : 'font-sans-semibold text-navigation-active-foreground',
                            )}
                        >
                            Activity
                        </Text>
                    )}
                </Pressable>
                <Pressable
                    onPress={() => onPage('log')}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: onLog }}
                    className={cn('h-[30px] flex-row items-center gap-[7px] rounded-lg pl-3 pr-2.5', onLog && 'bg-navigation-active shadow-sm shadow-black/10')}
                >
                    <Icon as={List} className={cn('size-[13px]', onLog ? 'text-navigation-active-foreground' : 'text-navigation-muted-foreground')} />
                    <Text
                        className={cn(
                            'text-[13.5px]',
                            onLog ? 'font-sans-semibold text-navigation-active-foreground' : 'font-sans-medium text-navigation-muted-foreground',
                        )}
                    >
                        Log
                    </Text>
                </Pressable>
            </View>
            <DropdownMenu>
                <DropdownMenuTrigger className="rounded-[9px] p-[7px] active:bg-muted">
                    <View className="size-[21px] items-center justify-center rounded-[6px] bg-muted">
                        <Text className="font-sans-semibold text-[10.5px] leading-none text-foreground/70">
                            {accountInitials(account?.user.name, account?.user.email)}
                        </Text>
                    </View>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                    <Text className="px-2 pb-1 pt-0.5 text-[12.5px] text-muted-foreground">{date}</Text>
                    <Text numberOfLines={1} className="px-2 pb-1 text-[12.5px] text-muted-foreground">
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
            <Text numberOfLines={1} className="shrink font-sans-semibold text-[13.5px] text-running-card-foreground">
                {title}
            </Text>
            <View className="ml-0.5 flex-row items-center gap-1">
                <View className={cn('size-[5px] rounded-full', project ? projectColorClass(project) : 'bg-[#f5c451]')} />
                <Text className="font-mono-medium text-[11.5px] text-running-card-foreground" style={{ fontVariant: ['tabular-nums'] }}>
                    {formatDuration(now - parseInstant(start).getTime())}
                </Text>
            </View>
        </>
    );
}
