import type { neonsync } from '../../wailsjs/go/models';

import { readInviteEmails } from './invite-emails';

// A member's best display label: the name they published, else the email you
// invited them with (local-only), else a short id. Pass a cached emails map to
// avoid re-reading localStorage per row.
export function memberLabel(
    m: neonsync.TeamMember,
    emails: Record<string, string> = readInviteEmails(),
): string {
    return m.DisplayName.trim() || emails[m.UserID] || `…${m.UserID.slice(-6)}`;
}
