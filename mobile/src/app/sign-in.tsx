import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { SafeAreaView } from '@/components/safe-area-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/session';
import { resendCode, signIn, verifyEmail, type SignInResult } from '@/sync/account';

export default function SignInScreen() {
    const { setAccount } = useSession();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const finish = (r: SignInResult) => {
        if (r.kind === 'signed-in') setAccount(r.account);
        else setVerifying(true);
    };

    const submit = async () => {
        setBusy(true);
        setError('');
        try {
            finish(verifying ? await verifyEmail(email, password, code) : await signIn(email, password));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const canSubmit = !busy && (verifying ? code.trim().length > 0 : email.trim().length > 0 && password.length > 0);

    return (
        <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <ScrollView showsVerticalScrollIndicator={false} className="flex-1" contentContainerClassName="gap-6 px-5 pt-16" keyboardShouldPersistTaps="handled">
                    <View className="gap-2">
                        <Text className="font-sans-semibold text-[28px] leading-[34px] tracking-[-0.5px]">
                            {verifying ? 'Check your email' : 'Sign in to Tokify'}
                        </Text>
                        <Text className="text-muted-foreground">
                            {verifying
                                ? `We emailed a verification code to ${email.trim()}. Enter it below to finish setting up your account.`
                                : 'Use the account you sync with on the desktop. Your timer and history stay end-to-end encrypted.'}
                        </Text>
                    </View>
                    {verifying ? (
                        <View className="gap-3">
                            <Input
                                value={code}
                                onChangeText={setCode}
                                placeholder="123456"
                                keyboardType="number-pad"
                                autoComplete="one-time-code"
                                textContentType="oneTimeCode"
                                accessibilityLabel="Verification code"
                                autoFocus
                            />
                            <Button variant="ghost" className="self-start px-0" onPress={() => resendCode(email).catch((e) => setError(String(e)))}>
                                <Text className="text-muted-foreground">Send a new code</Text>
                            </Button>
                        </View>
                    ) : (
                        <View className="gap-3">
                            <Input
                                value={email}
                                onChangeText={setEmail}
                                placeholder="you@example.com"
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoComplete="email"
                                textContentType="emailAddress"
                                accessibilityLabel="Email"
                            />
                            <Input
                                value={password}
                                onChangeText={setPassword}
                                placeholder="Your password"
                                secureTextEntry
                                autoComplete="current-password"
                                textContentType="password"
                                accessibilityLabel="Password"
                                onSubmitEditing={() => canSubmit && submit()}
                            />
                        </View>
                    )}
                    {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                </ScrollView>
                <View className="px-5 pb-3 pt-2">
                    <Button size="lg" className="h-14 rounded-xl" disabled={!canSubmit} onPress={submit}>
                        {busy ? <ActivityIndicator className="text-primary-foreground" /> : null}
                        <Text className="font-sans-semibold text-base">{verifying ? 'Verify email' : 'Sign in'}</Text>
                    </Button>
                </View>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
