import { useEffect, useState } from 'react';
import {
    ArrowLeft,
    ArrowUpCircle,
    CircleCheck,
    Copy,
    ExternalLink,
    MessageSquareWarning,
    RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    AgentSetup,
    AppVersion,
    CheckForUpdate,
} from '../../wailsjs/go/main/App';
import {
    BrowserOpenURL,
    ClipboardSetText,
} from '../../wailsjs/runtime/runtime';
import { main, mcpserver } from '../../wailsjs/go/models';

import type { ActivityView, Theme } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function SettingsView({
    showAccount,
    onShowAccountChange,
    activityView,
    onActivityViewChange,
    dailyGoal,
    onDailyGoalChange,
    showScrollbars,
    onShowScrollbarsChange,
    theme,
    onThemeChange,
    onBack,
}: {
    showAccount: boolean;
    onShowAccountChange: (v: boolean) => void;
    activityView: ActivityView;
    onActivityViewChange: (v: ActivityView) => void;
    dailyGoal: number;
    onDailyGoalChange: (v: number) => void;
    showScrollbars: boolean;
    onShowScrollbarsChange: (v: boolean) => void;
    theme: Theme;
    onThemeChange: (v: Theme) => void;
    onBack: () => void;
}) {
    return (
        <div
            className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-top-1 duration-300"
        >
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onBack}
                    title="Back"
                >
                    <ArrowLeft />
                </Button>
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Settings
                </h2>
            </div>
            <div className="flex flex-col divide-y rounded-xl border bg-card shadow-sm">
                <SettingSegmentedRow
                    title="Theme"
                    description="Auto follows your system appearance."
                    value={theme}
                    onChange={onThemeChange}
                    options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                    ]}
                />
                <SettingSegmentedRow
                    title="Show activity"
                    description="What appears under the timer on the Now page: today's goal progress plus recent tasks, just today's progress, or nothing."
                    value={activityView}
                    onChange={onActivityViewChange}
                    options={[
                        { value: 'all', label: 'All' },
                        { value: 'today', label: 'Today only' },
                        { value: 'none', label: 'Hidden' },
                    ]}
                />
                <SettingSegmentedRow
                    title="Daily goal"
                    description="Target tracked time per day, shown as progress on the Now page."
                    value={String(dailyGoal)}
                    onChange={(v) => onDailyGoalChange(Number(v))}
                    options={[
                        { value: '240', label: '4h' },
                        { value: '360', label: '6h' },
                        { value: '480', label: '8h' },
                    ]}
                />
                <SettingRow
                    title="Show scrollbars"
                    description="Hidden by default for a cleaner look. Scrolling still works."
                    value={showScrollbars}
                    onChange={onShowScrollbarsChange}
                />
                <SettingRow
                    title="Show account in menu"
                    description="Reveals the Account item in the date menu."
                    value={showAccount}
                    onChange={onShowAccountChange}
                />
            </div>

            <div className="flex flex-col gap-3">
                <h3 className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    AI agents
                </h3>
                <AgentSetupCard />
            </div>

            <div className="flex flex-col gap-3">
                <h3 className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    About
                </h3>
                <div className="flex flex-col divide-y rounded-xl border bg-card shadow-sm">
                    <UpdateRow />
                    <ReportIssueRow />
                </div>
            </div>
        </div>
    );
}

type AgentClient = 'claude' | 'json';

function AgentSetupCard() {
    const [setup, setSetup] = useState<mcpserver.Setup | null>(null);
    const [client, setClient] = useState<AgentClient>('claude');

    useEffect(() => {
        AgentSetup()
            .then(setSetup)
            .catch(() => {});
    }, []);

    const snippet =
        client === 'claude' ? setup?.claude_command : setup?.json_config;

    const copy = async () => {
        if (!snippet) return;
        const ok = await ClipboardSetText(snippet).catch(() => false);
        if (ok) {
            toast.success(
                client === 'claude' ? 'Command copied' : 'Config copied',
            );
        } else {
            toast.error('Could not copy to clipboard');
        }
    };

    return (
        <div className="flex flex-col divide-y rounded-xl border bg-card shadow-sm">
            <SettingSegmentedRow
                title="Connect an AI agent"
                description="Lets an assistant like Claude read your hours, fill in gaps, and fix entries."
                value={client}
                onChange={setClient}
                options={[
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'json', label: 'Other apps' },
                ]}
            />
            <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start gap-2">
                    <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground select-text">
                        {snippet ?? 'Loading…'}
                    </pre>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={copy}
                        disabled={!snippet}
                    >
                        <Copy className="size-3.5" />
                        Copy
                    </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                    {client === 'claude'
                        ? 'Run this in Terminal, then ask Claude to fill in your hours.'
                        : "Add this to your app's MCP servers config, then restart it."}
                </span>
            </div>
        </div>
    );
}

const ISSUES_URL = 'https://github.com/relegate-to/tokify/issues';

function UpdateRow() {
    const [current, setCurrent] = useState('');
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<main.UpdateInfo | null>(null);

    useEffect(() => {
        AppVersion()
            .then(setCurrent)
            .catch(() => {});
    }, []);

    const check = () => {
        setChecking(true);
        CheckForUpdate()
            .then((info) => {
                setResult(info);
                if (!info.update_available) {
                    toast.success("You're on the latest version");
                }
            })
            .catch((e) => toast.error(String(e)))
            .finally(() => setChecking(false));
    };

    const updateAvailable = !!result?.update_available;
    const checkedOnce = result !== null;

    let status: string;
    if (updateAvailable) {
        status = `Version ${result?.latest_version} is available`;
    } else if (checkedOnce) {
        status = "You're on the latest version";
    } else {
        status = current ? `Tokify ${current}` : 'Tokify';
    }

    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-sm">
                    Updates
                    {updateAvailable && (
                        <ArrowUpCircle className="size-3.5 text-emerald-500" />
                    )}
                    {checkedOnce && !updateAvailable && (
                        <CircleCheck className="size-3.5 text-emerald-500" />
                    )}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                    {status}
                </span>
            </div>
            {updateAvailable ? (
                <Button size="sm" onClick={() => BrowserOpenURL(result!.release_url)}>
                    Download
                    <ExternalLink className="size-3.5" />
                </Button>
            ) : (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={check}
                    disabled={checking}
                >
                    <RefreshCw
                        className={cn('size-3.5', checking && 'animate-spin')}
                    />
                    {checking ? 'Checking…' : 'Check for updates'}
                </Button>
            )}
        </div>
    );
}

function ReportIssueRow() {
    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">Report an issue</span>
                <span className="text-xs text-muted-foreground">
                    Opens the Tokify issue tracker on GitHub.
                </span>
            </div>
            <Button
                variant="outline"
                size="sm"
                onClick={() => BrowserOpenURL(ISSUES_URL)}
            >
                <MessageSquareWarning className="size-3.5" />
                Report
            </Button>
        </div>
    );
}

function SettingSegmentedRow<T extends string>({
    title,
    description,
    value,
    onChange,
    options,
}: {
    title: string;
    description?: string;
    value: T;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
}) {
    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">{title}</span>
                {description && (
                    <span className="text-xs text-muted-foreground">
                        {description}
                    </span>
                )}
            </div>
            <div className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5">
                {options.map((opt) => {
                    const active = opt.value === value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => onChange(opt.value)}
                            className={cn(
                                'rounded px-2.5 py-1 text-xs transition-colors',
                                active
                                    ? 'bg-background text-foreground shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {opt.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function SettingRow({
    title,
    description,
    value,
    onChange,
}: {
    title: string;
    description?: string;
    value: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">{title}</span>
                {description && (
                    <span className="text-xs text-muted-foreground">
                        {description}
                    </span>
                )}
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={value}
                onClick={() => onChange(!value)}
                className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                    value ? 'bg-foreground' : 'bg-muted',
                )}
            >
                <span
                    className={cn(
                        'inline-block size-4 rounded-full bg-background shadow transition-transform',
                        value ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
                    )}
                />
            </button>
        </div>
    );
}
