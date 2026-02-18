# Agent Plugins Browser

Browse one or more AI agent plugin marketplaces (each URL points to `marketplace.json`), select plugins, and install/update them directly.

![preview](https://github.com/user-attachments/assets/84f5986c-02cc-4edb-b7b5-5398439a96df)

## Features

### Tree View Explorer

A dedicated **Agent Plugins** activity bar view displays your configured marketplaces in a hierarchical tree:

- **Marketplaces** — Top-level nodes showing each configured marketplace with plugin count
- **Plugins** — Expandable nodes showing version, description, and total item count
- **Groups** — Categorized items (skills, agents, commands, tools, prompts, workflows) with distinct icons
- **Items** — Individual skills or agents with click-to-preview functionality

### Webview Browser

Alternative full-screen marketplace browser built with standard VS Code UI elements for multi-select plugin installation.

### Marketplace URL Resolution

Supports both:

- Repository URLs (e.g., `https://github.com/anthropics/skills`) resolved to `.claude-plugin/marketplace.json`
- Direct marketplace JSON URLs

### GitHub Authentication

Sign in to GitHub using VS Code's built-in authentication provider to:

- Access private marketplace repositories
- Authenticate through SAML/SSO-protected organizations
- Automatically refresh tokens

### Item Preview

Click any skill or agent item to open a detailed preview panel with:

- **Metadata tab** — Description, frontmatter properties, and key-value metadata
- **Content tab** — Rendered markdown body with code highlighting
- **License tab** — License information when available

### Install Targets

**Workspace scope:**

- Skills: `<workspace>/.agents/skills/<skill-name>/...`
- Agents: `<workspace>/.github/agents/<agent-name>.agent.md`

**User scope:**

- Root: `~/.copilot/installed-plugins/<marketplace-name>/<plugin-name>/`
- Skills: `.../skills/<skill-name>/...`
- Agents: `.../agents/<agent-name>.agent.md`
- Automatically updates `chat.agentSkillsLocations` and `chat.agentFilesLocations` workspace settings

### Output Logging

Detailed logging with configurable log levels.

## Commands

| Command | Description |
|---------|-------------|
| `Agent Plugins: Browse Marketplace` | Open the webview marketplace browser |
| `Agent Plugins: Add Marketplace URL` | Add a new marketplace URL to settings |
| `Agent Plugins: Remove Marketplace URL` | Remove a marketplace URL from settings |
| `Agent Plugins: Refresh` | Refresh the tree view data |
| `Agent Plugins: Settings` | Open extension settings |
| `Agent Plugins: Sign In to GitHub` | Authenticate with GitHub for private repo access |
| `Agent Plugins: GitHub Auth Status` | Check current GitHub authentication status |

### Context Menu Actions

- **Install Plugin** — Install a plugin from the tree view (available on plugin nodes)
- **Open Repository** — Open the GitHub repository for a marketplace (available on GitHub-hosted marketplaces)
- **Collapse** — Collapse expanded marketplace, plugin, or group nodes

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentPlugins.marketplaces` | `string[]` | `[]` | List of marketplace.json URLs to browse |
| `agentPlugins.logLevel` | `string` | `info` | Log level (`off`, `error`, `warn`, `info`, `debug`, `trace`) |

## Requirements

- VS Code 1.109.0 or newer
- GitHub Authentication extension (bundled with VS Code) for private repo access

## Development

```bash
npm run compile    # Build the extension
npm run watch      # Watch mode for development
npm run test       # Run tests
npm run lint       # Run ESLint
npm run package    # Package for production
```
