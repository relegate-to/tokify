import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { ArrowLeft, ExternalLink } from 'lucide-react-native';
import { useEffect, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useCSSVariable } from 'uniwind';

import { SafeAreaView } from '@/components/safe-area-view';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { EASE_SIZE, enter } from '@/lib/motion';
import { DAILY_GOALS, usePrefs, type ActivityView, type Theme } from '@/lib/prefs';
import { cn } from '@/lib/utils';

const ISSUES_URL = 'https://github.com/relegate-to/tokify/issues';

// The desktop's SettingsView, less what only a Mac has (menu bar mode,
// scrollbars, the command line and agent setup).
export default function SettingsScreen() {
    const prefs = usePrefs();
    return (
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
            <View className="flex-row items-center gap-1 px-2 pb-2 pt-1">
                <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" className="size-11 items-center justify-center rounded-xl active:bg-muted">
                    <Icon as={ArrowLeft} className="size-5 text-foreground" />
                </Pressable>
                <Text className="font-sans-semibold text-[20px] tracking-[-0.4px]">Settings</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-7 px-5 pb-10 pt-3">
                <Section title="Appearance" delay={0}>
                    <SegmentedRow<Theme>
                        title="Theme"
                        description="Auto follows your system appearance."
                        value={prefs.theme}
                        onChange={(v) => prefs.set('theme', v)}
                        options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'light', label: 'Light' },
                            { value: 'dark', label: 'Dark' },
                        ]}
                    />
                    <SegmentedRow<ActivityView>
                        title="Show activity"
                        description="What appears under the timer on Activity: today's goal progress plus recent tasks, just today's progress, or nothing."
                        value={prefs.activityView}
                        onChange={(v) => prefs.set('activityView', v)}
                        options={[
                            { value: 'all', label: 'All' },
                            { value: 'today', label: 'Today only' },
                            { value: 'none', label: 'Hidden' },
                        ]}
                    />
                    <SegmentedRow
                        title="Daily goal"
                        description="Target tracked time per day, shown as progress on Activity."
                        value={String(prefs.dailyGoal)}
                        onChange={(v) => prefs.set('dailyGoal', Number(v))}
                        options={DAILY_GOALS.map((m) => ({ value: String(m), label: `${m / 60}h` }))}
                    />
                </Section>
                <Section title="Notes" delay={60}>
                    <SwitchRow
                        title="Tick off to-dos when stopped"
                        description="When an activity started from a to-do in your notes stops, mark the to-do done instead of asking."
                        value={prefs.autoCompleteTodos}
                        onChange={(v) => prefs.set('autoCompleteTodos', v)}
                    />
                </Section>
                <Section title="About" delay={120}>
                    <Row title="Version" description={`Tokify ${Constants.expoConfig?.version ?? ''}`} />
                    <Pressable onPress={() => Linking.openURL(ISSUES_URL)} accessibilityRole="link" className="active:bg-muted">
                        <Row title="Report an issue" description="Opens the Tokify issue tracker on GitHub.">
                            <Icon as={ExternalLink} className="size-4 text-muted-foreground" />
                        </Row>
                    </Pressable>
                </Section>
            </ScrollView>
        </SafeAreaView>
    );
}

function Section({ title, delay, children }: { title: string; delay: number; children: ReactNode }) {
    return (
        <Animated.View entering={enter({ dy: -4, duration: 300, delay })}>
            <View className="gap-2.5">
                <Text className="px-1 font-sans-medium text-xs uppercase tracking-[1px] text-muted-foreground">{title}</Text>
                <View className="overflow-hidden rounded-2xl border border-border bg-card">
                    {/* Clips the last row's divider against the card's edge. */}
                    <View className="-mb-px">{children}</View>
                </View>
            </View>
        </Animated.View>
    );
}

function Row({ title, description, stacked = false, children }: { title: string; description?: string; stacked?: boolean; children?: ReactNode }) {
    return (
        <View className={cn('gap-3 border-b border-border/70 px-4 py-3.5', stacked ? 'items-start' : 'flex-row items-center')}>
            <View className={cn('gap-0.5', !stacked && 'flex-1')}>
                <Text className="text-base">{title}</Text>
                {description ? <Text className="text-[13px] leading-[18px] text-muted-foreground">{description}</Text> : null}
            </View>
            {children}
        </View>
    );
}

// The desktop's segmented setting, stacked under its text at phone width.
function SegmentedRow<T extends string>({
    title,
    description,
    value,
    onChange,
    options,
}: {
    title: string;
    description?: string;
    value: T;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
}) {
    return (
        <Row title={title} description={description} stacked>
            <View className="flex-row rounded-lg border border-border bg-muted/40 p-0.5">
                {options.map((o) => {
                    const active = o.value === value;
                    return (
                        <Pressable
                            key={o.value}
                            onPress={() => {
                                Haptics.selectionAsync().catch(() => undefined);
                                onChange(o.value);
                            }}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: active }}
                            className={cn('rounded-md px-3.5 py-1.5', active && 'bg-background shadow-sm shadow-black/10')}
                        >
                            <Text className={cn('text-sm', active ? 'font-sans-medium text-foreground' : 'text-muted-foreground')}>{o.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </Row>
    );
}

// The desktop's switch, sized for a thumb, its knob and fill eased together.
function SwitchRow({ title, description, value, onChange }: { title: string; description?: string; value: boolean; onChange: (v: boolean) => void }) {
    const on = useSharedValue(value ? 1 : 0);
    useEffect(() => {
        on.value = withTiming(value ? 1 : 0, { duration: 200, easing: EASE_SIZE });
    }, [value, on]);
    const [fg, muted] = useCSSVariable(['--color-foreground', '--color-muted']).map(String);
    const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(on.value, [0, 1], [muted, fg]) }));
    const knob = useAnimatedStyle(() => ({ transform: [{ translateX: 2 + on.value * 20 }] }));
    return (
        <Pressable
            onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                onChange(!value);
            }}
            accessibilityRole="switch"
            accessibilityState={{ checked: value }}
            className="active:bg-muted/50"
        >
            <Row title={title} description={description}>
                <Animated.View style={[{ width: 46, height: 26, borderRadius: 13, justifyContent: 'center' }, track]}>
                    <Animated.View style={knob}>
                        <View className="size-[22px] rounded-full bg-background shadow-sm shadow-black/20" />
                    </Animated.View>
                </Animated.View>
            </Row>
        </Pressable>
    );
}
