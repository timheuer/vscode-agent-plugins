import { fetchWithGitHubAuth } from './github-auth';
import { getLogger } from './logger';

export interface MarketplacePlugin {
	id: string;
	name: string;
	description?: string;
	version?: string;
	downloadUrl?: string;
	groups: MarketplacePluginGroup[];
	sourceUrl: string;
	marketplaceDocumentUrl: string;
	raw: Record<string, unknown>;
}

export interface MarketplacePluginGroup {
	name: string;
	key: string;
	items: MarketplaceGroupItem[];
}

export interface MarketplaceGroupItem {
	name: string;
	path?: string;
	metadataUrl?: string;
	metadataFallbackUrls: string[];
	docUrl?: string;
	description?: string;
}

export interface MarketplaceFetchResult {
	plugins: MarketplacePlugin[];
	warnings: string[];
	errors: string[];
}

interface RepoContext {
	owner: string;
	repo: string;
	branch: string;
	rawBaseUrl: string;
	blobBaseUrl: string;
}

interface RepoContentEntry {
	type?: string;
	name?: string;
	path?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as UnknownRecord;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeRelativePath(value: string): string {
	return value.replace(/^\.\//, '').replace(/^\//, '');
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function candidateMarketplaceUrls(inputUrl: string): string[] {
	const candidates = new Set<string>();

	try {
		const parsed = new URL(inputUrl);
		const hostname = parsed.hostname.toLowerCase();
		if (!/^https?:$/i.test(parsed.protocol)) {
			candidates.add(inputUrl);
			return Array.from(candidates);
		}

		if (hostname === 'github.com' || hostname === 'www.github.com') {
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (parts.length >= 2) {
				const owner = parts[0];
				const repo = parts[1].replace(/\.git$/i, '');
				if (parts.length >= 5 && parts[2] === 'blob') {
					const branch = parts[3];
					const remainder = parts.slice(4).join('/');
					candidates.add(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${remainder}`);
					return Array.from(candidates);
				} else {
					// Try .claude-plugin first, then fall back to .github/plugin
					candidates.add(`https://raw.githubusercontent.com/${owner}/${repo}/main/.claude-plugin/marketplace.json`);
					candidates.add(`https://raw.githubusercontent.com/${owner}/${repo}/master/.claude-plugin/marketplace.json`);
					candidates.add(`https://raw.githubusercontent.com/${owner}/${repo}/main/.github/plugin/marketplace.json`);
					candidates.add(`https://raw.githubusercontent.com/${owner}/${repo}/master/.github/plugin/marketplace.json`);
					return Array.from(candidates);
				}
			}
		}

		const hasFileName = /\.[a-z0-9]+$/i.test(parsed.pathname);
		candidates.add(inputUrl);
		if (!hasFileName && !parsed.pathname.endsWith('/marketplace.json')) {
			const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
			candidates.add(`${parsed.origin}${pathname}.claude-plugin/marketplace.json`);
			candidates.add(`${parsed.origin}${pathname}.github/plugin/marketplace.json`);
		}
	} catch {
		candidates.add(inputUrl);
		return Array.from(candidates);
	}

	return Array.from(candidates);
}

function isGitHubUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		return hostname === 'github.com' ||
			hostname === 'www.github.com' ||
			hostname === 'raw.githubusercontent.com' ||
			hostname === 'api.github.com';
	} catch {
		return false;
	}
}

/**
 * Fetch wrapper that uses GitHub authentication for GitHub URLs.
 * Falls back to regular fetch for non-GitHub URLs.
 */
async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
	if (isGitHubUrl(url)) {
		return fetchWithGitHubAuth(url, options);
	}
	return fetch(url, options);
}

async function resolveMarketplaceUrl(inputUrl: string): Promise<{ documentUrl?: string; warnings: string[]; errors: string[] }> {
	const warnings: string[] = [];
	const candidates = candidateMarketplaceUrls(inputUrl);

	for (const candidate of candidates) {
		try {
			const response = await authenticatedFetch(candidate, { method: 'GET' });
			if (response.ok) {
				return { documentUrl: candidate, warnings: [], errors: [] };
			}
			warnings.push(`Marketplace candidate failed (${response.status}): ${candidate}`);
		} catch (error) {
			warnings.push(`Marketplace candidate unreachable: ${candidate} (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	return {
		warnings,
		errors: [`Could not resolve marketplace document from '${inputUrl}'.`]
	};
}

function repoContextFromDocumentUrl(documentUrl: string): RepoContext | undefined {
	const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//i.exec(documentUrl);
	if (!match) {
		return undefined;
	}

	const owner = match[1];
	const repo = match[2];
	const branch = match[3];
	return {
		owner,
		repo,
		branch,
		rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`,
		blobBaseUrl: `https://github.com/${owner}/${repo}/blob/${branch}`
	};
}

function encodePath(pathValue: string): string {
	return pathValue
		.split('/')
		.filter(Boolean)
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

async function listRepoDirectory(repoContext: RepoContext, relativePath: string): Promise<RepoContentEntry[] | undefined> {
	const encodedPath = encodePath(relativePath);
	const url = `https://api.github.com/repos/${repoContext.owner}/${repoContext.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repoContext.branch)}`;

	try {
		// Use authenticated fetch for GitHub API - required for private repos and SAML/SSO
		const response = await authenticatedFetch(url, {
			headers: {
				'User-Agent': 'vscode-agent-plugins',
				'Accept': 'application/vnd.github+json'
			}
		});

		if (!response.ok) {
			return undefined;
		}

		const payload = (await response.json()) as unknown;
		if (!Array.isArray(payload)) {
			return undefined;
		}

		return payload.filter((entry): entry is RepoContentEntry => Boolean(asRecord(entry)));
	} catch {
		return undefined;
	}
}

async function expandGroupDirectoryReference(
	referencePath: string,
	groupKey: string,
	repoContext: RepoContext
): Promise<MarketplaceGroupItem[] | undefined> {
	const cleanedPath = normalizeRelativePath(referencePath).replace(/\/+$/, '');
	if (!cleanedPath) {
		return undefined;
	}

	const entries = await listRepoDirectory(repoContext, cleanedPath);
	if (!entries || entries.length === 0) {
		return undefined;
	}

	const directoryEntries = entries.filter((entry) => entry.type === 'dir' && typeof entry.name === 'string');
	if (directoryEntries.length > 0) {
		return directoryEntries.map((entry) => {
			const item = buildItemFromPath(`${cleanedPath}/${entry.name ?? ''}`, groupKey, repoContext);
			return {
				...item,
				name: entry.name ?? item.name
			};
		});
	}

	const markdownFiles = entries.filter(
		(entry) => entry.type === 'file' && typeof entry.name === 'string' && /\.md$/i.test(entry.name)
	);
	if (markdownFiles.length > 0) {
		return markdownFiles.map((entry) => {
			const item = buildItemFromPath(`${cleanedPath}/${entry.name ?? ''}`, groupKey, repoContext);
			return {
				...item,
				name: entry.name ?? item.name
			};
		});
	}

	return undefined;
}

function summaryFromRecord(record: UnknownRecord): string | undefined {
	return asString(record.name) ?? asString(record.id) ?? asString(record.slug) ?? asString(record.title);
}

function descriptorDefaultsForGroup(groupKey: string): string[] {
	switch (groupKey) {
		case 'skills':
			return ['SKILL.md', 'README.md'];
		case 'agents':
			return ['AGENT.md', 'AGENTS.md', 'README.md'];
		default:
			return ['README.md'];
	}
}

function buildItemFromPath(pathValue: string, groupKey: string, repoContext?: RepoContext): MarketplaceGroupItem {
	const cleanedPath = normalizeRelativePath(pathValue);
	const descriptorFiles = descriptorDefaultsForGroup(groupKey);

	if (!repoContext || isHttpUrl(cleanedPath)) {
		return {
			name: cleanedPath,
			path: cleanedPath,
			metadataUrl: isHttpUrl(cleanedPath) ? cleanedPath : undefined,
			metadataFallbackUrls: [],
			docUrl: isHttpUrl(cleanedPath) ? cleanedPath : undefined
		};
	}

	const isMarkdownPath = /\.md$/i.test(cleanedPath);
	if (isMarkdownPath) {
		return {
			name: cleanedPath,
			path: cleanedPath,
			metadataUrl: `${repoContext.rawBaseUrl}/${cleanedPath}`,
			metadataFallbackUrls: [],
			docUrl: `${repoContext.blobBaseUrl}/${cleanedPath}`
		};
	}

	const metadataCandidates = descriptorFiles.map((fileName) => `${repoContext.rawBaseUrl}/${cleanedPath}/${fileName}`);
	const docCandidate = `${repoContext.blobBaseUrl}/${cleanedPath}/${descriptorFiles[0]}`;

	return {
		name: cleanedPath,
		path: cleanedPath,
		metadataUrl: metadataCandidates[0],
		metadataFallbackUrls: metadataCandidates.slice(1),
		docUrl: docCandidate
	};
}

function buildGroupItem(entry: unknown, groupKey: string, repoContext?: RepoContext): MarketplaceGroupItem | undefined {
	if (typeof entry === 'string') {
		return buildItemFromPath(entry, groupKey, repoContext);
	}

	const record = asRecord(entry);
	if (!record) {
		return undefined;
	}

	const pathValue = asString(record.path) ?? asString(record.source) ?? asString(record.url);
	if (pathValue) {
		const base = buildItemFromPath(pathValue, groupKey, repoContext);
		return {
			...base,
			name: summaryFromRecord(record) ?? base.name,
			description: asString(record.description) ?? base.description
		};
	}

	const name = summaryFromRecord(record);
	if (!name) {
		return undefined;
	}

	return {
		name,
		metadataFallbackUrls: [],
		description: asString(record.description)
	};
}

function toGroupItems(value: unknown, groupKey: string, repoContext?: RepoContext): MarketplaceGroupItem[] {
	if (Array.isArray(value)) {
		return value
			.map((entry) => buildGroupItem(entry, groupKey, repoContext))
			.filter((entry): entry is MarketplaceGroupItem => Boolean(entry));
	}

	const record = asRecord(value);
	if (!record) {
		return [];
	}

	const items: MarketplaceGroupItem[] = [];
	for (const [key, entryValue] of Object.entries(record)) {
		const item = buildGroupItem(entryValue, groupKey, repoContext);
		if (item) {
			items.push(item);
			continue;
		}

		items.push({
			name: key,
			metadataFallbackUrls: []
		});
	}

	return items;
}

function mergeGroupItems(primary: MarketplaceGroupItem[], secondary: MarketplaceGroupItem[]): MarketplaceGroupItem[] {
	const deduped = new Map<string, MarketplaceGroupItem>();
	for (const item of [...primary, ...secondary]) {
		const key = item.name.toLowerCase();
		if (!deduped.has(key)) {
			deduped.set(key, item);
		}
	}

	return Array.from(deduped.values());
}

function collectGroupValues(record: UnknownRecord, key: string, repoContext?: RepoContext): MarketplaceGroupItem[] {
	const manifest = asRecord(record.manifest);
	const primary = toGroupItems(record[key], key, repoContext);
	const secondary = toGroupItems(manifest?.[key], key, repoContext);
	return mergeGroupItems(primary, secondary);
}

function extractPluginGroups(record: UnknownRecord, repoContext?: RepoContext): MarketplacePluginGroup[] {
	const groupDefinitions = [
		{ key: 'skills', name: 'Skills' },
		{ key: 'agents', name: 'Agents' },
		{ key: 'commands', name: 'Commands' },
		{ key: 'tools', name: 'Tools' },
		{ key: 'prompts', name: 'Prompts' },
		{ key: 'workflows', name: 'Workflows' }
	];

	const groups: MarketplacePluginGroup[] = [];
	for (const definition of groupDefinitions) {
		const items = collectGroupValues(record, definition.key, repoContext);
		if (items.length > 0) {
			groups.push({
				name: definition.name,
				key: definition.key,
				items
			});
		}
	}

	return groups;
}

async function fetchPluginSourceConfig(sourcePath: string, repoContext: RepoContext): Promise<UnknownRecord | undefined> {
	const cleanedSource = normalizeRelativePath(sourcePath).replace(/\/+$/, '');
	const basePath = cleanedSource.length > 0 ? cleanedSource : '';
	const candidates = [
		`${repoContext.rawBaseUrl}/${basePath ? `${basePath}/` : ''}.claude-plugin/plugin.json`,
		`${repoContext.rawBaseUrl}/${basePath ? `${basePath}/` : ''}.github/plugin/plugin.json`,
		`${repoContext.rawBaseUrl}/${basePath ? `${basePath}/` : ''}plugin.json`
	];

	getLogger()?.trace(`Fetching plugin config for source="${sourcePath}", trying: ${candidates.join(', ')}`);

	for (const candidate of candidates) {
		try {
			const response = await authenticatedFetch(candidate);
			getLogger()?.trace(`${candidate} => ${response.status}`);
			if (!response.ok) {
				continue;
			}

			const payload = (await response.json()) as unknown;
			const record = asRecord(payload);
			if (record) {
				getLogger()?.trace(`Found plugin config at ${candidate}, keys: ${JSON.stringify(Object.keys(record))}`);
				return record;
			}
		} catch (err) {
			getLogger()?.trace(`${candidate} => error: ${err}`);
			continue;
		}
	}

	getLogger()?.trace(`No plugin config found for source="${sourcePath}"`);
	return undefined;
}

async function resolveGroupItemsFromConfig(
	value: unknown,
	groupKey: string,
	repoContext: RepoContext,
	sourceBasePath?: string
): Promise<MarketplaceGroupItem[]> {
	// Helper to prepend source base path to relative paths
	const resolvePath = (pathValue: string): string => {
		if (isHttpUrl(pathValue) || !sourceBasePath) {
			return pathValue;
		}
		const normalizedPath = normalizeRelativePath(pathValue);
		const normalizedBase = normalizeRelativePath(sourceBasePath).replace(/\/+$/, '');
		return normalizedBase ? `${normalizedBase}/${normalizedPath}` : normalizedPath;
	};

	if (typeof value === 'string') {
		const resolvedPath = resolvePath(value);
		const expanded = await expandGroupDirectoryReference(resolvedPath, groupKey, repoContext);
		if (expanded && expanded.length > 0) {
			return expanded;
		}

		return [buildItemFromPath(resolvedPath, groupKey, repoContext)];
	}

	// Handle array of strings or objects
	if (Array.isArray(value)) {
		const items: MarketplaceGroupItem[] = [];
		for (const entry of value) {
			if (typeof entry === 'string') {
				const resolvedPath = resolvePath(entry);
				const expanded = await expandGroupDirectoryReference(resolvedPath, groupKey, repoContext);
				if (expanded && expanded.length > 0) {
					items.push(...expanded);
				} else {
					items.push(buildItemFromPath(resolvedPath, groupKey, repoContext));
				}
			} else {
				const record = asRecord(entry);
				if (record) {
					const pathValue = asString(record.path) ?? asString(record.source) ?? asString(record.url);
					if (pathValue) {
						const resolvedPath = resolvePath(pathValue);
						const base = buildItemFromPath(resolvedPath, groupKey, repoContext);
						items.push({
							...base,
							name: summaryFromRecord(record) ?? base.name,
							description: asString(record.description) ?? base.description
						});
					} else {
						const name = summaryFromRecord(record);
						if (name) {
							items.push({
								name,
								metadataFallbackUrls: [],
								description: asString(record.description)
							});
						}
					}
				}
			}
		}
		return items;
	}

	return toGroupItems(value, groupKey, repoContext);
}

async function hydratePluginGroupsFromSource(
	plugin: MarketplacePlugin,
	repoContext?: RepoContext
): Promise<MarketplacePlugin> {
	getLogger()?.trace(`hydratePluginGroupsFromSource: plugin="${plugin.name}", groups.length=${plugin.groups.length}, hasRepoContext=${!!repoContext}, source="${plugin.raw.source}"`);

	if (!repoContext || plugin.groups.length > 0) {
		getLogger()?.trace(`Skipping hydration: repoContext=${!!repoContext}, groups.length=${plugin.groups.length}`);
		return plugin;
	}

	const source = asString(plugin.raw.source) ?? './';
	const sourceConfig = await fetchPluginSourceConfig(source, repoContext);

	// Source base path for resolving relative paths within the plugin
	const sourceBasePath = normalizeRelativePath(source).replace(/\/+$/, '');

	// If no config found, still try auto-discovery of standard directories
	if (!sourceConfig) {
		getLogger()?.trace(`No sourceConfig found for "${plugin.name}", trying auto-discovery`);
	}

	// Check both top-level and manifest-wrapped values (like extractPluginGroups does)
	const manifest = sourceConfig ? asRecord(sourceConfig.manifest) : undefined;
	if (sourceConfig) {
		getLogger()?.trace(`sourceConfig keys for "${plugin.name}": ${JSON.stringify(Object.keys(sourceConfig))}, manifest keys: ${manifest ? JSON.stringify(Object.keys(manifest)) : 'none'}`);
	}

	const groupDefinitions = [
		{ key: 'skills', name: 'Skills' },
		{ key: 'agents', name: 'Agents' },
		{ key: 'commands', name: 'Commands' },
		{ key: 'tools', name: 'Tools' },
		{ key: 'prompts', name: 'Prompts' },
		{ key: 'workflows', name: 'Workflows' }
	];

	const hydratedGroups: MarketplacePluginGroup[] = [];
	for (const definition of groupDefinitions) {
		// Check top-level first, then manifest (if sourceConfig exists)
		const groupValue = sourceConfig?.[definition.key] ?? manifest?.[definition.key];

		// Auto-discover: if not defined, try convention-based directory (e.g., "skills/", "agents/")
		if (typeof groupValue === 'undefined') {
			// Try to discover by checking if the directory exists
			const conventionPath = sourceBasePath ? `${sourceBasePath}/${definition.key}` : definition.key;
			const discovered = await expandGroupDirectoryReference(conventionPath, definition.key, repoContext);
			if (discovered && discovered.length > 0) {
				getLogger()?.trace(`Auto-discovered ${definition.key}/ directory for "${plugin.name}" at ${conventionPath}`);
				hydratedGroups.push({
					name: definition.name,
					key: definition.key,
					items: discovered
				});
			}
			continue;
		}

		const items = await resolveGroupItemsFromConfig(groupValue, definition.key, repoContext, sourceBasePath);
		if (items.length > 0) {
			hydratedGroups.push({
				name: definition.name,
				key: definition.key,
				items
			});
		}
	}

	getLogger()?.trace(`hydratedGroups for "${plugin.name}": ${hydratedGroups.map(g => `${g.name}(${g.items.length})`).join(', ')}`);

	if (hydratedGroups.length === 0) {
		return plugin;
	}

	return {
		...plugin,
		groups: hydratedGroups
	};
}

function getPluginList(document: unknown): unknown[] {
	if (Array.isArray(document)) {
		return document;
	}

	const record = asRecord(document);
	if (!record) {
		return [];
	}

	const candidateKeys = ['plugins', 'items', 'extensions'];
	for (const key of candidateKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			return value;
		}
	}

	return [];
}

function normalizePlugin(
	entry: unknown,
	sourceUrl: string,
	marketplaceDocumentUrl: string,
	repoContext?: RepoContext
): { plugin?: MarketplacePlugin; warning?: string } {
	const record = asRecord(entry);
	if (!record) {
		return { warning: `Skipped non-object plugin entry from ${sourceUrl}.` };
	}

	const id = asString(record.id) ?? asString(record.slug) ?? asString(record.name);
	if (!id) {
		return { warning: `Skipped plugin entry without id/name in ${sourceUrl}.` };
	}

	const name = asString(record.name) ?? id;
	const description = asString(record.description);
	const version =
		asString(record.version) ??
		asString(record.latestVersion) ??
		asString(asRecord(record.manifest)?.version) ??
		'unknown';
	const downloadUrl =
		asString(record.downloadUrl) ?? asString(record.url) ?? asString(asRecord(record.package)?.url);
	const groups = extractPluginGroups(record, repoContext);

	return {
		plugin: {
			id,
			name,
			description,
			version,
			downloadUrl,
			groups,
			sourceUrl,
			marketplaceDocumentUrl,
			raw: record
		}
	};
}

export function normalizeMarketplaceDocument(
	document: unknown,
	sourceUrl: string,
	marketplaceDocumentUrl: string = sourceUrl,
	repoContext?: RepoContext
): MarketplaceFetchResult {
	const entries = getPluginList(document);
	const warnings: string[] = [];
	const plugins: MarketplacePlugin[] = [];

	if (entries.length === 0) {
		warnings.push(`No plugin entries found in ${sourceUrl}.`);
	}

	for (const entry of entries) {
		const normalized = normalizePlugin(entry, sourceUrl, marketplaceDocumentUrl, repoContext);
		if (normalized.warning) {
			warnings.push(normalized.warning);
		}
		if (normalized.plugin) {
			plugins.push(normalized.plugin);
		}
	}

	return {
		plugins,
		warnings,
		errors: []
	};
}

export async function fetchMarketplace(sourceUrl: string): Promise<MarketplaceFetchResult> {
	const resolution = await resolveMarketplaceUrl(sourceUrl);
	if (!resolution.documentUrl) {
		return {
			plugins: [],
			warnings: resolution.warnings,
			errors: resolution.errors
		};
	}

	try {
		const response = await authenticatedFetch(resolution.documentUrl);
		if (!response.ok) {
			return {
				plugins: [],
				warnings: resolution.warnings,
				errors: [`Failed to fetch ${resolution.documentUrl}: ${response.status} ${response.statusText}`]
			};
		}

		const json = (await response.json()) as unknown;
		const repoContext = repoContextFromDocumentUrl(resolution.documentUrl);
		const normalized = normalizeMarketplaceDocument(json, sourceUrl, resolution.documentUrl, repoContext);

		if (repoContext && normalized.plugins.length > 0) {
			const hydratedPlugins: MarketplacePlugin[] = [];
			for (const plugin of normalized.plugins) {
				hydratedPlugins.push(await hydratePluginGroupsFromSource(plugin, repoContext));
			}
			normalized.plugins = hydratedPlugins;
		}

		normalized.warnings.unshift(...resolution.warnings);
		return normalized;
	} catch (error) {
		return {
			plugins: [],
			warnings: resolution.warnings,
			errors: [
				`Failed to fetch ${resolution.documentUrl}: ${error instanceof Error ? error.message : String(error)}`
			]
		};
	}
}

export async function fetchAllMarketplaces(urls: string[]): Promise<MarketplaceFetchResult> {
	const aggregate: MarketplaceFetchResult = {
		plugins: [],
		warnings: [],
		errors: []
	};

	const results = await Promise.allSettled(urls.map(url => fetchMarketplace(url)));

	for (const result of results) {
		if (result.status === 'fulfilled') {
			aggregate.plugins.push(...result.value.plugins);
			aggregate.warnings.push(...result.value.warnings);
			aggregate.errors.push(...result.value.errors);
		} else {
			aggregate.errors.push(`Marketplace fetch failed: ${result.reason}`);
		}
	}

	const deduped = new Map<string, MarketplacePlugin>();
	for (const plugin of aggregate.plugins) {
		const key = `${plugin.id}::${plugin.sourceUrl}`;
		if (!deduped.has(key)) {
			deduped.set(key, plugin);
		}
	}

	aggregate.plugins = Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
	return aggregate;
}

function extractDescriptorSummary(markdown: string): string | undefined {
	const lines = markdown.split(/\r?\n/);
	const trimmedStart = lines.findIndex((line) => line.trim().length > 0);
	if (trimmedStart >= 0 && lines[trimmedStart].trim() === '---') {
		for (let index = trimmedStart + 1; index < lines.length; index += 1) {
			const line = lines[index].trim();
			if (line === '---') {
				break;
			}

			const descriptionMatch = /^description\s*:\s*(.+)$/i.exec(line);
			if (descriptionMatch) {
				return descriptionMatch[1].trim().replace(/^['"]|['"]$/g, '');
			}

			const summaryMatch = /^summary\s*:\s*(.+)$/i.exec(line);
			if (summaryMatch) {
				return summaryMatch[1].trim().replace(/^['"]|['"]$/g, '');
			}
		}
	}

	let inCodeBlock = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (
			inCodeBlock ||
			line.length === 0 ||
			line.startsWith('#') ||
			line === '---' ||
			line === '***'
		) {
			continue;
		}

		return line;
	}

	return undefined;
}

export async function fetchGroupItemDescription(item: MarketplaceGroupItem): Promise<string | undefined> {
	const urls = [item.metadataUrl, ...item.metadataFallbackUrls].filter((entry): entry is string => Boolean(entry));
	for (const url of urls) {
		try {
			const response = await authenticatedFetch(url);
			if (!response.ok) {
				continue;
			}
			const content = await response.text();
			const summary = extractDescriptorSummary(content);
			if (summary) {
				return summary;
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

export async function fetchGroupItemContent(item: MarketplaceGroupItem): Promise<{ content?: string; url?: string }> {
	const urls = [item.metadataUrl, ...item.metadataFallbackUrls].filter((entry): entry is string => Boolean(entry));
	for (const url of urls) {
		try {
			const response = await authenticatedFetch(url);
			if (!response.ok) {
				continue;
			}
			const content = await response.text();
			return { content, url };
		} catch {
			continue;
		}
	}

	return {};
}
