# Agent Plugins Browser

Browse one or more AI agent plugin marketplaces (each URL points to `marketplace.json`), select plugins, and install/update them directly.

## Features

- Webview browser built with `vscode-elements`.
- Marketplace URL management through commands.
- Marketplace URL resolution supports both:
  - Repository URLs (for example `https://github.com/anthropics/skills`) resolved to `.claude-plugin/marketplace.json`
  - Direct marketplace JSON URLs.
- Multi-select plugin install/update request flow.
- Install targets:
  - Workspace
    - Skills: `<workspace>/.agents/skills/<skill-name>/...`
    - Agents: `<workspace>/.github/agents/<agent-name>.agent.md`
  - User
    - Root: `~/.copilot/installed-plugins/<marketplace-name>/<plugin-name>/`
    - Skills: `.../skills/<skill-name>/...`
    - Agents: `.../agents/<agent-name>.agent.md`
- Output logging using `@timheuer/vscode-ext-logger`.
- Expandable plugin contents with nested skill/agent item descriptors fetched on demand.

## Commands

- `Agent Plugins: Browse Marketplace`
- `Agent Plugins: Add Marketplace URL`
- `Agent Plugins: Remove Marketplace URL`

## Extension Settings

- `vscodeAgentPlugins.marketplaces` (`string[]`): Marketplace JSON URLs.
- `vscodeAgentPlugins.logLevel` (`off|error|warn|info|debug|trace`): Extension log level.

## Development

- `npm run compile`
- `npm run watch`
- `npm run test`
