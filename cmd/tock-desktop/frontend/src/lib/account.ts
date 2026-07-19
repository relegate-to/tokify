// Derives the two-letter avatar initials and a display name from an account's
// name/email. Shared by the masthead pill and the Account view so they stay
// consistent.

export function accountInitials(name?: string, email?: string): string {
    const source = (name ?? '').trim() || (email ?? '').trim();
    if (!source) return 'YOU';
    const parts = source
        .replace(/@.*$/, '')
        .split(/[\s._-]+/)
        .filter(Boolean);
    if (parts.length === 0) return source.slice(0, 2).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function accountDisplayName(name?: string, email?: string): string {
    const n = (name ?? '').trim();
    if (n) return n;
    const e = (email ?? '').trim();
    if (e) return e.replace(/@.*$/, '');
    return 'Account';
}
