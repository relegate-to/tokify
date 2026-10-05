import { requireNativeModule } from 'expo';

type TokifyArgon2 = {
    // Argon2id (v1.3) over raw bytes, hex in and out.
    hashHex(passwordHex: string, saltHex: string, iterations: number, memoryKiB: number, parallelism: number, length: number): Promise<string>;
};

export default requireNativeModule<TokifyArgon2>('TokifyArgon2');
