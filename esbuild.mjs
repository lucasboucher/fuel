import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['vscode', 'node:sqlite'],
  logLevel: 'info',
};

const configs = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    minify: !watch,
  },
  {
    ...shared,
    entryPoints: [
      'src/test/usage.test.ts',
      'src/test/poller.test.ts',
      'src/test/session.test.ts',
      'src/test/state.test.ts',
    ],
    outdir: 'dist/test',
    minify: false,
  },
];

const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
