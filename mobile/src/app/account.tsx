import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { ArrowLeft, Camera, LogOut, ShieldCheck, ShieldOff } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { MemberAvatar } from '@/components/MemberAvatar';
import { SafeAreaView } from '@/components/safe-area-view';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { fingerprint, publicIdentity } from '@/crypto/sharing';
import { accountInitials } from '@/lib/account';
import { AvatarError, pickAvatar } from '@/lib/avatar';
import { useEntries } from '@/lib/entries';
import { enter } from '@/lib/motion';
import { useSession } from '@/lib/session';
import { formatTotal, parseSyncTime } from '@/lib/time';
import { updateAvatar } from '@/sync/account';
import { loadIdentity } from '@/sync/identity';

// The desktop's AccountView at phone size: who you are (with the picture your
// teammates see), how your history syncs, and the key they verify you by.
export default function AccountScreen() {
    const { account, setAccount, signOut } = useSession();
    const { entries } = useEntries();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [keyPrint, setKeyPrint] = useState<string | null | undefined>(undefined);

    useEffect(() => {
        loadIdentity().then((id) => setKeyPrint(id ? fingerprint(publicIdentity(id)) : null));
    }, []);

    if (!account) return null;
    const { user } = account;
    const label = user.name?.trim() || user.email;
    const total = (entries ?? []).reduce((sum, e) => sum + parseSyncTime(e.end).getTime() - parseSyncTime(e.start).getTime(), 0);

    const setPicture = async (pick: () => Promise<string | null>) => {
        if (busy) return;
        setError('');
        try {
            const image = await pick();
            if (image === null) return;
            setBusy(true);
            setAccount(await updateAvatar(account, image));
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        } catch (e) {
            setError(e instanceof AvatarError || e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
            <View className="flex-row items-center gap-1 px-2 pb-2 pt-1">
                <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" className="size-11 items-center justify-center rounded-xl active:bg-muted">
                    <Icon as={ArrowLeft} className="size-5 text-foreground" />
                </Pressable>
                <Text className="font-sans-semibold text-[20px] tracking-[-0.4px]">Account</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-7 px-5 pb-10 pt-3">
                <Animated.View entering={enter({ dy: -4, duration: 300 })}>
                    <View className="items-center gap-3">
                    <Pressable onPress={() => setPicture(pickAvatar)} accessibilityRole="button" accessibilityLabel="Change picture">
                        {user.image ? (
                            <MemberAvatar seed={user.id} label={label} image={user.image} size={88} />
                        ) : (
                            <View className="size-[88px] items-center justify-center rounded-3xl bg-muted">
                                <Text className="font-sans-semibold text-[28px] text-foreground/70">{accountInitials(user.name, user.email)}</Text>
                            </View>
                        )}
                        <View className="absolute -bottom-1 -right-1 size-8 items-center justify-center rounded-full border-2 border-background bg-foreground">
                            {busy ? <ActivityIndicator size="small" /> : <Icon as={Camera} className="size-4 text-background" />}
                        </View>
                    </Pressable>
                    <View className="items-center gap-0.5">
                        <Text className="font-sans-semibold text-[20px] tracking-[-0.3px]">{label}</Text>
                        {user.name?.trim() ? <Text className="text-[15px] text-muted-foreground">{user.email}</Text> : null}
                    </View>
                    {user.image ? (
                        <Button variant="ghost" size="sm" onPress={() => setPicture(async () => '')} disabled={busy}>
                            <Text className="text-muted-foreground">Remove picture</Text>
                        </Button>
                    ) : null}
                    {error ? <Text className="text-center text-sm text-destructive">{error}</Text> : null}
                    </View>
                </Animated.View>

                <Section title="Sync" delay={60}>
                    <Row title="End-to-end encrypted" description="Your history is encrypted on this phone with a key only your password unlocks. The server never sees it.">
                        <Icon as={ShieldCheck} className="size-5 text-emerald-500/80" />
                    </Row>
                    <Row
                        title="Your history"
                        description={entries === null ? 'Loading…' : `${entries.length.toLocaleString()} ${entries.length === 1 ? 'activity' : 'activities'} · ${formatTotal(total)} tracked`}
                    />
                </Section>

                <Section title="Sharing" delay={120}>
                    {keyPrint === undefined ? (
                        <Row title="Security key" description="Loading…" />
                    ) : keyPrint ? (
                        <View className="gap-2 border-b border-border/70 px-4 py-3.5">
                            <View className="gap-0.5">
                                <Text className="text-base">Your security key</Text>
                                <Text className="text-[13px] leading-[18px] text-muted-foreground">Teammates can compare this with what Tokify shows them for you.</Text>
                            </View>
                            <Text selectable className="font-mono text-[13px] leading-5 tracking-[0.5px] text-foreground/80">
                                {keyPrint}
                            </Text>
                        </View>
                    ) : (
                        <Pressable onPress={() => router.push('/teams')} className="active:bg-muted/50">
                            <Row title="Sharing is locked on this phone" description="Open Teams and enter your password once to unlock it.">
                                <Icon as={ShieldOff} className="size-5 text-muted-foreground" />
                            </Row>
                        </Pressable>
                    )}
                </Section>

                <Button variant="outline" className="h-12 rounded-xl" onPress={signOut}>
                    <Icon as={LogOut} className="size-4 text-foreground" />
                    <Text>Sign out</Text>
                </Button>
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
                    <View className="-mb-px">{children}</View>
                </View>
            </View>
        </Animated.View>
    );
}

function Row({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
    return (
        <View className="flex-row items-center gap-3 border-b border-border/70 px-4 py-3.5">
            <View className="flex-1 gap-0.5">
                <Text className="text-base">{title}</Text>
                {description ? <Text className="text-[13px] leading-[18px] text-muted-foreground">{description}</Text> : null}
            </View>
            {children}
        </View>
    );
}
