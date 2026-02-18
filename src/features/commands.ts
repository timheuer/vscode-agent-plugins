import * as vscode from 'vscode';
import type { ExtensionServices } from '../extension';
import {
    CONFIG_SECTION,
    MARKETPLACES_KEY,
    getMarketplaceUrls,
    getMarketplaceUrlsForTarget,
    pickSettingsTarget,
    updateMarketplaceUrls
} from './config';
import {
    buildInstallPayload,
    executeInstall,
    resolveAgentsPath,
    type InstallScope
} from './delegation';
import {
    fetchAllMarketplaces,
    fetchGroupItemDescription,
    type MarketplacePlugin,
    type MarketplaceGroupItem
} from './marketplace';
import {
    createMarketplacePanel,
    createMarketplaceWebviewHtml,
    createPluginKeyMap,
    toWebviewData,
    type MarketplacePanelMessage,
    type MarketplaceViewModel
} from './webview';

async function loadMarketplaceViewModel(logger: ExtensionServices['logger']): Promise<MarketplaceViewModel> {
    const urls = getMarketplaceUrls();
    if (urls.length === 0) {
        return {
            marketplaceUrls: [],
            plugins: [],
            warnings: ['No marketplace URLs configured. Use the add command to register at least one marketplace.'],
            errors: []
        };
    }

    const result = await fetchAllMarketplaces(urls);
    logger.info(`Loaded ${result.plugins.length} plugin(s) from ${urls.length} marketplace URL(s).`);
    for (const warning of result.warnings) {
        logger.warn(warning);
    }
    for (const error of result.errors) {
        logger.error(error);
    }

    return {
        marketplaceUrls: urls,
        plugins: result.plugins,
        warnings: result.warnings,
        errors: result.errors
    };
}

export async function addMarketplaceUrl({ logger }: ExtensionServices): Promise<void> {
    const input = await vscode.window.showInputBox({
        prompt: 'Enter a marketplace URL that points to marketplace.json',
        placeHolder: 'https://example.com/marketplace.json',
        ignoreFocusOut: true,
        validateInput: (value) => {
            try {
                const parsed = new URL(value.trim());
                if (!/^https?:$/i.test(parsed.protocol)) {
                    return 'Only http/https URLs are supported.';
                }
                return undefined;
            } catch {
                return 'Enter a valid URL.';
            }
        }
    });

    if (!input) {
        return;
    }

    const target = await pickSettingsTarget();
    if (!target) {
        return;
    }

    const existing = getMarketplaceUrlsForTarget(target);
    const updated = [...existing, input.trim()];
    await updateMarketplaceUrls(updated, target);
    logger.info(`Added marketplace URL: ${input.trim()}`);
    vscode.window.showInformationMessage('Marketplace URL added.');
}

export async function removeMarketplaceUrl({ logger }: ExtensionServices): Promise<void> {
    const target = await pickSettingsTarget();
    if (!target) {
        return;
    }

    const urls = getMarketplaceUrlsForTarget(target);
    if (urls.length === 0) {
        vscode.window.showInformationMessage('No marketplace URLs are configured for the selected settings scope.');
        return;
    }

    const selected = await vscode.window.showQuickPick(urls, {
        placeHolder: 'Select a marketplace URL to remove',
        canPickMany: false
    });

    if (!selected) {
        return;
    }

    await updateMarketplaceUrls(
        urls.filter((url) => url !== selected),
        target
    );

    logger.info(`Removed marketplace URL: ${selected}`);
    vscode.window.showInformationMessage('Marketplace URL removed.');
}

async function performDelegatedInstall(
    services: ExtensionServices,
    viewModel: MarketplaceViewModel,
    selectedPlugins: MarketplacePlugin[],
    scope: InstallScope
): Promise<void> {
    const targetPath = resolveAgentsPath(scope);
    if (!targetPath) {
        vscode.window.showErrorMessage('Workspace scope install requires an open workspace folder.');
        return;
    }

    const targetSummary =
        scope === 'workspace'
            ? `Skills: ${targetPath}\\.agents\\skills\nAgents: ${targetPath}\\.github\\agents`
            : `Root: ${targetPath}\\<marketplace-name>\\<plugin-name>\\(skills|agents)`;

    const confirmation = await vscode.window.showWarningMessage(
        `Install/update ${selectedPlugins.length} plugin(s) in ${scope} scope?\n${targetSummary}`,
        { modal: true },
        'Continue'
    );

    if (confirmation !== 'Continue') {
        return;
    }

    const payload = buildInstallPayload(selectedPlugins, scope, targetPath, viewModel.marketplaceUrls);
    services.logger.info(`Installing ${selectedPlugins.length} plugin(s) to ${scope} scope at '${targetPath}'.`);
    const result = await executeInstall(services.context, selectedPlugins, payload);


    if (result.success) {
        vscode.window.showInformationMessage(
            scope === 'workspace'
                ? `Installed/updated ${selectedPlugins.length} plugin(s) in workspace (.agents/skills and .github/agents).`
                : `Installed/updated ${selectedPlugins.length} plugin(s) in user scope (~/.copilot/installed-plugins).`
        );
        return;
    }

    vscode.window.showErrorMessage(`Install/update failed: ${result.error ?? 'Unknown error'}`);
}

export async function browseMarketplace(services: ExtensionServices): Promise<void> {
    const panel = createMarketplacePanel(services.context);
    let viewModel = await loadMarketplaceViewModel(services.logger);
    let pluginKeyMap = createPluginKeyMap(viewModel.plugins);
    const descriptorCache = new Map<string, { description?: string; error?: string; docUrl?: string }>();
    const refreshPanelState = async (): Promise<void> => {
        viewModel = await loadMarketplaceViewModel(services.logger);
        pluginKeyMap = createPluginKeyMap(viewModel.plugins);
        descriptorCache.clear();
        await panel.webview.postMessage({
            type: 'state',
            data: toWebviewData(viewModel)
        });
    };

    panel.webview.html = createMarketplaceWebviewHtml(panel, services.context.extensionUri, viewModel);

    const marketplaceConfigWatcher = vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (!event.affectsConfiguration(`${CONFIG_SECTION}.${MARKETPLACES_KEY}`)) {
            return;
        }

        services.logger.info('Marketplace URL settings changed; refreshing open marketplace browser.');
        await refreshPanelState();
    });

    panel.onDidDispose(() => {
        marketplaceConfigWatcher.dispose();
    });

    panel.webview.onDidReceiveMessage(
        async (message: MarketplacePanelMessage) => {
            if (message.type === 'ready') {
                await panel.webview.postMessage({
                    type: 'state',
                    data: toWebviewData(viewModel)
                });
                return;
            }

            if (message.type === 'addMarketplaceUrl') {
                await addMarketplaceUrl(services);
                await refreshPanelState();
                return;
            }

            if (message.type === 'refresh') {
                await refreshPanelState();
                return;
            }

            if (message.type === 'install') {
                const selectedPlugins = message.selectedKeys
                    .map((key) => pluginKeyMap.get(key))
                    .filter((plugin): plugin is MarketplacePlugin => Boolean(plugin));

                if (selectedPlugins.length === 0) {
                    vscode.window.showWarningMessage('Select at least one plugin to install/update.');
                    return;
                }

                await performDelegatedInstall(services, viewModel, selectedPlugins, message.scope);
                return;
            }

            if (message.type === 'resolveGroupItem') {
                const cacheKey = `${message.pluginKey}::${message.groupName}::${message.itemName}`;
                const cached = descriptorCache.get(cacheKey);
                if (cached) {
                    await panel.webview.postMessage({
                        type: 'groupItemDetails',
                        pluginKey: message.pluginKey,
                        groupName: message.groupName,
                        itemName: message.itemName,
                        ...cached
                    });
                    return;
                }

                const plugin = pluginKeyMap.get(message.pluginKey);
                const group = plugin?.groups.find((entry) => entry.name === message.groupName);
                const item = group?.items.find((entry) => entry.name === message.itemName);

                if (!plugin || !group || !item) {
                    const payload = {
                        error: 'Descriptor entry could not be found.',
                        docUrl: undefined,
                        description: undefined
                    };
                    descriptorCache.set(cacheKey, payload);
                    await panel.webview.postMessage({
                        type: 'groupItemDetails',
                        pluginKey: message.pluginKey,
                        groupName: message.groupName,
                        itemName: message.itemName,
                        ...payload
                    });
                    return;
                }

                const description = await fetchGroupItemDescription(item as MarketplaceGroupItem);
                const payload = {
                    description,
                    docUrl: item.docUrl,
                    error: description ? undefined : 'Descriptor metadata not found for this item.'
                };
                descriptorCache.set(cacheKey, payload);
                await panel.webview.postMessage({
                    type: 'groupItemDetails',
                    pluginKey: message.pluginKey,
                    groupName: message.groupName,
                    itemName: message.itemName,
                    ...payload
                });
            }
        },
        undefined,
        services.context.subscriptions
    );
}