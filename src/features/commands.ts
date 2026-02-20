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
import { getNonce, isSafeUrl, escapeHtml } from './utils';
import {
    buildInstallPayload,
    executeInstall,
    resolveAgentsPath,
    type InstallScope
} from './delegation';
import {
    fetchAllMarketplaces,
    fetchGroupItemDescription,
    fetchGroupItemContent,
    clearMarketplaceCache,
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
import type { ItemNode, MarketplacePlugin as TreePluginType } from './treeview';
import { signInToGitHub, isSignedInToGitHub } from './github-auth';

async function loadMarketplaceViewModel(
    logger: ExtensionServices['logger'],
    options?: { forceRefresh?: boolean }
): Promise<MarketplaceViewModel & { fromCache?: boolean; refreshing?: boolean }> {
    const urls = getMarketplaceUrls();
    if (urls.length === 0) {
        return {
            marketplaceUrls: [],
            plugins: [],
            warnings: ['No marketplace URLs configured. Use the add command to register at least one marketplace.'],
            errors: []
        };
    }

    const result = await fetchAllMarketplaces(urls, { forceRefresh: options?.forceRefresh });
    const cacheNote = result.fromCache ? ' (cached)' : '';
    const refreshNote = result.refreshing ? ' - refreshing in background' : '';
    logger.info(`Loaded ${result.plugins.length} plugin(s) from ${urls.length} marketplace URL(s)${cacheNote}${refreshNote}.`);

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
        errors: result.errors,
        fromCache: result.fromCache,
        refreshing: result.refreshing
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

/**
 * Remove a marketplace URL from the tree view context (right-click on marketplace node).
 */
export async function removeMarketplaceFromTree({ logger }: ExtensionServices, node: { type: string; url: string }): Promise<void> {
    if (!node || node.type !== 'marketplace' || !node.url) {
        return;
    }

    const url = node.url;

    // Check which scope(s) contain this URL
    const globalUrls = getMarketplaceUrlsForTarget(vscode.ConfigurationTarget.Global);
    const workspaceUrls = getMarketplaceUrlsForTarget(vscode.ConfigurationTarget.Workspace);

    const inGlobal = globalUrls.includes(url);
    const inWorkspace = workspaceUrls.includes(url);

    if (!inGlobal && !inWorkspace) {
        vscode.window.showWarningMessage('This marketplace URL is not found in settings.');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Remove "${url}" from settings?`,
        { modal: false },
        'Remove'
    );

    if (confirm !== 'Remove') {
        return;
    }

    // Remove from all scopes where it exists
    if (inGlobal) {
        await updateMarketplaceUrls(
            globalUrls.filter((u) => u !== url),
            vscode.ConfigurationTarget.Global
        );
    }
    if (inWorkspace) {
        await updateMarketplaceUrls(
            workspaceUrls.filter((u) => u !== url),
            vscode.ConfigurationTarget.Workspace
        );
    }

    logger.info(`Removed marketplace URL from tree: ${url}`);
    vscode.window.showInformationMessage('Marketplace removed.');
}

async function performDelegatedInstall(
    services: ExtensionServices,
    marketplaceUrls: string[],
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

    const payload = buildInstallPayload(selectedPlugins, scope, targetPath, marketplaceUrls);
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

    const refreshPanelState = async (forceRefresh = false): Promise<void> => {
        if (forceRefresh) {
            services.logger.info('Force refresh requested - clearing marketplace cache');
            clearMarketplaceCache();
        }
        viewModel = await loadMarketplaceViewModel(services.logger, { forceRefresh });
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

    const panelDisposables: vscode.Disposable[] = [marketplaceConfigWatcher];

    panel.onDidDispose(() => {
        panelDisposables.forEach(d => d.dispose());
    });

    panelDisposables.push(panel.webview.onDidReceiveMessage(
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
                await refreshPanelState(true); // Force refresh when user clicks refresh
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

                await performDelegatedInstall(services, viewModel.marketplaceUrls, selectedPlugins, message.scope);
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
        }
    ));
}

function parseMarkdownFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
    const lines = content.split(/\r?\n/);
    const frontmatter: Record<string, string> = {};
    let body = content;

    const trimmedStart = lines.findIndex((line) => line.trim().length > 0);
    if (trimmedStart >= 0 && lines[trimmedStart].trim() === '---') {
        let endIndex = -1;
        for (let index = trimmedStart + 1; index < lines.length; index += 1) {
            if (lines[index].trim() === '---') {
                endIndex = index;
                break;
            }
            const match = /^([a-zA-Z_-]+)\s*:\s*(.+)$/i.exec(lines[index]);
            if (match) {
                frontmatter[match[1].toLowerCase()] = match[2].trim().replace(/^['"]|['"]$/g, '');
            }
        }
        if (endIndex > 0) {
            body = lines.slice(endIndex + 1).join('\n').trim();
        }
    }

    return { frontmatter, body };
}

function simpleMarkdownToHtml(markdown: string): string {
    let html = escapeHtml(markdown);

    // Headers
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links - validate URLs to prevent javascript: and other unsafe protocols
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        if (!isSafeUrl(url)) {
            return text; // Render as plain text if URL is unsafe
        }
        return `<a href="${url}">${text}</a>`;
    });

    // Unordered lists
    html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Paragraphs
    html = html.replace(/\n\n+/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>(<h[1-6]>)/g, '$1');
    html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');

    return html;
}

function createPreviewWebviewHtml(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    itemName: string,
    groupName: string,
    pluginName: string,
    content: string,
    docUrl?: string
): string {
    const nonce = getNonce();
    const codiconCss = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'codicon.css')
    );

    const { frontmatter, body } = parseMarkdownFrontmatter(content);
    const renderedBody = simpleMarkdownToHtml(body);

    const description = frontmatter.description || frontmatter.summary || '';
    const license = frontmatter.license || '';

    const groupIconMap: Record<string, string> = {
        skills: 'tools',
        agents: 'account',
        commands: 'terminal-cmd',
        tools: 'wrench',
        prompts: 'comment-discussion',
        workflows: 'git-merge'
    };
    const iconName = groupIconMap[groupName.toLowerCase()] || 'file';

    // Filter out description/summary from metadata display since we show it separately
    const metadataEntries = Object.entries(frontmatter).filter(
        ([key]) => !['description', 'summary', 'license'].includes(key.toLowerCase())
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} https:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(itemName)}</title>
  <link nonce="${nonce}" rel="stylesheet" href="${codiconCss}">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
      line-height: 1.6;
    }
    .header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-icon.codicon {
      font-size: 24px;
      line-height: 1;
      margin-top: 2px;
      opacity: 0.85;
      flex-shrink: 0;
    }
    .header-content { flex: 1; }
    .header h1 {
      margin: 0 0 6px 0;
      font-size: 24px;
      font-weight: 600;
      line-height: 1;
    }
    .header-meta {
      font-size: 13px;
      opacity: 0.8;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      align-items: center;
    }
    .meta-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .github-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 13px;
    }
    .github-link:hover .github-link-text { text-decoration: underline; }
    .tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 0;
    }
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 13px;
      font-family: var(--vscode-font-family);
      opacity: 0.7;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .tab:hover { opacity: 1; }
    .tab.active {
      opacity: 1;
      border-bottom-color: var(--vscode-focusBorder);
      background: var(--vscode-editor-background);
    }
    .tab-panel {
      display: none;
      padding: 20px 0;
    }
    .tab-panel.active { display: block; }
    .metadata-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .metadata-card h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .metadata-description {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .metadata-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }
    .metadata-item {
      background: var(--vscode-editor-background);
      border-radius: 4px;
      padding: 10px 12px;
    }
    .metadata-item-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
      margin-bottom: 4px;
    }
    .metadata-item-value {
      font-size: 13px;
      word-break: break-word;
    }
    .license-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
      padding: 20px;
    }
    .license-card h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .license-text {
      font-size: 13px;
      opacity: 0.9;
    }
    .no-license {
      font-style: italic;
      opacity: 0.6;
    }
    .content-body {
      padding: 0;
    }
    .content-body h1, .content-body h2, .content-body h3,
    .content-body h4, .content-body h5, .content-body h6 {
      margin-top: 20px;
      margin-bottom: 10px;
    }
    .content-body h1:first-child, .content-body h2:first-child {
      margin-top: 0;
    }
    .content-body p { margin: 10px 0; }
    .content-body ul { padding-left: 24px; margin: 10px 0; }
    .content-body li { margin: 4px 0; }
    .content-body code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    .content-body pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 12px 0;
    }
    .content-body pre code {
      padding: 0;
      background: none;
    }
    .content-body a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .content-body a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="codicon codicon-${iconName} header-icon"></span>
    <div class="header-content">
      <h1>${escapeHtml(itemName)}</h1>
      <div class="header-meta">
        <span class="meta-item"><span class="badge">${escapeHtml(groupName)}</span></span>
        <span class="meta-item"><span class="codicon codicon-package"></span> ${escapeHtml(pluginName)}</span>
        ${docUrl && isSafeUrl(docUrl) ? `<a href="${escapeHtml(docUrl)}" class="github-link"><span class="codicon codicon-github"></span><span class="github-link-text">View on GitHub</span></a>` : ''}
      </div>
    </div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="metadata">
      <span class="codicon codicon-info"></span> Metadata
    </button>
    <button class="tab" data-tab="content">
      <span class="codicon codicon-file-text"></span> Content
    </button>
    ${license ? `<button class="tab" data-tab="license"><span class="codicon codicon-law"></span> License</button>` : ''}
  </div>

  <div id="metadata" class="tab-panel active">
    <div class="metadata-card">
      <h3>About</h3>
      ${description ? `<div class="metadata-description">${escapeHtml(description)}</div>` : ''}
      ${metadataEntries.length > 0 ? `
      <div class="metadata-grid">
        ${metadataEntries.map(([key, value]) => `
          <div class="metadata-item">
            <div class="metadata-item-label">${escapeHtml(key)}</div>
            <div class="metadata-item-value">${escapeHtml(value)}</div>
          </div>
        `).join('')}
      </div>
      ` : ''}
    </div>
  </div>

  <div id="content" class="tab-panel">
    <div class="content-body">
      ${renderedBody}
    </div>
  </div>

  ${license ? `
  <div id="license" class="tab-panel">
    <div class="license-card">
      <h3><span class="codicon codicon-law"></span> License</h3>
      <div class="license-text">${escapeHtml(license)}</div>
    </div>
  </div>
  ` : ''}

  <script nonce="${nonce}">
    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.tab-panel');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetId = tab.dataset.tab;

        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById(targetId).classList.add('active');
      });
    });
  </script>
</body>
</html>`;
}

export async function previewItem(services: ExtensionServices, node: ItemNode): Promise<void> {
    if (!node || node.type !== 'item') {
        return;
    }

    const item = node.item;
    const group = node.group;
    const plugin = node.plugin;

    const result = await fetchGroupItemContent(item);

    if (!result.content) {
        vscode.window.showWarningMessage(`Could not fetch content for "${item.name}".`);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'vscode-agent-plugins.itemPreview',
        `${item.name} - ${group.name}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(services.context.extensionUri, 'dist')]
        }
    );

    panel.iconPath = new vscode.ThemeIcon('file');
    panel.webview.html = createPreviewWebviewHtml(
        panel,
        services.context.extensionUri,
        item.name,
        group.name,
        plugin.name,
        result.content,
        item.docUrl
    );
}

export async function installPluginFromTree(services: ExtensionServices, node: { type: string; plugin: MarketplacePlugin }): Promise<void> {
    if (!node || node.type !== 'plugin' || !node.plugin) {
        vscode.window.showWarningMessage('No plugin selected.');
        return;
    }

    const plugin = node.plugin;
    const scopePick = await vscode.window.showQuickPick(
        [
            { label: 'Workspace', scope: 'workspace' as InstallScope, description: 'Install to local workspace' },
            { label: 'User', scope: 'user' as InstallScope, description: 'Install globally for this user' }
        ],
        { placeHolder: 'Select installation scope' }
    );

    if (!scopePick) {
        return;
    }

    await performDelegatedInstall(services, [plugin.sourceUrl], [plugin], scopePick.scope);
}

/**
 * Sign in to GitHub to access private repositories and repos requiring SAML/SSO.
 * Uses VS Code's built-in GitHub authentication provider.
 */
export async function gitHubSignIn(services: ExtensionServices): Promise<void> {
    const isSignedIn = await isSignedInToGitHub();
    if (isSignedIn) {
        const choice = await vscode.window.showInformationMessage(
            'You are already signed in to GitHub.',
            'OK',
            'Sign out'
        );
        if (choice === 'Sign out') {
            // VS Code handles sign out through the accounts menu
            vscode.window.showInformationMessage(
                'To sign out, use the account icon in the status bar or Activity Bar.'
            );
        }
        return;
    }

    const session = await signInToGitHub();
    if (session) {
        services.logger.info(`Signed in to GitHub as ${session.account.label}`);
        vscode.window.showInformationMessage(
            `Signed in to GitHub as ${session.account.label}. Private repos and SAML/SSO are now accessible.`
        );
    } else {
        services.logger.warn('GitHub sign-in was cancelled or failed');
    }
}

/**
 * Check current GitHub authentication status.
 */
export async function gitHubAuthStatus(services: ExtensionServices): Promise<void> {
    const isSignedIn = await isSignedInToGitHub();
    if (isSignedIn) {
        vscode.window.showInformationMessage(
            'GitHub: Signed in. Private repos and SAML/SSO access enabled.'
        );
    } else {
        const choice = await vscode.window.showInformationMessage(
            'GitHub: Not signed in. Sign in to access private repos and SAML/SSO protected resources.',
            'Sign In'
        );
        if (choice === 'Sign In') {
            await gitHubSignIn(services);
        }
    }
}