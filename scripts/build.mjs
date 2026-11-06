// Bundles the extension host entry and the two plain-Node proxy children.
// The children run under ELECTRON_RUN_AS_NODE with only Node built-ins plus the
// bundled http-proxy, outside the extension host, so VS Code's proxy resolver
// (http.proxySupport=override) cannot intercept their http.request.
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const targets = [
  { name: 'extension', entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { name: 'opencode-proxy', entryPoints: ['src/proxy/opencode-child.ts'], outfile: 'dist/opencode-proxy.js', external: [] },
  { name: 'coder-proxy', entryPoints: ['src/proxy/coder-child.ts'], outfile: 'dist/coder-proxy.js', external: [] },
];

const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all(targets.map((t) => context({ ...base, entryPoints: t.entryPoints, outfile: t.outfile, external: t.external })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  for (const t of targets) {
    await build({ ...base, entryPoints: t.entryPoints, outfile: t.outfile, external: t.external });
  }
}
