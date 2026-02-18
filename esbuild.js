const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

function copyWebviewAssets() {
	const distDir = path.join(__dirname, 'dist');
	if (!fs.existsSync(distDir)) {
		fs.mkdirSync(distDir, { recursive: true });
	}

	// Copy vscode-elements bundled.js
	const vscodeElementsSrc = path.join(__dirname, 'node_modules', '@vscode-elements', 'elements', 'dist', 'bundled.js');
	fs.copyFileSync(vscodeElementsSrc, path.join(distDir, 'vscode-elements.js'));

	// Copy codicon CSS and font
	const codiconCssSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
	const codiconFontSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf');
	fs.copyFileSync(codiconCssSrc, path.join(distDir, 'codicon.css'));
	fs.copyFileSync(codiconFontSrc, path.join(distDir, 'codicon.ttf'));

	console.log('[build] copied webview assets to dist/');
}

async function main() {
	copyWebviewAssets();

	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
