import * as crypto from 'node:crypto';

/**
 * Generate a cryptographically secure nonce for CSP.
 */
export function getNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Validates that a URL uses a safe protocol (http/https only).
 * Returns true if the URL is safe for use in href attributes.
 */
export function isSafeUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return /^https?:$/i.test(parsed.protocol);
    } catch {
        return false;
    }
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
