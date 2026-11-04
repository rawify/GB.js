import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageMetadata = JSON.parse(await readFile('package.json', 'utf8'));
const banner = {
    js: `/**
 * @license GB.js v${packageMetadata.version}
 * https://github.com/rawify/GB.js
 * Copyright (c) 2026 Robert Eisele
 * Licensed under the MIT license.
 */`,
};
const common = {
    bundle: true,
    target: ['es2022'],
    banner,
    sourcemap: true,
};
const entryPoints = {
    index: 'src/index.ts',
    gb: 'src/gb/index.ts',
    gba: 'src/gba/index.ts',
};

await rm('dist', { force: true, recursive: true });
await execFileAsync('tsc', ['--emitDeclarationOnly']);

await Promise.all([
    ...Object.entries(entryPoints).flatMap(([name, entryPoint]) => [
        build({
            ...common,
            entryPoints: [entryPoint],
            format: 'esm',
            outfile: `dist/${name}.mjs`,
        }),
        build({
            ...common,
            entryPoints: [entryPoint],
            format: 'cjs',
            outfile: `dist/${name}.cjs`,
        }),
    ]),
    build({
        ...common,
        entryPoints: [entryPoints.index],
        format: 'iife',
        globalName: 'GBJS',
        minify: true,
        outfile: 'dist/gb.min.js',
    }),
]);
