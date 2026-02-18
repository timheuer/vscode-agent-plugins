import * as vscode from 'vscode';

export const CONFIG_SECTION = 'vscodeAgentPlugins';
export const MARKETPLACES_KEY = 'marketplaces';
export const LOG_LEVEL_KEY = 'logLevel';

function normalizeUrls(urls: string[] | undefined): string[] {
    if (!urls) {
        return [];
    }

    return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
}

function getMarketplaceSettingInspection() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<string[]>(MARKETPLACES_KEY);
}

export function getMarketplaceUrlsForTarget(target: vscode.ConfigurationTarget): string[] {
    const inspection = getMarketplaceSettingInspection();
    if (!inspection) {
        return [];
    }

    if (target === vscode.ConfigurationTarget.Global) {
        return normalizeUrls(inspection.globalValue);
    }

    if (target === vscode.ConfigurationTarget.Workspace) {
        return normalizeUrls(inspection.workspaceValue);
    }

    return [];
}

export function getMarketplaceUrls(): string[] {
    const globalUrls = getMarketplaceUrlsForTarget(vscode.ConfigurationTarget.Global);
    const workspaceUrls = getMarketplaceUrlsForTarget(vscode.ConfigurationTarget.Workspace);
    return Array.from(new Set([...globalUrls, ...workspaceUrls]));
}

export async function updateMarketplaceUrls(urls: string[], target: vscode.ConfigurationTarget): Promise<void> {
    await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(MARKETPLACES_KEY, normalizeUrls(urls), target);
}

export async function pickSettingsTarget(): Promise<vscode.ConfigurationTarget | undefined> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: 'User', target: vscode.ConfigurationTarget.Global },
            { label: 'Workspace', target: vscode.ConfigurationTarget.Workspace }
        ],
        { placeHolder: 'Save this setting in User or Workspace settings?' }
    );

    return pick?.target;
}