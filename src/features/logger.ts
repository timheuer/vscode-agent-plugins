import type { Logger } from '@timheuer/vscode-ext-logger';

let logger: Logger | undefined;

export function initLogger(instance: Logger): void {
    logger = instance;
}

export function getLogger(): Logger | undefined {
    return logger;
}
