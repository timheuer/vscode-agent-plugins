import * as vscode from 'vscode';
import { getLogger } from './logger';

interface CacheEntry<T> {
    data: T;
    timestamp: number;
    etag?: string;
}

interface CacheConfig {
    /** TTL in milliseconds for considering data fresh (default: 5 minutes) */
    freshTTL: number;
    /** TTL in milliseconds for considering data stale but usable (default: 1 hour) */
    staleTTL: number;
}

const DEFAULT_CONFIG: CacheConfig = {
    freshTTL: 5 * 60 * 1000,      // 5 minutes - data considered fresh
    staleTTL: 60 * 60 * 1000      // 1 hour - data is stale but still usable
};

/**
 * In-memory cache with TTL support and stale-while-revalidate pattern.
 * Uses VS Code's global state for persistence across sessions.
 */
export class MarketplaceCache {
    private memoryCache = new Map<string, CacheEntry<unknown>>();
    private pendingRefreshes = new Map<string, Promise<unknown>>();
    private config: CacheConfig;

    constructor(
        private readonly globalState: vscode.Memento,
        config?: Partial<CacheConfig>
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.loadFromStorage();
    }

    /**
     * Get cached data. Returns undefined if no cache exists.
     * Uses stale-while-revalidate: returns stale data immediately while refreshing in background.
     */
    get<T>(key: string): { data: T; isFresh: boolean } | undefined {
        const entry = this.memoryCache.get(key) as CacheEntry<T> | undefined;
        if (!entry) {
            return undefined;
        }

        const age = Date.now() - entry.timestamp;
        if (age > this.config.staleTTL) {
            // Data too old, remove it
            this.memoryCache.delete(key);
            this.persistToStorage();
            return undefined;
        }

        return {
            data: entry.data,
            isFresh: age <= this.config.freshTTL
        };
    }

    /**
     * Set cached data with current timestamp.
     */
    set<T>(key: string, data: T, etag?: string): void {
        this.memoryCache.set(key, {
            data,
            timestamp: Date.now(),
            etag
        });
        this.persistToStorage();
    }

    /**
     * Get data with automatic background refresh if stale.
     * Returns cached data immediately (if available) and triggers background refresh when stale.
     */
    async getWithRefresh<T>(
        key: string,
        fetcher: () => Promise<T>,
        options?: { forceRefresh?: boolean }
    ): Promise<{ data: T; fromCache: boolean; refreshing: boolean }> {
        const cached = this.get<T>(key);
        const forceRefresh = options?.forceRefresh ?? false;

        // No cache or force refresh - fetch synchronously
        if (!cached || forceRefresh) {
            try {
                const data = await this.fetchAndCache(key, fetcher);
                return { data, fromCache: false, refreshing: false };
            } catch (error) {
                // If fetch fails but we have stale cache, return it
                if (cached) {
                    getLogger()?.warn(`Fetch failed, returning stale cache for ${key}: ${error}`);
                    return { data: cached.data, fromCache: true, refreshing: false };
                }
                throw error;
            }
        }

        // Fresh cache - return immediately
        if (cached.isFresh) {
            return { data: cached.data, fromCache: true, refreshing: false };
        }

        // Stale cache - return immediately and refresh in background
        this.refreshInBackground(key, fetcher);
        return { data: cached.data, fromCache: true, refreshing: true };
    }

    /**
     * Trigger a background refresh without blocking.
     * Deduplicates concurrent refresh requests for the same key.
     */
    refreshInBackground<T>(key: string, fetcher: () => Promise<T>): void {
        if (this.pendingRefreshes.has(key)) {
            getLogger()?.trace(`Background refresh already in progress for ${key}`);
            return;
        }

        getLogger()?.trace(`Starting background refresh for ${key}`);
        const refreshPromise = this.fetchAndCache(key, fetcher)
            .then(() => {
                getLogger()?.trace(`Background refresh completed for ${key}`);
            })
            .catch((error) => {
                getLogger()?.warn(`Background refresh failed for ${key}: ${error}`);
            })
            .finally(() => {
                this.pendingRefreshes.delete(key);
            });

        this.pendingRefreshes.set(key, refreshPromise);
    }

    /**
     * Check if a background refresh is in progress for a key.
     */
    isRefreshing(key: string): boolean {
        return this.pendingRefreshes.has(key);
    }

    /**
     * Wait for any pending refresh to complete.
     */
    async waitForRefresh(key: string): Promise<void> {
        const pending = this.pendingRefreshes.get(key);
        if (pending) {
            await pending;
        }
    }

    /**
     * Clear a specific cache entry.
     */
    clear(key: string): void {
        this.memoryCache.delete(key);
        this.persistToStorage();
    }

    /**
     * Clear all cache entries.
     */
    clearAll(): void {
        this.memoryCache.clear();
        this.persistToStorage();
    }

    /**
     * Get cache statistics for debugging.
     */
    getStats(): { entries: number; keys: string[] } {
        return {
            entries: this.memoryCache.size,
            keys: Array.from(this.memoryCache.keys())
        };
    }

    private async fetchAndCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
        const data = await fetcher();
        this.set(key, data);
        return data;
    }

    private loadFromStorage(): void {
        try {
            const stored = this.globalState.get<Record<string, CacheEntry<unknown>>>('marketplaceCache');
            if (stored) {
                const now = Date.now();
                for (const [key, entry] of Object.entries(stored)) {
                    // Only load entries that aren't too stale
                    if (now - entry.timestamp <= this.config.staleTTL) {
                        this.memoryCache.set(key, entry);
                    }
                }
                getLogger()?.trace(`Loaded ${this.memoryCache.size} cache entries from storage`);
            }
        } catch (error) {
            getLogger()?.warn(`Failed to load cache from storage: ${error}`);
        }
    }

    private persistToStorage(): void {
        try {
            const data: Record<string, CacheEntry<unknown>> = {};
            for (const [key, entry] of this.memoryCache.entries()) {
                data[key] = entry;
            }
            // Fire and forget - don't await to avoid blocking
            void this.globalState.update('marketplaceCache', data);
        } catch (error) {
            getLogger()?.warn(`Failed to persist cache to storage: ${error}`);
        }
    }
}

// Singleton instance - initialized when extension activates
let cacheInstance: MarketplaceCache | undefined;

export function initializeCache(globalState: vscode.Memento, config?: Partial<CacheConfig>): MarketplaceCache {
    cacheInstance = new MarketplaceCache(globalState, config);
    return cacheInstance;
}

export function getCache(): MarketplaceCache | undefined {
    return cacheInstance;
}

/**
 * Cache key generators for different data types.
 */
export const CacheKeys = {
    marketplace: (url: string) => `marketplace:${url}`,
    allMarketplaces: (urls: string[]) => `marketplaces:${urls.sort().join('|')}`,
    repoDirectory: (owner: string, repo: string, branch: string, path: string) =>
        `dir:${owner}/${repo}/${branch}:${path}`,
    pluginConfig: (owner: string, repo: string, branch: string, source: string) =>
        `config:${owner}/${repo}/${branch}:${source}`
};
