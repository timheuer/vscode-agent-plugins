import * as assert from 'assert';
import { buildInstallPayload } from '../features/delegation';
import {
	fetchGroupItemContent,
	getSupportedSkillProfileDirectories,
	normalizeMarketplaceDocument,
	resolveMarketplaceDocumentReference
} from '../features/marketplace';

suite('Extension Test Suite', () => {
	test('normalizes marketplace plugin entries', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'alpha',
						name: 'Alpha Plugin',
						version: '1.2.3',
						description: 'Test plugin',
						downloadUrl: 'https://example.com/alpha.tgz',
						skills: [{ name: 'summarize' }],
						agents: ['triage-agent']
					}
				]
			},
			'https://marketplace.example/marketplace.json'
		);

		assert.strictEqual(result.errors.length, 0);
		assert.strictEqual(result.warnings.length, 0);
		assert.strictEqual(result.plugins.length, 1);
		assert.strictEqual(result.plugins[0].id, 'alpha');
		assert.strictEqual(result.plugins[0].name, 'Alpha Plugin');
		assert.strictEqual(result.plugins[0].groups.length, 2);
		assert.strictEqual(result.plugins[0].groups[0].items[0].name, 'summarize');
	});

	test('builds install payload with selected plugins', () => {
		const payload = buildInstallPayload(
			[
				{
					id: 'alpha',
					name: 'Alpha Plugin',
					version: '1.2.3',
					groups: [],
					sourceUrl: 'https://marketplace.example/marketplace.json',
					marketplaceDocumentUrl: 'https://marketplace.example/marketplace.json',
					downloadUrl: 'https://example.com/alpha.tgz',
					raw: {}
				}
			],
			'workspace',
			'd:/repo/.copilot/installed-plugins',
			['https://marketplace.example/marketplace.json']
		);

		assert.strictEqual(payload.version, 'v1');
		assert.strictEqual(payload.operation, 'installOrUpdate');
		assert.strictEqual(payload.scope, 'workspace');
		assert.strictEqual(payload.plugins.length, 1);
		assert.strictEqual(payload.marketplaceUrls.length, 1);
	});

	test('resolves relative marketplace document references', () => {
		const result = resolveMarketplaceDocumentReference(
			'../.github/plugin/marketplace.json',
			'https://raw.githubusercontent.com/dotnet/skills/main/.claude-plugin/marketplace.json'
		);

		assert.strictEqual(
			result,
			'https://raw.githubusercontent.com/dotnet/skills/main/.github/plugin/marketplace.json'
		);
	});

	test('resolves absolute marketplace document references', () => {
		const result = resolveMarketplaceDocumentReference(
			'https://example.com/marketplace.json',
			'https://raw.githubusercontent.com/dotnet/skills/main/.claude-plugin/marketplace.json'
		);

		assert.strictEqual(result, 'https://example.com/marketplace.json');
	});

	test('resolves plain text redirect references', () => {
		const result = resolveMarketplaceDocumentReference(
			'../.github/plugin/marketplace.json\n',
			'https://raw.githubusercontent.com/dotnet/skills/main/.claude-plugin/marketplace.json'
		);

		assert.strictEqual(
			result,
			'https://raw.githubusercontent.com/dotnet/skills/main/.github/plugin/marketplace.json'
		);
	});

	test('normalizes hooks, mcp, and lsp groups', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'spec-plugin',
						name: 'Spec Plugin',
						hooks: './hooks.json',
						mcpServers: './.mcp.json',
						lspServers: './lsp.json'
					}
				]
			},
			'https://example.com/marketplace.json'
		);

		const groups = result.plugins[0].groups.map((group) => group.key).sort();
		assert.deepStrictEqual(groups, ['hooks', 'lsp', 'mcp']);
	});

	test('normalizes inline mcpServers object as installable item', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'inline-config-plugin',
						name: 'Inline Config Plugin',
						mcpServers: {
							myServer: {
								command: 'node',
								args: ['server.js']
							}
						}
					}
				]
			},
			'https://example.com/marketplace.json'
		);

		const mcpGroup = result.plugins[0].groups.find((group) => group.key === 'mcp');
		assert.ok(mcpGroup);
		assert.strictEqual(mcpGroup?.items.length, 1);
		assert.strictEqual(mcpGroup?.items[0].name, 'mcp');
		assert.ok(typeof mcpGroup?.items[0].inlineContent === 'object');
	});

	test('treats mcpServers file path as direct file metadata URL', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'file-config-plugin',
						name: 'File Config Plugin',
						mcpServers: './.mcp.json'
					}
				]
			},
			'https://example.com/marketplace.json',
			'https://raw.githubusercontent.com/org/repo/main/.github/plugin/marketplace.json'
		);

		const mcpGroup = result.plugins[0].groups.find((group) => group.key === 'mcp');
		assert.ok(mcpGroup);
		assert.strictEqual(
			mcpGroup?.items[0].metadataUrl,
			'https://raw.githubusercontent.com/org/repo/main/.mcp.json'
		);
	});

	test('returns inline group item content as formatted JSON', async () => {
		const result = await fetchGroupItemContent({
			name: 'mcp',
			metadataFallbackUrls: [],
			inlineContent: { myServer: { command: 'node' } }
		});

		assert.ok(result.content);
		assert.ok(result.content?.includes('"myServer"'));
	});

	test('detects curated skill profile directory', () => {
		const profiles = getSupportedSkillProfileDirectories([
			{ type: 'dir', name: '.curated' },
			{ type: 'dir', name: '.system' },
			{ type: 'dir', name: 'doc' },
			{ type: 'file', name: 'README.md' }
		]);

		assert.deepStrictEqual(profiles, ['.curated']);
	});

	test('returns no supported profiles when curated is absent', () => {
		const profiles = getSupportedSkillProfileDirectories([
			{ type: 'dir', name: '.system' },
			{ type: 'dir', name: '.experimental' }
		]);

		assert.deepStrictEqual(profiles, []);
	});
});
