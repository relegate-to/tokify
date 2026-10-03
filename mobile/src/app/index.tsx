import { useRef, useState } from 'react';
import PagerView from 'react-native-pager-view';

import { Masthead, type Page } from '@/components/Masthead';
import { SafeAreaView } from '@/components/safe-area-view';
import { EntriesProvider } from '@/lib/entries';
import { RunningTimerProvider } from '@/lib/running-timer';
import { LogPage } from '@/pages/LogPage';
import { NowPage } from '@/pages/NowPage';

const PAGES: Page[] = ['now', 'log'];

// The main pages side by side under the masthead, swiped between as on the
// desktop (its Swiper over SWIPE_VIEWS); the masthead tabs page the same pager.
export default function MainScreen() {
    const pager = useRef<PagerView>(null);
    const [page, setPage] = useState<Page>('now');
    return (
        <EntriesProvider>
            <RunningTimerProvider>
                <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                    <Masthead page={page} onPage={(p) => pager.current?.setPage(PAGES.indexOf(p))} />
                    <PagerView
                        ref={pager}
                        style={{ flex: 1 }}
                        initialPage={0}
                        onPageSelected={(e) => setPage(PAGES[e.nativeEvent.position])}
                    >
                        <NowPage key="now" />
                        <LogPage key="log" />
                    </PagerView>
                </SafeAreaView>
            </RunningTimerProvider>
        </EntriesProvider>
    );
}
