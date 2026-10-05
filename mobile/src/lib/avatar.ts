import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

// The desktop's avatar rules (cmd/tock-desktop/frontend/src/lib/avatar.ts): a
// 128px square, center-cropped, as a data: URI under the server's 256 KB cap,
// since it travels inline on the account and every roster read.
const AVATAR_PX = 128;
const MAX_BYTES = 256 * 1024;
const QUALITIES = [0.82, 0.7, 0.55, 0.4];

export class AvatarError extends Error {}

// Lets the person pick (and square up) a photo, or returns null if they back out.
export async function pickAvatar(): Promise<string | null> {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
    if (picked.canceled || !picked.assets[0]) return null;
    const { uri, width, height } = picked.assets[0];
    const side = Math.min(width, height);
    const square = await ImageManipulator.manipulate(uri)
        .crop({ originX: (width - side) / 2, originY: (height - side) / 2, width: side, height: side })
        .resize({ width: AVATAR_PX, height: AVATAR_PX })
        .renderAsync();
    for (const compress of QUALITIES) {
        const { base64 } = await square.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
        const uriOut = `data:image/jpeg;base64,${base64}`;
        if (base64 && uriOut.length <= MAX_BYTES) return uriOut;
    }
    throw new AvatarError("That image is too detailed to use. Try another one.");
}
