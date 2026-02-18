import * as vscode from 'vscode';
import { Logger } from '@timheuer/vscode-ext-logger';
import {
	addMarketplaceUrl,
	browseMarketplace,
	removeMarketplaceUrl
} from './features/commands';
import { CONFIG_SECTION, LOG_LEVEL_KEY } from './features/config';

export interface ExtensionServices {
	logger: Logger;
	context: vscode.ExtensionContext;
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

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-agent-plugins.browseMarketplace', () => browseMarketplace(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.addMarketplaceUrl', () => addMarketplaceUrl(services)),
		vscode.commands.registerCommand('vscode-agent-plugins.removeMarketplaceUrl', () => removeMarketplaceUrl(services))
	);

	logger.info('vscode-agent-plugins extension activated');
}

export function deactivate() { }
