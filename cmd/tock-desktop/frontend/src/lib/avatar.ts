// Turns a picked image file into a small, self-contained data: URI.
//
// Avatars are stored inline on the account record and republished onto the
// public sharing identity, so size is paid for on every roster read. Downscaling
// to a 128px square here — rather than uploading the original — is what lets an
// avatar travel as a plain text column with no blob store behind it.

const AVATAR_PX = 128;

// Matches maxAvatarBytes in internal/integrations/neonauth/service.go. Keeping
// the client under the server's cap means a rejection is a bug, not a routine
// outcome the user has to interpret.
const MAX_BYTES = 256 * 1024;

// Quality ladder walked until the encoded result fits. A 128px square lands far
// under the cap at the first step; the rest is headroom for noisy photographs.
const QUALITIES = [0.82, 0.7, 0.55, 0.4];

export class AvatarError extends Error {}

// readAvatarFile decodes, square-crops and downscales a picked file, returning a
// data: URI ready to hand to AuthUpdateAvatar.
export async function readAvatarFile(file: File): Promise<string> {
    if (!file.type.startsWith('image/')) {
        throw new AvatarError('That file is not an image. Pick a PNG or JPEG.');
    }

    // from-image applies the EXIF orientation a phone camera writes, so a photo
    // taken sideways is not stored sideways.
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        throw new AvatarError("That image couldn't be read. Try another one.");
    }

    try {
        return encode(bitmap);
    } finally {
        bitmap.close();
    }
}

function encode(bitmap: ImageBitmap): string {
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AvatarError("That image couldn't be read. Try another one.");

    // Center-crop the long edge before scaling, so a wide photo becomes the
    // middle square rather than a squashed one.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);

    // WebP encoding is not available in every WKWebView this ships to, and a
    // canvas that can't honour the type silently returns PNG — so verify the
    // prefix rather than trusting the request, and fall back to JPEG.
    const type = canvas
        .toDataURL('image/webp', 0.8)
        .startsWith('data:image/webp')
        ? 'image/webp'
        : 'image/jpeg';

    for (const quality of QUALITIES) {
        const url = canvas.toDataURL(type, quality);
        if (byteLength(url) <= MAX_BYTES) return url;
    }
    throw new AvatarError('That picture is too detailed. Try a simpler one.');
}

// byteLength measures the encoded string the way the server will, since the cap
// applies to the data: URI itself and not to the pixels behind it.
function byteLength(dataURL: string): number {
    return new TextEncoder().encode(dataURL).length;
}
