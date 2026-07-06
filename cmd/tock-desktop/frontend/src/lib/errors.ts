// Wails rejects a binding promise with the Go error's message as a plain
// string; normalize the other shapes so the form never shows "[object Object]".
export function authErrorText(err: unknown): string {
    if (typeof err === 'string' && err.trim()) return err;
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong. Try again.';
}
