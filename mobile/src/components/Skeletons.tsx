import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

// Stand-ins shaped like the views they precede, so the history arriving
// fills them in place instead of pushing the page around.

export function TodayGoalSkeleton() {
    return <Skeleton className="h-[74px] rounded-[14px]" />;
}

export function JumpBackInSkeleton() {
    return (
        <View>
            <Skeleton className="mb-4 ml-1 h-4 w-28" />
            {[0.62, 0.48, 0.7, 0.54].map((w, i) => (
                <View key={i} className="flex-row items-center gap-3 border-t border-border px-1 py-3.5">
                    <View className="flex-1 gap-2">
                        <Skeleton className="h-4" style={{ width: `${w * 100}%` }} />
                        <Skeleton className="h-3 w-24" />
                    </View>
                    <Skeleton className="size-10 rounded-xl" />
                </View>
            ))}
        </View>
    );
}

export function ContributionGraphSkeleton() {
    return (
        <View className="gap-3 rounded-2xl border border-subtle-surface-border bg-subtle-surface px-4 py-4">
            <View className="flex-row justify-between">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
            </View>
            <Skeleton className="h-[123px] rounded-[4px]" />
        </View>
    );
}

export function LogRowsSkeleton() {
    return (
        <View>
            {[5, 3].map((rows, d) => (
                <View key={d}>
                    <View className="flex-row justify-between border-b border-border px-5 pb-2.5 pt-7">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-4 w-12" />
                    </View>
                    {Array.from({ length: rows }, (_, i) => (
                        <View key={i} className="gap-2 border-b border-border/60 px-5 py-3.5">
                            <View className="flex-row items-center gap-3">
                                <Skeleton className="h-4" style={{ width: `${[58, 44, 66, 50, 38][i % 5]}%` }} />
                                <View className="flex-1" />
                                <Skeleton className="h-4 w-12" />
                            </View>
                            <Skeleton className="ml-[18px] h-3 w-32" />
                        </View>
                    ))}
                </View>
            ))}
        </View>
    );
}

// Reports, Charts and Stats: the headline band, then the detail panels.
export function SummarySkeleton() {
    return (
        <View className="gap-4 px-5 pt-2">
            <Skeleton className="h-10 w-48 rounded-lg" />
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-52 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
        </View>
    );
}
