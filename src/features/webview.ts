import * as vscode from 'vscode';
import { InstallScope } from './delegation';
import { MarketplacePlugin } from './marketplace';

export interface MarketplaceViewModel {
  plugins: MarketplacePlugin[];
  warnings: string[];
  errors: string[];
  marketplaceUrls: string[];
}

export type MarketplacePanelMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'install'; selectedKeys: string[]; scope: InstallScope }
  | { type: 'addMarketplaceUrl' }
  | { type: 'resolveGroupItem'; pluginKey: string; groupName: string; itemName: string };

const panelId = 'vscode-agent-plugins.marketplaceBrowser';

function pluginKey(plugin: MarketplacePlugin): string {
  return `${plugin.id}::${plugin.sourceUrl}`;
}

export function toWebviewData(viewModel: MarketplaceViewModel): Record<string, unknown> {
  return {
    marketplaceUrls: viewModel.marketplaceUrls,
    warnings: viewModel.warnings,
    errors: viewModel.errors,
    plugins: viewModel.plugins.map((plugin) => ({
      key: pluginKey(plugin),
      id: plugin.id,
      name: plugin.name,
      version: plugin.version ?? 'unknown',
      description: plugin.description ?? '',
      downloadUrl: plugin.downloadUrl ?? '',
      sourceUrl: plugin.sourceUrl,
      groups: plugin.groups
    }))
  };
}

function getNonce(): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return nonce;
}

export function createPluginKeyMap(plugins: MarketplacePlugin[]): Map<string, MarketplacePlugin> {
  return new Map(plugins.map((plugin) => [pluginKey(plugin), plugin]));
}

export function createMarketplaceWebviewHtml(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  viewModel: MarketplaceViewModel
): string {
  const nonce = getNonce();
  const elementsScript = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'vscode-elements.js')
  );
  const codiconCss = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'codicon.css')
  );
  const initialData = JSON.stringify(toWebviewData(viewModel)).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} https:; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Plugin Marketplaces</title>
  <style>
    html, body { height: 100%; }
    body {
      box-sizing: border-box;
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .top-area {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--vscode-editor-background);
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      box-shadow: 0 1px 3px color-mix(in srgb, var(--vscode-widget-shadow) 35%, transparent);
    }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .marketplace-controls { display: inline-flex; align-items: center; gap: 4px; min-width: 320px; }
    .status { margin: 8px 0 8px; font-size: 12px; opacity: 0.9; }
    .plugin-list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      align-content: start;
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding-right: 4px;
      padding-bottom: 8px;
    }
    .plugin-item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; display: grid; gap: 6px; }
    .plugin-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .plugin-head-left { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .meta { font-size: 12px; opacity: 0.85; }
    .details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; }
    .details summary { cursor: pointer; font-size: 12px; opacity: 0.9; list-style: none; }
    .details summary::-webkit-details-marker { display: none; }
    .details summary::marker { display: none; }
    .plugin-contents-summary { display: inline-flex; align-items: center; gap: 6px; }
    .group { margin-top: 8px; padding-left: 14px; }
    .group-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; opacity: 0.9; }
    .group-details { margin-top: 6px; padding-left: 18px; }
    .group-summary { display: inline-flex; align-items: center; gap: 6px; }
    .group-items { margin: 0; padding-left: 20px; list-style: disc; }
    .group-items li { margin: 4px 0; }
    .item-row { display: inline-flex; align-items: center; gap: 6px; position: relative; }
    .item-name { line-height: 1.3; }
    .item-info-btn {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      position: relative;
    }
    .item-info-btn .codicon { font-size: 14px; }
    .item-info-btn:hover,
    .item-info-btn:focus-visible { color: var(--vscode-foreground); outline: none; }
    .item-info-btn[data-loading="true"] { opacity: 0.6; cursor: progress; }
    .item-info-btn[data-tooltip]:hover::after,
    .item-info-btn[data-tooltip]:focus-visible::after {
      content: attr(data-tooltip);
      position: absolute;
      left: calc(100% + 8px);
      top: 0;
      transform: none;
      max-width: 420px;
      width: max-content;
      white-space: normal;
      text-align: left;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border: 1px solid var(--vscode-editorHoverWidget-border);
      border-radius: 6px;
      padding: 8px 10px;
      z-index: 30;
      box-shadow: 0 2px 6px color-mix(in srgb, var(--vscode-widget-shadow) 55%, transparent);
      pointer-events: none;
    }
    .expander { transition: transform 120ms ease; }
    details[open] > summary .expander { transform: rotate(90deg); }
    .warning { color: var(--vscode-editorWarning-foreground); }
    .error { color: var(--vscode-errorForeground); }
  </style>
  <link nonce="${nonce}" rel="stylesheet" href="${codiconCss}">
  <script nonce="${nonce}" type="module" src="${elementsScript}"></script>
</head>
<body>
  <div class="top-area">
    <div class="toolbar">
      <vscode-button id="refreshButton" appearance="secondary">Refresh</vscode-button>
      <div class="marketplace-controls">
        <vscode-single-select id="marketplaceSelect">
          <vscode-option value="__all__">All Marketplaces</vscode-option>
        </vscode-single-select>
        <vscode-button id="addMarketplaceButton" appearance="secondary" title="Add marketplace URL">
          <span class="codicon codicon-add"></span>
        </vscode-button>
      </div>
      <vscode-single-select id="scopeSelect">
        <vscode-option value="workspace">Workspace</vscode-option>
        <vscode-option value="user">User</vscode-option>
      </vscode-single-select>
      <vscode-button id="installButton">Install / Update Selected</vscode-button>
    </div>
    <div id="status" class="status"></div>
    <div id="warnings"></div>
    <div id="errors"></div>
  </div>
  <div id="plugins" class="plugin-list"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialData = ${initialData};
    let state = initialData;
    const selected = new Set();

    const statusEl = document.getElementById('status');
    const warningsEl = document.getElementById('warnings');
    const errorsEl = document.getElementById('errors');
    const pluginsEl = document.getElementById('plugins');

    const refreshButton = document.getElementById('refreshButton');
    const installButton = document.getElementById('installButton');
    const addMarketplaceButton = document.getElementById('addMarketplaceButton');
    const scopeSelect = document.getElementById('scopeSelect');
    const marketplaceSelect = document.getElementById('marketplaceSelect');
    let activeMarketplace = '__all__';

    function getVisiblePlugins() {
      if (activeMarketplace === '__all__') {
        return state.plugins;
      }

      return state.plugins.filter((plugin) => plugin.sourceUrl === activeMarketplace);
    }

    function syncMarketplaceOptions() {
      const current = activeMarketplace;
      marketplaceSelect.innerHTML = '';

      const allOption = document.createElement('vscode-option');
      allOption.value = '__all__';
      allOption.textContent = 'All Marketplaces';
      marketplaceSelect.appendChild(allOption);

      for (const url of state.marketplaceUrls) {
        const option = document.createElement('vscode-option');
        option.value = url;
        option.textContent = url;
        marketplaceSelect.appendChild(option);
      }

      const exists = state.marketplaceUrls.includes(current);
      activeMarketplace = exists ? current : '__all__';
      marketplaceSelect.value = activeMarketplace;
    }

    function updateStatus() {
      const visible = getVisiblePlugins();
      statusEl.textContent = visible.length + ' plugin(s) shown • ' + selected.size + ' selected • ' + state.marketplaceUrls.length + ' marketplace URL(s)';
    }

    function renderMessages() {
      warningsEl.innerHTML = '';
      errorsEl.innerHTML = '';

      for (const warning of state.warnings) {
        const row = document.createElement('div');
        row.className = 'status warning';
        row.textContent = warning;
        warningsEl.appendChild(row);
      }

      for (const error of state.errors) {
        const row = document.createElement('div');
        row.className = 'status error';
        row.textContent = error;
        errorsEl.appendChild(row);
      }
    }

    function renderPlugins() {
      pluginsEl.innerHTML = '';
      for (const plugin of getVisiblePlugins()) {
        const row = document.createElement('div');
        row.className = 'plugin-item';

        const head = document.createElement('div');
        head.className = 'plugin-head';

        const left = document.createElement('div');
        left.className = 'plugin-head-left';

        const title = document.createElement('strong');
        title.textContent = plugin.name;

        const badge = document.createElement('vscode-badge');
        const totalItems = Array.isArray(plugin.groups)
          ? plugin.groups.reduce((sum, group) => sum + (Array.isArray(group.items) ? group.items.length : 0), 0)
          : 0;
        badge.textContent = totalItems + ' ' + (totalItems === 1 ? 'item' : 'items');

        const checkbox = document.createElement('vscode-checkbox');
        checkbox.checked = selected.has(plugin.key);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            selected.add(plugin.key);
          } else {
            selected.delete(plugin.key);
          }
          updateStatus();
        });

        left.appendChild(title);
        left.appendChild(badge);
        head.appendChild(left);
        head.appendChild(checkbox);

        const version = document.createElement('div');
        version.className = 'meta';
        version.textContent = 'ID: ' + plugin.id + ' • Version: ' + plugin.version + ' • Source: ' + plugin.sourceUrl;

        row.appendChild(head);
        if (plugin.description) {
          const description = document.createElement('div');
          description.textContent = plugin.description;
          row.appendChild(description);
        }
        row.appendChild(version);

        if (Array.isArray(plugin.groups) && plugin.groups.length > 0) {
          const details = document.createElement('details');
          details.className = 'details';

          const summary = document.createElement('summary');
          summary.className = 'plugin-contents-summary';
          const pluginExpander = document.createElement('span');
          pluginExpander.className = 'codicon codicon-chevron-right expander';
          const pluginSummaryLabel = document.createElement('span');
          const groupCount = plugin.groups.length;
          pluginSummaryLabel.textContent = 'Plugin contents (' + groupCount + ' ' + (groupCount === 1 ? 'group' : 'groups') + ')';
          summary.appendChild(pluginExpander);
          summary.appendChild(pluginSummaryLabel);
          details.appendChild(summary);

          for (const group of plugin.groups) {
            const groupEl = document.createElement('details');
            groupEl.className = 'group';
            groupEl.open = true;

            const titleEl = document.createElement('summary');
            titleEl.className = 'group-title group-summary';
            const groupExpander = document.createElement('span');
            groupExpander.className = 'codicon codicon-chevron-right expander';
            titleEl.appendChild(groupExpander);

            const groupIcon = document.createElement('span');
            groupIcon.className = 'codicon';
            const groupIconNameMap = {
              skills: 'tools',
              agents: 'account',
              commands: 'terminal-cmd',
              tools: 'wrench',
              prompts: 'comment-discussion',
              workflows: 'git-merge'
            };
            groupIcon.classList.add('codicon-' + (groupIconNameMap[group.key] || 'symbol-misc'));
            const groupLabel = document.createElement('span');
            groupLabel.textContent = group.name + ' (' + group.items.length + ')';
            titleEl.appendChild(groupIcon);
            titleEl.appendChild(groupLabel);

            const listEl = document.createElement('ul');
            listEl.className = 'group-items group-details';
            for (const item of group.items) {
              const itemEl = document.createElement('li');

              const itemRow = document.createElement('div');
              itemRow.className = 'item-row';

              const itemName = document.createElement('span');
              itemName.className = 'item-name';
              itemName.textContent = item.name;

              const infoButton = document.createElement('button');
              infoButton.type = 'button';
              infoButton.className = 'item-info-btn';
              infoButton.setAttribute('aria-label', 'Show details for ' + item.name);
              infoButton.dataset.pluginKey = plugin.key;
              infoButton.dataset.groupName = group.name;
              infoButton.dataset.itemName = item.name;
              if (item.description) {
                infoButton.dataset.tooltip = item.description;
                infoButton.title = item.description;
                infoButton.dataset.loaded = 'true';
              }

              const infoIcon = document.createElement('span');
              infoIcon.className = 'codicon codicon-info';
              infoButton.appendChild(infoIcon);

              const requestDescription = () => {
                if (infoButton.dataset.loaded === 'true' || infoButton.dataset.loading === 'true') {
                  return;
                }

                infoButton.dataset.loading = 'true';
                infoButton.dataset.tooltip = 'Loading description...';
                vscode.postMessage({
                  type: 'resolveGroupItem',
                  pluginKey: plugin.key,
                  groupName: group.name,
                  itemName: item.name
                });
              };

              infoButton.addEventListener('mouseenter', requestDescription);
              infoButton.addEventListener('focus', requestDescription);
              infoButton.addEventListener('click', requestDescription);

              itemRow.appendChild(itemName);
              itemRow.appendChild(infoButton);
              itemEl.appendChild(itemRow);
              listEl.appendChild(itemEl);
            }

            groupEl.appendChild(titleEl);
            groupEl.appendChild(listEl);
            details.appendChild(groupEl);
          }

          row.appendChild(details);
        }

        pluginsEl.appendChild(row);
      }
    }

    function renderAll() {
      renderMessages();
      renderPlugins();
      updateStatus();
    }

    refreshButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    addMarketplaceButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'addMarketplaceUrl' });
    });

    marketplaceSelect.addEventListener('change', () => {
      activeMarketplace = marketplaceSelect.value || '__all__';
      renderPlugins();
      updateStatus();
    });

    installButton.addEventListener('click', () => {
      vscode.postMessage({
        type: 'install',
        selectedKeys: Array.from(selected),
        scope: scopeSelect.value === 'user' ? 'user' : 'workspace'
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'state') {
        state = message.data;
        selected.clear();
        syncMarketplaceOptions();
        renderAll();
      } else if (message?.type === 'groupItemDetails') {
        const buttons = Array.from(document.querySelectorAll('.item-info-btn')).filter((candidate) => {
          return candidate.dataset.pluginKey === message.pluginKey
            && candidate.dataset.groupName === message.groupName
            && candidate.dataset.itemName === message.itemName;
        });
        if (buttons.length === 0) {
          return;
        }

        const tooltip = message.description || message.error || 'Descriptor metadata not found.';
        for (const button of buttons) {
          button.dataset.tooltip = tooltip;
          button.title = tooltip;
          button.dataset.loaded = 'true';
          button.dataset.loading = 'false';
        }
      }
    });

    syncMarketplaceOptions();
    renderAll();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

export function createMarketplacePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(panelId, 'Agent Plugin Marketplaces', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'dist')
    ]
  });

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'marketplace-store.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'marketplace-store.svg')
  };

  return panel;
}
