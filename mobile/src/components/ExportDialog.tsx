import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Check, Download } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Segmented } from '@/components/SummaryBits';
import { DateField } from '@/components/TimeField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { projectColorClass } from '@/lib/colors';
import { useEntries } from '@/lib/entries';
import { renderExport, selectForExport, type ExportFormat } from '@/lib/export';
import { useShared } from '@/lib/shared';
import { cn } from '@/lib/utils';

type Range = 'all' | 'today' | 'yesterday' | 'custom';

const MIME: Record<ExportFormat, string> = { txt: 'text/plain', csv: 'text/csv', json: 'application/json' };
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The desktop's ExportDialog. On a phone the file goes to the share sheet, so
// it can be saved to Files, mailed or sent on from there.
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { entries } = useEntries();
    const { shared } = useShared();
    const [format, setFormat] = useState<ExportFormat>('txt');
    const [range, setRange] = useState<Range>('all');
    const [from, setFrom] = useState(ymd(new Date()));
    const [to, setTo] = useState(ymd(new Date()));
    const [project, setProject] = useState('');
    const [includeShared, setIncludeShared] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const projects = useMemo(() => [...new Set((entries ?? []).map((e) => e.project).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [entries]);

    const bounds = () => {
        const today = new Date();
        if (range === 'today') return { from: ymd(today), to: ymd(today) };
        if (range === 'yesterday') {
            const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
            return { from: ymd(y), to: ymd(y) };
        }
        if (range === 'custom') return { from, to };
        return {};
    };

    const exportNow = async () => {
        if (!entries || busy) return;
        const b = bounds();
        if (b.from && b.to && b.from > b.to) return setError('The start day must not be after the end day.');
        setBusy(true);
        setError('');
        try {
            const pool = includeShared ? [...entries, ...shared] : entries;
            const text = renderExport(format, selectForExport(pool, { ...b, project }));
            const now = new Date();
            const stamp = `${ymd(now).replace(/-/g, '')}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const file = new File(Paths.cache, `tokify-report-${stamp}.${format}`);
            file.write(text);
            await Sharing.shareAsync(file.uri, { mimeType: MIME[format], dialogTitle: 'Export Tokify activities' });
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="w-[92vw] max-w-md">
                <DialogHeader>
                    <DialogTitle>Export activities</DialogTitle>
                    <DialogDescription>Save your history as a report, a spreadsheet or JSON.</DialogDescription>
                </DialogHeader>
                <View className="gap-4">
                    <Field label="Format">
                        <Segmented<ExportFormat>
                            options={[
                                { value: 'txt', label: 'Text' },
                                { value: 'csv', label: 'CSV' },
                                { value: 'json', label: 'JSON' },
                            ]}
                            value={format}
                            onChange={setFormat}
                        />
                    </Field>
                    <Field label="Range">
                        <Segmented<Range>
                            options={[
                                { value: 'all', label: 'All time' },
                                { value: 'today', label: 'Today' },
                                { value: 'yesterday', label: 'Yesterday' },
                                { value: 'custom', label: 'Range' },
                            ]}
                            value={range}
                            onChange={setRange}
                        />
                        {range === 'custom' ? (
                            <View className="flex-row gap-2 pt-1">
                                <View className="flex-1">
                                    <DateField label="From" value={from} onChange={setFrom} />
                                </View>
                                <View className="flex-1">
                                    <DateField label="To" value={to} onChange={setTo} />
                                </View>
                            </View>
                        ) : null}
                    </Field>
                    <Field label="Project">
                        <DropdownMenu>
                            <DropdownMenuTrigger className="h-12 flex-row items-center gap-2 rounded-lg border border-input bg-card px-3.5">
                                {project ? <View className={cn('size-2 rounded-[2px]', projectColorClass(project))} /> : null}
                                <Text className={cn('text-base', !project && 'text-muted-foreground')}>{project || 'All projects'}</Text>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-56">
                                {['', ...projects].map((p) => (
                                    <DropdownMenuItem key={p || '\0all'} onPress={() => setProject(p)}>
                                        {p ? <View className={cn('size-[7px] rounded-[2px]', projectColorClass(p))} /> : null}
                                        <Text className={cn(p === project && 'font-sans-semibold')}>{p || 'All projects'}</Text>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </Field>
                    {shared.length > 0 ? (
                        <Pressable onPress={() => setIncludeShared((v) => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: includeShared }} className="flex-row items-center gap-2.5 py-1">
                            <View className={cn('size-[18px] items-center justify-center rounded-[4px] border', includeShared ? 'border-foreground bg-foreground' : 'border-ring')}>
                                {includeShared ? <Icon as={Check} className="size-3 text-background" /> : null}
                            </View>
                            <Text className="text-sm text-muted-foreground">Include what teammates share with you</Text>
                        </Pressable>
                    ) : null}
                    {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
                </View>
                <DialogFooter>
                    <Button variant="ghost" onPress={onClose} disabled={busy}>
                        <Text>Cancel</Text>
                    </Button>
                    <Button onPress={exportNow} disabled={busy || !entries}>
                        {busy ? <ActivityIndicator size="small" color="white" /> : <Icon as={Download} className="size-4 text-primary-foreground" />}
                        <Text>Export</Text>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <View className="gap-1.5">
            <Text className="text-[13px] text-muted-foreground">{label}</Text>
            {children}
        </View>
    );
}
