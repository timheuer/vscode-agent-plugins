import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { MarketplaceGroupItem, MarketplacePlugin } from './marketplace';

export type InstallScope = 'workspace' | 'user';

export interface InstallPayload {
    version: 'v1';
    operation: 'installOrUpdate';
    scope: InstallScope;
    targetPath: string;
    requestedAt: string;
    plugins: Array<{
        id: string;
        name: string;
        version?: string;
        sourceUrl: string;
        downloadUrl?: string;
    }>;
    marketplaceUrls: string[];
}

export interface OperationResult {
    success: boolean;
    error?: string;
}

interface InstalledPathCollection {
    skillPaths: string[];
    agentPaths: string[];
}

interface RepoContext {
    owner: string;
    repo: string;
    branch: string;
    rawBaseUrl: string;
}

interface GitHubContentEntry {
    type?: string;
    name?: string;
    path?: string;
}

function sanitizePathSegment(value: string): string {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return sanitized.length > 0 ? sanitized : 'unknown';
}

function getMarketplaceName(sourceUrl: string): string {
    try {
        const parsed = new URL(sourceUrl);
        if (parsed.hostname.includes('github.com')) {
            const segments = parsed.pathname.split('/').filter(Boolean);
            if (segments.length >= 2) {
                return sanitizePathSegment(segments[1].replace(/\.git$/i, ''));
            }
        }

        const segments = parsed.pathname.split('/').filter(Boolean).reverse();
        for (const segment of segments) {
            if (segment.toLowerCase() !== 'marketplace.json') {
                return sanitizePathSegment(segment.replace(/\.json$/i, ''));
            }
        }
    } catch {
        return sanitizePathSegment(sourceUrl);
    }

    return 'marketplace';
}

function getPluginName(plugin: MarketplacePlugin): string {
    return sanitizePathSegment(plugin.name || plugin.id);
}

function normalizeRelativePath(value: string): string {
    return value.replace(/^\.\//, '').replace(/^\//, '').replace(/\/+$/, '');
}

function encodePath(value: string): string {
    return value
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function getRepoContext(plugin: MarketplacePlugin): RepoContext | undefined {
    const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//i.exec(
        plugin.marketplaceDocumentUrl
    );
    if (!match) {
        return undefined;
    }

    const owner = match[1];
    const repo = match[2];
    const branch = match[3];
    return {
        owner,
        repo,
        branch,
        rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`
    };
}

async function fetchGitHubPathContents(repoContext: RepoContext, relativePath: string): Promise<unknown | undefined> {
    const encoded = encodePath(relativePath);
    const url = `https://api.github.com/repos/${repoContext.owner}/${repoContext.repo}/contents/${encoded}?ref=${encodeURIComponent(repoContext.branch)}`;

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'vscode-agent-plugins',
                'Accept': 'application/vnd.github+json'
            }
        });
        if (!response.ok) {
            return undefined;
        }

        return (await response.json()) as unknown;
    } catch {
        return undefined;
    }
}

async function downloadRawFile(rawUrl: string, targetPath: string, logger?: { warn: (msg: string) => void }): Promise<boolean> {
    try {
        const response = await fetch(rawUrl);
        if (!response.ok) {
            logger?.warn(`Failed to download ${rawUrl}: ${response.status} ${response.statusText}`);
            return false;
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, bytes);
        return true;
    } catch (error) {
        logger?.warn(`Failed to download ${rawUrl}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

async function fetchRawText(rawUrl: string): Promise<string | undefined> {
    try {
        const response = await fetch(rawUrl);
        if (!response.ok) {
            return undefined;
        }
        return await response.text();
    } catch {
        return undefined;
    }
}

async function copyGithubEntryTree(repoContext: RepoContext, sourcePath: string, targetPath: string): Promise<boolean> {
    const contents = await fetchGitHubPathContents(repoContext, sourcePath);
    if (!contents) {
        return false;
    }

    if (Array.isArray(contents)) {
        let copied = false;
        for (const entry of contents) {
            const record = entry as GitHubContentEntry;
            if (!record.type || !record.path || !record.name) {
                continue;
            }

            if (record.type === 'dir') {
                const childCopied = await copyGithubEntryTree(repoContext, record.path, path.join(targetPath, record.name));
                copied = copied || childCopied;
                continue;
            }

            if (record.type === 'file') {
                const rawUrl = `${repoContext.rawBaseUrl}/${record.path}`;
                const fileCopied = await downloadRawFile(rawUrl, path.join(targetPath, record.name));
                copied = copied || fileCopied;
            }
        }
        return copied;
    }

    const record = contents as GitHubContentEntry;
    if (record.type === 'file' && record.path) {
        const rawUrl = `${repoContext.rawBaseUrl}/${record.path}`;
        const fileName = path.basename(record.path);
        return downloadRawFile(rawUrl, path.join(targetPath, fileName));
    }

    if (record.type === 'dir' && record.path) {
        return copyGithubEntryTree(repoContext, record.path, targetPath);
    }

    return false;
}

async function fallbackDownloadItemDescriptor(item: MarketplaceGroupItem, targetPath: string): Promise<boolean> {
    const candidates = [item.metadataUrl, ...item.metadataFallbackUrls].filter((entry): entry is string => Boolean(entry));
    for (const candidate of candidates) {
        const fileName = path.basename(new URL(candidate).pathname) || 'descriptor.md';
        if (await downloadRawFile(candidate, path.join(targetPath, fileName))) {
            return true;
        }
    }

    return false;
}

async function installSkillItem(plugin: MarketplacePlugin, item: MarketplaceGroupItem, skillsRoot: string): Promise<void> {
    const skillFolder = path.join(skillsRoot, sanitizePathSegment(item.name));
    await fs.mkdir(skillFolder, { recursive: true });

    const repoContext = getRepoContext(plugin);
    const sourcePath = item.path ? normalizeRelativePath(item.path) : undefined;
    if (repoContext && sourcePath) {
        const copied = await copyGithubEntryTree(repoContext, sourcePath, skillFolder);
        if (copied) {
            return;
        }
    }

    await fallbackDownloadItemDescriptor(item, skillFolder);
}

async function getAgentText(plugin: MarketplacePlugin, item: MarketplaceGroupItem): Promise<string | undefined> {
    const repoContext = getRepoContext(plugin);
    const sourcePath = item.path ? normalizeRelativePath(item.path) : undefined;

    if (repoContext && sourcePath) {
        const contents = await fetchGitHubPathContents(repoContext, sourcePath);
        if (contents && !Array.isArray(contents)) {
            const record = contents as GitHubContentEntry;
            if (record.type === 'file' && record.path) {
                const text = await fetchRawText(`${repoContext.rawBaseUrl}/${record.path}`);
                if (text) {
                    return text;
                }
            }
        }

        if (Array.isArray(contents)) {
            const entries = contents as GitHubContentEntry[];
            const preferred = ['AGENT.md', 'AGENTS.md', 'README.md'];
            for (const fileName of preferred) {
                const match = entries.find((entry) => entry.type === 'file' && entry.name?.toLowerCase() === fileName.toLowerCase());
                if (match?.path) {
                    const text = await fetchRawText(`${repoContext.rawBaseUrl}/${match.path}`);
                    if (text) {
                        return text;
                    }
                }
            }

            const anyMarkdown = entries.find((entry) => entry.type === 'file' && entry.path && /\.md$/i.test(entry.path));
            if (anyMarkdown?.path) {
                const text = await fetchRawText(`${repoContext.rawBaseUrl}/${anyMarkdown.path}`);
                if (text) {
                    return text;
                }
            }
        }
    }

    const descriptorCandidates = [item.metadataUrl, ...item.metadataFallbackUrls].filter((entry): entry is string => Boolean(entry));
    for (const candidate of descriptorCandidates) {
        const text = await fetchRawText(candidate);
        if (text) {
            return text;
        }
    }

    if (item.description) {
        return `# ${item.name}\n\n${item.description}\n`;
    }

    return undefined;
}

async function installAgentItem(plugin: MarketplacePlugin, item: MarketplaceGroupItem, agentsRoot: string): Promise<void> {
    await fs.mkdir(agentsRoot, { recursive: true });
    const fileBase = sanitizePathSegment(item.name.replace(/\.agent\.md$/i, '').replace(/\.md$/i, ''));
    const filePath = path.join(agentsRoot, `${fileBase}.agent.md`);

    const content = await getAgentText(plugin, item);
    if (!content) {
        return;
    }

    await fs.writeFile(filePath, content, 'utf8');
}

async function materializeLocalInstallStructure(workspaceRoot: string, plugins: MarketplacePlugin[]): Promise<void> {
    const skillsRoot = path.join(workspaceRoot, '.agents', 'skills');
    const agentsRoot = path.join(workspaceRoot, '.github', 'agents');

    const installPromises: Promise<void>[] = [];

    for (const plugin of plugins) {
        for (const group of plugin.groups) {
            if (group.key === 'skills') {
                for (const item of group.items) {
                    installPromises.push(installSkillItem(plugin, item, skillsRoot));
                }
            }

            if (group.key === 'agents') {
                for (const item of group.items) {
                    installPromises.push(installAgentItem(plugin, item, agentsRoot));
                }
            }
        }
    }

    await Promise.all(installPromises);
}

async function materializeUserInstallStructure(userRoot: string, plugins: MarketplacePlugin[]): Promise<InstalledPathCollection> {
    const skillPaths = new Set<string>();
    const agentPaths = new Set<string>();

    const installPromises: Promise<void>[] = [];

    for (const plugin of plugins) {
        const pluginRoot = path.join(userRoot, getMarketplaceName(plugin.sourceUrl), getPluginName(plugin));
        const skillsRoot = path.join(pluginRoot, 'skills');
        const agentsRoot = path.join(pluginRoot, 'agents');

        for (const group of plugin.groups) {
            if (group.key === 'skills') {
                for (const item of group.items) {
                    installPromises.push(installSkillItem(plugin, item, skillsRoot));
                }
                if (group.items.length > 0) {
                    skillPaths.add(skillsRoot);
                }
            }

            if (group.key === 'agents') {
                for (const item of group.items) {
                    installPromises.push(installAgentItem(plugin, item, agentsRoot));
                }
                if (group.items.length > 0) {
                    agentPaths.add(agentsRoot);
                }
            }
        }
    }

    await Promise.all(installPromises);

    return {
        skillPaths: Array.from(skillPaths),
        agentPaths: Array.from(agentPaths)
    };
}

function toTildePath(absolutePath: string): string {
    const home = os.homedir();
    if (absolutePath.startsWith(home)) {
        return '~' + absolutePath.slice(home.length).replace(/\\/g, '/');
    }
    return absolutePath.replace(/\\/g, '/');
}

function getWorkspaceSettingObject(key: string): Record<string, boolean> {
    const inspection = vscode.workspace.getConfiguration().inspect<Record<string, boolean>>(key);
    const workspaceValue = inspection?.workspaceValue;
    return workspaceValue && typeof workspaceValue === 'object' && !Array.isArray(workspaceValue)
        ? workspaceValue
        : {};
}

async function updateWorkspaceChatFileSettings(paths: InstalledPathCollection): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        return;
    }

    const existingSkills = getWorkspaceSettingObject('chat.agentSkillsLocations');
    const existingAgents = getWorkspaceSettingObject('chat.agentFilesLocations');

    const mergedSkills: Record<string, boolean> = { ...existingSkills };
    for (const skillPath of paths.skillPaths) {
        mergedSkills[toTildePath(skillPath)] = true;
    }

    const mergedAgents: Record<string, boolean> = { ...existingAgents };
    for (const agentPath of paths.agentPaths) {
        mergedAgents[toTildePath(agentPath)] = true;
    }

    await vscode.workspace
        .getConfiguration()
        .update('chat.agentSkillsLocations', mergedSkills, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace
        .getConfiguration()
        .update('chat.agentFilesLocations', mergedAgents, vscode.ConfigurationTarget.Workspace);
}


export function resolveAgentsPath(scope: InstallScope): string | undefined {
    if (scope === 'user') {
        return path.join(os.homedir(), '.copilot', 'installed-plugins');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return undefined;
    }

    return workspaceFolder.uri.fsPath;
}

export function buildInstallPayload(
    plugins: MarketplacePlugin[],
    scope: InstallScope,
    targetPath: string,
    marketplaceUrls: string[]
): InstallPayload {
    return {
        version: 'v1',
        operation: 'installOrUpdate',
        scope,
        targetPath,
        requestedAt: new Date().toISOString(),
        plugins: plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            sourceUrl: plugin.sourceUrl,
            downloadUrl: plugin.downloadUrl
        })),
        marketplaceUrls
    };
}

export async function persistLastOperation(
    context: vscode.ExtensionContext,
    payload: InstallPayload,
    result: OperationResult
): Promise<void> {
    const key = payload.scope === 'workspace' ? 'lastOperation.workspace' : 'lastOperation.user';
    const store = payload.scope === 'workspace' ? context.workspaceState : context.globalState;
    await store.update(key, {
        timestamp: new Date().toISOString(),
        scope: payload.scope,
        targetPath: payload.targetPath,
        pluginCount: payload.plugins.length,
        success: result.success,
        error: result.error
    });
}

export async function executeInstall(
    context: vscode.ExtensionContext,
    plugins: MarketplacePlugin[],
    payload: InstallPayload
): Promise<OperationResult> {
    try {
        if (payload.scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
            return { success: false, error: 'Open a workspace folder to install local skills and agents.' };
        }

        if (payload.scope === 'workspace') {
            await materializeLocalInstallStructure(payload.targetPath, plugins);
        } else {
            const installedPaths = await materializeUserInstallStructure(payload.targetPath, plugins);
            await updateWorkspaceChatFileSettings(installedPaths);
        }

        await persistLastOperation(context, payload, { success: true });
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await persistLastOperation(context, payload, { success: false, error: message });
        return { success: false, error: message };
    }
}
