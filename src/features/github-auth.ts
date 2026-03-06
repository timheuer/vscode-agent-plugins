import * as vscode from 'vscode';
import { getLogger } from './logger';

const GITHUB_AUTH_PROVIDER_ID = 'github';

// Scopes needed for private repo access
// repo scope includes full control of private repositories
const GITHUB_SCOPES = ['repo'];

let cachedSession: vscode.AuthenticationSession | undefined;

/**
 * Get a GitHub authentication session using VS Code's built-in auth provider.
 * This handles OAuth flow, token refresh, and SAML/SSO authentication automatically.
 * 
 * @param createIfNone If true, prompts user to sign in if no session exists
 * @returns The authentication session or undefined if not authenticated
 */
export async function getGitHubSession(createIfNone: boolean = false): Promise<vscode.AuthenticationSession | undefined> {
    try {
        const session = await vscode.authentication.getSession(
            GITHUB_AUTH_PROVIDER_ID,
            GITHUB_SCOPES,
            { createIfNone }
        );
        cachedSession = session;
        return session;
    } catch (error) {
        // User cancelled or auth failed
        getLogger()?.trace(`GitHub auth failed or cancelled: ${error instanceof Error ? error.message : String(error)}`);
        cachedSession = undefined;
        return undefined;
    }
}

/**
 * Get the current GitHub session without prompting for login.
 */
export async function getExistingGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    return getGitHubSession(false);
}

/**
 * Sign in to GitHub, prompting the user if necessary.
 */
export async function signInToGitHub(): Promise<vscode.AuthenticationSession | undefined> {
    return getGitHubSession(true);
}

/**
 * Clear the cached session (useful after sign out).
 */
export function clearCachedSession(): void {
    cachedSession = undefined;
}

/**
 * Check if user is currently signed in to GitHub.
 */
export async function isSignedInToGitHub(): Promise<boolean> {
    const session = await getExistingGitHubSession();
    return session !== undefined;
}

/**
 * Get authorization headers for GitHub API requests.
 * Returns headers with Bearer token if authenticated, otherwise empty headers.
 */
export async function getGitHubAuthHeaders(): Promise<Record<string, string>> {
    const session = await getExistingGitHubSession();
    if (session) {
        return {
            'Authorization': `Bearer ${session.accessToken}`
        };
    }
    getLogger()?.trace('No GitHub session available, making unauthenticated request');
    return {};
}

function mergeHeaders(
    authHeaders: Record<string, string>,
    requestHeaders?: RequestInit['headers']
): Headers {
    const headers = new Headers(requestHeaders);

    for (const [key, value] of Object.entries(authHeaders)) {
        if (!headers.has(key)) {
            headers.set(key, value);
        }
    }

    return headers;
}

function buildRequestInit(options: RequestInit, headers: Headers): RequestInit {
    return {
        ...options,
        headers
    };
}

async function getGitHubRateLimitReason(response: Response): Promise<string | undefined> {
    if (response.status !== 403 && response.status !== 429) {
        return undefined;
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
        return 'x-ratelimit-remaining=0';
    }

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        return `retry-after=${retryAfter}`;
    }

    try {
        const body = (await response.clone().text()).toLowerCase();
        if (body.includes('secondary rate limit')) {
            return 'secondary rate limit';
        }
        if (body.includes('rate limit')) {
            return 'rate limit';
        }
        if (body.includes('abuse detection')) {
            return 'abuse detection';
        }
    } catch {
        // Ignore unreadable response bodies when probing rate-limit details.
    }

    return undefined;
}

/**
 * Fetch with GitHub authentication if available.
 * Falls back to unauthenticated request if no session exists.
 */
export async function fetchWithGitHubAuth(
    url: string,
    options: RequestInit = {}
): Promise<Response> {
    const authHeaders = await getGitHubAuthHeaders();
    const headers = mergeHeaders(authHeaders, options.headers);
    const usedGitHubAuthHeader = Boolean(authHeaders.Authorization) && headers.get('authorization') === authHeaders.Authorization;
    const response = await fetch(url, buildRequestInit(options, headers));

    if (response.status !== 403 || !usedGitHubAuthHeader) {
        return response;
    }

    getLogger()?.trace(`GitHub request returned 403 with auth header, retrying without auth: ${url}`);
    const retryHeaders = new Headers(headers);
    retryHeaders.delete('authorization');

    const retryResponse = await fetch(url, buildRequestInit(options, retryHeaders));
    if (!retryResponse.ok) {
        const rateLimitReason = await getGitHubRateLimitReason(retryResponse);
        if (rateLimitReason) {
            getLogger()?.error(`GitHub request appears rate-limited after retrying without auth header (${rateLimitReason}): ${url}`);
        }
    }

    return retryResponse;
}

/**
 * Register authentication change listener.
 * Useful for refreshing data when user signs in/out.
 */
export function onDidChangeGitHubAuth(
    callback: (e: vscode.AuthenticationSessionsChangeEvent) => void
): vscode.Disposable {
    return vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === GITHUB_AUTH_PROVIDER_ID) {
            clearCachedSession();
            callback(e);
        }
    });
}
