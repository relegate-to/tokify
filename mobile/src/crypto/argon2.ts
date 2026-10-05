import TokifyArgon2 from '../../modules/tokify-argon2';

import { bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { ARGON, type Argon2id } from './sync';

// The phone's Argon2id: native (argon2kt on Android, Argon2Swift on iOS), since
// 64 MiB × 3 passes in JavaScript takes too long at sign-in. It takes the
// desktop's four lanes, which libsodium's Argon2id cannot.
export const argon2id: Argon2id = async (password, salt) =>
    hexToBytes(
        await TokifyArgon2.hashHex(
            bytesToHex(utf8ToBytes(password)),
            bytesToHex(salt),
            ARGON.time,
            ARGON.memoryKiB,
            ARGON.parallelism,
            ARGON.keyLen,
        ),
    );
