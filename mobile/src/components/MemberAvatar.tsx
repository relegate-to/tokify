import { useState } from 'react';
import { Image, View } from 'react-native';

import { useColor } from '@/components/SummaryBits';
import { Text } from '@/components/ui/text';
import { projectColorVar } from '@/lib/colors';
import { cn } from '@/lib/utils';

// The desktop's MemberAvatar: a person's published picture over their first
// initial, tinted by the same hash as project colours so someone keeps one
// colour everywhere. The initial stays underneath, so a slow or broken picture
// degrades to it without a gap.
export function MemberAvatar({ seed, label, image, size = 32, stacked = false }: { seed: string; label: string; image?: string; size?: number; stacked?: boolean }) {
    const color = useColor()(projectColorVar(seed));
    const [failed, setFailed] = useState<string | null>(null);
    const src = image?.trim() && image.trim() !== failed ? image.trim() : '';
    return (
        <View
            className={cn('items-center justify-center overflow-hidden rounded-full border-2 border-card bg-card', stacked && '-ml-2.5')}
            style={{ width: size, height: size }}
            accessibilityLabel={label}
        >
            <View style={{ position: 'absolute', inset: 0, backgroundColor: color, opacity: 0.22 }} />
            <Text className="font-sans-semibold" style={{ color, fontSize: size * 0.36 }}>
                {label.trim()[0]?.toUpperCase() || '?'}
            </Text>
            {src ? (
                <Image source={{ uri: src }} onError={() => setFailed(src)} style={{ position: 'absolute', width: size, height: size }} />
            ) : null}
        </View>
    );
}
