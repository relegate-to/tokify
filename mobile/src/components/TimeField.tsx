import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect } from 'react';
import { Platform, Pressable } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const pad = (n: number) => String(n).padStart(2, '0');

function clockDate(hhmm: string) {
    const d = new Date();
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (m) d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
}

function dayDate(ymd: string) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

// The system's own pickers in place of typed times: Android's clock dialog
// opened from a field that looks like an Input, iOS's compact picker inline.
function PickerField({
    mode,
    value,
    label,
    placeholder,
    date,
    onPick,
    className,
    openOnMount = false,
}: {
    openOnMount?: boolean;
    mode: 'time' | 'date';
    value: string;
    label: string;
    placeholder: string;
    date: Date;
    onPick: (d: Date) => void;
    className?: string;
}) {
    const max = mode === 'date' ? new Date() : undefined;
    const onChange = (event: DateTimePickerEvent, picked?: Date) => {
        if (event.type === 'set' && picked) onPick(picked);
    };
    const open = () => DateTimePickerAndroid.open({ mode, value: date, is24Hour: true, maximumDate: max, onChange });
    useEffect(() => {
        if (openOnMount && Platform.OS === 'android') open();
        // Only as the field first appears.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    if (Platform.OS === 'ios') {
        return <DateTimePicker mode={mode} display="compact" value={date} maximumDate={max} onChange={onChange} accessibilityLabel={label} />;
    }
    return (
        <Pressable
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={label}
            className={cn('h-12 justify-center rounded-lg border border-input bg-card px-3.5 active:bg-muted', className)}
        >
            <Text className={cn('font-mono text-base', !value && 'text-muted-foreground')}>{value || placeholder}</Text>
        </Pressable>
    );
}

// HH:MM.
export function TimeField({
    value,
    onChange,
    label,
    className,
    openOnMount,
}: {
    value: string;
    onChange: (hhmm: string) => void;
    label: string;
    className?: string;
    openOnMount?: boolean;
}) {
    return (
        <PickerField
            mode="time"
            value={value}
            label={label}
            placeholder="--:--"
            date={clockDate(value)}
            onPick={(d) => onChange(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}
            className={className}
            openOnMount={openOnMount}
        />
    );
}

// YYYY-MM-DD, shown as a readable day.
export function DateField({ value, onChange, label }: { value: string; onChange: (ymd: string) => void; label: string }) {
    const date = dayDate(value);
    const shown = value ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return (
        <PickerField
            mode="date"
            value={shown}
            label={label}
            placeholder="Pick a day"
            date={date}
            onPick={(d) => onChange(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)}
        />
    );
}
