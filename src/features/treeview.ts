import * as vscode from 'vscode';
import type { ExtensionServices } from '../extension';
import {
    fetchAllMarketplaces,
    MarketplacePlugin,
    MarketplacePluginGroup,
    MarketplaceGroupItem
} from './marketplace';
import { getMarketplaceUrls } from './config';

export { MarketplacePlugin };

export interface MarketplaceNode {
    type: 'marketplace';
    url: string;
    plugins: MarketplacePlugin[];
}

interface PluginNode {
    type: 'plugin';
    plugin: MarketplacePlugin;
}

interface GroupNode {
    type: 'group';
    plugin: MarketplacePlugin;
    group: MarketplacePluginGroup;
}

export interface ItemNode {
    type: 'item';
    plugin: MarketplacePlugin;
    group: MarketplacePluginGroup;
    item: MarketplaceGroupItem;
}

export interface PluginNodeExport {
    type: 'plugin';
    plugin: MarketplacePlugin;
}

type TreeNode = MarketplaceNode | PluginNode | GroupNode | ItemNode;

const groupIconMap: Record<string, string> = {
    skills: 'tools',
    agents: 'account',
    commands: 'terminal-cmd',
    tools: 'wrench',
    prompts: 'comment-discussion',
    workflows: 'git-merge'
};

export class MarketplaceTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _marketplaces: MarketplaceNode[] = [];
    private _loading = false;

    constructor(private readonly services: ExtensionServices) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    async loadData(): Promise<void> {
        if (this._loading) {
            return;
        }

        this._loading = true;
        try {
            await vscode.window.withProgress(
                { location: { viewId: 'vscode-agent-plugins.marketplaceExplorer' } },
                async () => {
                    const urls = getMarketplaceUrls();
                    if (urls.length === 0) {
                        this._marketplaces = [];
                        this._onDidChangeTreeData.fire();
                        return;
                    }

                    const result = await fetchAllMarketplaces(urls);

                    const marketplaceMap = new Map<string, MarketplacePlugin[]>();
                    for (const plugin of result.plugins) {
                        const existing = marketplaceMap.get(plugin.sourceUrl) ?? [];
                        existing.push(plugin);
                        marketplaceMap.set(plugin.sourceUrl, existing);
                    }

                    this._marketplaces = urls.map((url) => ({
                        type: 'marketplace' as const,
                        url,
                        plugins: marketplaceMap.get(url) ?? []
                    }));

                    this.services.logger.info(`Tree view loaded ${result.plugins.length} plugin(s) from ${urls.length} marketplace(s).`);
                    this._onDidChangeTreeData.fire();
                }
            );
        } finally {
            this._loading = false;
        }
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        switch (element.type) {
            case 'marketplace':
                return this.createMarketplaceItem(element);
            case 'plugin':
                return this.createPluginItem(element);
            case 'group':
                return this.createGroupItem(element);
            case 'item':
                return this.createItemItem(element);
        }
    }

    getChildren(element?: TreeNode): TreeNode[] | Thenable<TreeNode[]> {
        if (!element) {
            if (this._marketplaces.length === 0) {
                this.loadData().catch((err) => {
                    this.services.logger.error(`Failed to load marketplace data: ${err}`);
                });
                return [];
            }
            return this._marketplaces;
        }

        switch (element.type) {
            case 'marketplace':
                return element.plugins.map((plugin) => ({
                    type: 'plugin' as const,
                    plugin
                }));
            case 'plugin':
                return element.plugin.groups.map((group) => ({
                    type: 'group' as const,
                    plugin: element.plugin,
                    group
                }));
            case 'group':
                return element.group.items.map((item) => ({
                    type: 'item' as const,
                    plugin: element.plugin,
                    group: element.group,
                    item
                }));
            case 'item':
                return [];
        }
    }

    getParent(element: TreeNode): TreeNode | undefined {
        switch (element.type) {
            case 'marketplace':
                return undefined;
            case 'plugin':
                return this._marketplaces.find((m) => m.url === element.plugin.sourceUrl);
            case 'group':
                return { type: 'plugin', plugin: element.plugin };
            case 'item':
                return { type: 'group', plugin: element.plugin, group: element.group };
        }
    }

    private createMarketplaceItem(node: MarketplaceNode): vscode.TreeItem {
        const label = this.formatMarketplaceLabel(node.url);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.description = `${node.plugins.length} plugin(s)`;
        // Use different contextValue for GitHub vs non-GitHub marketplaces
        item.contextValue = this.isGitHubUrl(node.url) ? 'marketplace-github' : 'marketplace';
        item.tooltip = node.url;
        return item;
    }

    private isGitHubUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname.toLowerCase();
            return hostname === 'github.com' ||
                hostname === 'www.github.com' ||
                hostname === 'raw.githubusercontent.com';
        } catch {
            return false;
        }
    }

    private createPluginItem(node: PluginNode): vscode.TreeItem {
        const plugin = node.plugin;
        const totalItems = plugin.groups.reduce((sum, group) => sum + group.items.length, 0);
        const collapsible = plugin.groups.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const item = new vscode.TreeItem(plugin.name, collapsible);
        item.iconPath = new vscode.ThemeIcon('package');
        item.description = plugin.version ?? '';
        item.contextValue = 'plugin';
        item.tooltip = new vscode.MarkdownString();
        item.tooltip.appendMarkdown(`**${plugin.name}**\n\n`);
        if (plugin.description) {
            item.tooltip.appendMarkdown(`${plugin.description}\n\n`);
        }
        item.tooltip.appendMarkdown(`- **ID:** ${plugin.id}\n`);
        item.tooltip.appendMarkdown(`- **Version:** ${plugin.version ?? 'unknown'}\n`);
        item.tooltip.appendMarkdown(`- **Items:** ${totalItems}\n`);
        item.tooltip.appendMarkdown(`- **Source:** ${plugin.sourceUrl}`);
        return item;
    }

    private createGroupItem(node: GroupNode): vscode.TreeItem {
        const group = node.group;
        const collapsible = group.items.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const item = new vscode.TreeItem(group.name, collapsible);
        const iconName = groupIconMap[group.key] ?? 'symbol-misc';
        item.iconPath = new vscode.ThemeIcon(iconName);
        item.description = `${group.items.length}`;
        item.contextValue = 'group';
        return item;
    }

    private createItemItem(node: ItemNode): vscode.TreeItem {
        const groupItem = node.item;
        const item = new vscode.TreeItem(groupItem.name, vscode.TreeItemCollapsibleState.None);

        item.iconPath = new vscode.ThemeIcon('file');
        item.contextValue = 'item';
        item.tooltip = new vscode.MarkdownString();
        item.tooltip.appendMarkdown(`**${groupItem.name}**\n\n`);
        if (groupItem.description) {
            item.tooltip.appendMarkdown(`${groupItem.description}\n\n`);
        }
        item.tooltip.appendMarkdown(`*Click to preview*`);

        item.command = {
            command: 'vscode-agent-plugins.previewItem',
            title: 'Preview Item',
            arguments: [node]
        };

        return item;
    }

    private formatMarketplaceLabel(url: string): string {
        try {
            const parsed = new URL(url);
            if (parsed.hostname.includes('github.com') || parsed.hostname.includes('githubusercontent.com')) {
                const segments = parsed.pathname.split('/').filter(Boolean);
                if (segments.length >= 2) {
                    return `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`;
                }
            }
            return parsed.hostname + parsed.pathname;
        } catch {
            return url;
        }
    }
}

export function createMarketplaceTreeView(services: ExtensionServices): {
    treeView: vscode.TreeView<TreeNode>;
    provider: MarketplaceTreeDataProvider;
} {
    const provider = new MarketplaceTreeDataProvider(services);
    const treeView = vscode.window.createTreeView('vscode-agent-plugins.marketplaceExplorer', {
        treeDataProvider: provider,
        showCollapseAll: true
    });

    return { treeView, provider };
}
