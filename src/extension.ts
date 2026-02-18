import * as vscode from 'vscode';
import { Logger } from '@timheuer/vscode-ext-logger';
import {
	addMarketplaceUrl,
	browseMarketplace,
	removeMarketplaceUrl,
	previewItem,
	installPluginFromTree,
	gitHubSignIn,
	gitHubAuthStatus
} from './features/commands';
import { CONFIG_SECTION, LOG_LEVEL_KEY, MARKETPLACES_KEY, getMarketplaceUrls } from './features/config';
import { createMarketplaceTreeView, MarketplaceNode } from './features/treeview';
import { onDidChangeGitHubAuth } from './features/github-auth';
import { initLogger } from './features/logger';
import { initializeCache } from './features/cache';
import { prefetchMarketplaces, onMarketplaceCacheUpdated, clearMarketplaceCache } from './features/marketplace';

export interface ExtensionServices {
	logger: Logger;
	context: vscode.ExtensionContext;
}

/**
 * Extract GitHub repository URL from a raw.githubusercontent.com or github.com URL.
 */
function extractGitHubRepoUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		if (hostname === 'raw.githubusercontent.com') {
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (parts.length >= 2) {
				return `https://github.com/${parts[0]}/${parts[1]}`;
			}
		}

		if (hostname === 'github.com' || hostname === 'www.github.com') {
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (parts.length >= 2) {
				return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
			}
		}

		return undefined;
	} catch {
		return undefined;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const initialLogLevel = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(LOG_LEVEL_KEY, 'info');
	const logger = new Logger({
		name: context.extension.packageJSON.displayName ?? context.extension.id,
		level: initialLogLevel,
		outputChannel: true,
		context
	});

	context.subscriptions.push(logger);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${LOG_LEVEL_KEY}`)) {
				const level = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(LOG_LEVEL_KEY, 'info');
				logger.setLevelFromString(level);
				logger.info(`Log level updated to ${level}`);
			}
		})
	);

	const services: ExtensionServices = {
		logger,
		context
	};

	// Initialize shared logger for all modules
	initLogger(logger);

	// Initialize cache for marketplace data persistence
	initializeCache(context.globalState);

	// Prefetch marketplace data in background to warm the cache
	const urls = getMarketplaceUrls();
	if (urls.length > 0) {
		prefetchMarketplaces(urls);
	}

	const { treeView, provider } = createMarketplaceTreeView(services);
	context.subscriptions.push(treeView);

	// Refresh tree view when background cache refresh completes
	context.subscriptions.push(
		onMarketplaceCacheUpdated(() => {
			logger.trace('Marketplace cache updated, refreshing tree view');
			provider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.${MARKETPLACES_KEY}`)) {
				provider.loadData();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-agent-plugins.browseMarketplace', () => browseMarketplace(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.addMarketplaceUrl', () => addMarketplaceUrl(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.removeMarketplaceUrl', () => removeMarketplaceUrl(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.refreshTreeView', () => provider.loadData()),
		vscode.commands.registerCommand('vscode-agent-plugins.forceRefreshTreeView', () => {
			logger.info('Force refresh requested - clearing marketplace cache');
			clearMarketplaceCache();
			provider.loadData();
		}),
		vscode.commands.registerCommand('vscode-agent-plugins.previewItem', (node) => previewItem(services, node)),
		vscode.commands.registerCommand('vscode-agent-plugins.installPlugin', (node) => installPluginFromTree(services, node)),
		vscode.commands.registerCommand('vscode-agent-plugins.gitHubSignIn', () => gitHubSignIn(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.gitHubAuthStatus', () => gitHubAuthStatus(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.openMarketplaceRepo', (node: MarketplaceNode) => {
			if (node?.type === 'marketplace' && node.url) {
				const repoUrl = extractGitHubRepoUrl(node.url);
				if (repoUrl) {
					vscode.env.openExternal(vscode.Uri.parse(repoUrl));
				}
			}
		}),
		vscode.commands.registerCommand('vscode-agent-plugins.collapseNode', async (node) => {
			if (node) {
				await treeView.reveal(node, { select: true, focus: true });
			}
			await vscode.commands.executeCommand('list.collapse');
		}),
		vscode.commands.registerCommand('vscode-agent-plugins.openSettings', () => {
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
		})
	);

	// Refresh tree view when GitHub authentication changes (sign in/out)
	context.subscriptions.push(
		onDidChangeGitHubAuth(() => {
			logger.info('GitHub authentication changed, refreshing marketplace data');
			provider.loadData();
		})
	);

	logger.info('vscode-agent-plugins extension activated');
}

/** No cleanup needed - all disposables registered via context.subscriptions */
export function deactivate(): void { }
