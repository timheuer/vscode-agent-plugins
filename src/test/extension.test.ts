import * as assert from 'assert';
import { buildInstallPayload } from '../features/delegation';
import { normalizeMarketplaceDocument } from '../features/marketplace';

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
});
