import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Shows this device's native push token so a test push can be sent to it.
// Not linked from the app; open tokify://push-check.
Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export default function PushCheck() {
    const [lines, setLines] = useState<string[]>([]);
    useEffect(() => {
        const log = (line: string) => setLines((ls) => [...ls, line]);
        const sub = Notifications.addNotificationReceivedListener((n) => log(`received: ${JSON.stringify(n.request.content.data)}`));
        (async () => {
            const { status } = await Notifications.requestPermissionsAsync();
            log(`permission: ${status}`);
            if (status !== 'granted') return;
            const { type, data } = await Notifications.getDevicePushTokenAsync();
            console.log('push token', type, data);
            log(`${type} token:\n${data}`);
        })().catch((e) => log(`error: ${String(e)}`));
        return () => sub.remove();
    }, []);
    return (
        <SafeAreaView style={styles.root}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
                <Text style={styles.title}>Tokify push check</Text>
                {lines.map((l, i) => (
                    <Text key={i} selectable style={styles.row}>
                        {l}
                    </Text>
                ))}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#fafafa' },
    body: { padding: 24, paddingTop: 64, gap: 12 },
    title: { fontSize: 22, fontWeight: '600', marginBottom: 8 },
    row: { fontSize: 14, fontFamily: 'monospace' },
});
