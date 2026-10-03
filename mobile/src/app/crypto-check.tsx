import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import vectors from '../../../internal/integrations/neonsync/testdata/crypto-vectors.json';
import { argon2id } from '@/crypto/argon2';
import { bytesToHex, hexToBytes, toBase64 } from '@/crypto/bytes';
import { decryptOwnEntry, deriveAuthHash, deriveKEK, openTimer, sealTimer } from '@/crypto/sync';

// Checks the native Argon2id and the rest of the crypto port against the
// desktop's vectors on a device. Not linked from the app; open
// tokify://crypto-check on a new platform or after touching the crypto.
type Result = { name: string; ok: boolean; ms: number; detail?: string };

async function run(name: string, fn: () => Promise<boolean> | boolean): Promise<Result> {
    const t0 = Date.now();
    try {
        return { name, ok: await fn(), ms: Date.now() - t0 };
    } catch (e) {
        return { name, ok: false, ms: Date.now() - t0, detail: String(e) };
    }
}

async function selfTest(push: (r: Result) => void) {
    for (const v of vectors.auth_hash) {
        push(await run(`auth hash ${v.email.trim()}`, async () => (await deriveAuthHash(argon2id, v.email, v.password)) === v.auth_hash_b64));
    }
    const k = vectors.kek[0];
    push(await run('KEK from salt_enc', async () => bytesToHex(await deriveKEK(argon2id, k.password, hexToBytes(k.salt_enc_hex))) === k.kek_hex));
    push(await run('desktop entries decrypt (v1 + v2)', () =>
        vectors.entries.every((v) =>
            [v.v1_ciphertext_b64, v.v2_ciphertext_b64].every(
                (ct) => decryptOwnEntry(hexToBytes(v.dek_hex), v.owner_id, { id: v.entry_id, ciphertext: ct, nonce: toBase64(hexToBytes(v.nonce_hex)) }).description === v.description,
            ),
        ),
    ));
    push(await run('desktop timer opens and reseals', () => {
        const v = vectors.timers[0];
        const dek = hexToBytes(v.dek_hex);
        const row = { user_id: v.owner_id, version: v.version, ciphertext: v.ciphertext_b64, nonce: toBase64(hexToBytes(v.nonce_hex)) };
        const timer = openTimer(dek, row);
        const again = openTimer(dek, { ...row, ...sealTimer(dek, v.owner_id, v.version, timer) });
        return timer.s === JSON.parse(v.timer_json).s && again.s === timer.s;
    }));
}

export default function CryptoCheck() {
    const [results, setResults] = useState<Result[]>([]);
    const [done, setDone] = useState(false);
    useEffect(() => {
        selfTest((r) => setResults((rs) => [...rs, r])).finally(() => setDone(true));
    }, []);
    return (
        <SafeAreaView style={styles.root}>
            <ScrollView contentContainerStyle={styles.body}>
                <Text style={styles.title}>Tokify crypto self-test</Text>
                {results.map((r) => (
                    <Text key={r.name} style={[styles.row, { color: r.ok ? '#15803d' : '#b91c1c' }]}>
                        {r.ok ? 'PASS' : 'FAIL'}  {r.name}  ({r.ms} ms){r.detail ? `\n${r.detail}` : ''}
                    </Text>
                ))}
                <Text style={styles.row}>{done ? (results.every((r) => r.ok) ? 'All passed.' : 'Some checks failed.') : 'Running…'}</Text>
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
