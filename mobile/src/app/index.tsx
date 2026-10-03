import { useRef, useState } from 'react';
import { View } from 'react-native';
import PagerView, { type PagerViewOnPageScrollEventData } from 'react-native-pager-view';
import Animated, { useEvent, useSharedValue } from 'react-native-reanimated';

import { Masthead, type Page } from '@/components/Masthead';
import { SafeAreaView } from '@/components/safe-area-view';
import { EntriesProvider } from '@/lib/entries';
import { RunningTimerProvider } from '@/lib/running-timer';
import { ChartsPage } from '@/pages/ChartsPage';
import { LogPage } from '@/pages/LogPage';
import { NowPage } from '@/pages/NowPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { StatsPage } from '@/pages/StatsPage';

// The desktop's SWIPE_VIEWS, less the sketchpad.
const PAGES: Page[] = ['now', 'log', 'reports', 'charts', 'stats'];

const AnimatedPager = Animated.createAnimatedComponent(PagerView);

// Feeds the pager's scroll position (page index plus fraction) to a shared
// value on the UI thread, as react-native-pager-view's Reanimated example does.
function usePagerProgress() {
    const progress = useSharedValue(0);
    const onPageScroll = useEvent<PagerViewOnPageScrollEventData>(
        (e) => {
            'worklet';
            progress.value = e.position + e.offset;
        },
        ['onPageScroll'],
    );
    // Reanimated's processed handler is typed against the event payload, not the
    // synthetic event the pager's prop declares; it is what the pager expects.
    return { progress, onPageScroll: onPageScroll as unknown as (e: unknown) => void };
}

// The main pages side by side under the masthead, swiped between as on the
// desktop (its Swiper over SWIPE_VIEWS); the masthead tabs page the same pager.
export default function MainScreen() {
    const pager = useRef<PagerView>(null);
    const [page, setPage] = useState<Page>('now');
    const { progress, onPageScroll } = usePagerProgress();
    return (
        <EntriesProvider>
            <RunningTimerProvider>
                <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                    <Masthead page={page} progress={progress} onPage={(p) => pager.current?.setPage(PAGES.indexOf(p))} />
                    <AnimatedPager
                        ref={pager}
                        style={{ flex: 1 }}
                        initialPage={0}
                        onPageScroll={onPageScroll}
                        onPageSelected={(e) => setPage(PAGES[e.nativeEvent.position])}
                    >
                        <NowPage key="now" />
                        <LogPage key="log" />
                        <View key="reports" style={{ flex: 1 }}>
                            <ReportsPage />
                        </View>
                        <View key="charts" style={{ flex: 1 }}>
                            <ChartsPage />
                        </View>
                        <View key="stats" style={{ flex: 1 }}>
                            <StatsPage />
                        </View>
                    </AnimatedPager>
                </SafeAreaView>
            </RunningTimerProvider>
        </EntriesProvider>
    );
}
