// Invite emails are a local, display-only convenience: the address you invited
// someone with, keyed by their user id. It never leaves this device (the server
// only ever knows an email hash) and exists to label a person — a pending
// invitee, or the author of a shared entry — with the address you actually used.
const INVITE_EMAILS_KEY = 'tokify.inviteEmails';

export function readInviteEmails(): Record<string, string> {
    try {
        return JSON.parse(localStorage.getItem(INVITE_EMAILS_KEY) || '{}');
    } catch {
        return {};
    }
}

export function rememberInviteEmail(userID: string, email: string) {
    try {
        const map = readInviteEmails();
        map[userID] = email;
        localStorage.setItem(INVITE_EMAILS_KEY, JSON.stringify(map));
    } catch {
        // ignore
    }
}
