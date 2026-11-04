import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testROMDirectory = process.env.GAMEBOY_TEST_ROMS
    ?? resolve(projectRoot, 'test-data/roms');
const conformanceTestDirectory = resolve(projectRoot, 'tests/conformance');
const conformanceTests = (await readdir(conformanceTestDirectory))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => resolve(conformanceTestDirectory, name));

if (conformanceTests.length === 0) {
    throw new Error('No conformance test files found.');
}

const testProcess = spawn(
    process.execPath,
    ['--test', ...conformanceTests],
    {
        cwd: projectRoot,
        env: {
            ...process.env,
            GAMEBOY_TEST_ROMS: testROMDirectory,
        },
        stdio: 'inherit',
    },
);

testProcess.once('error', (error) => {

    console.error(error.message);

    process.exitCode = 1;
});

testProcess.once('exit', (code, signal) => {

    if (signal !== null) {
        console.error(`Conformance tests terminated by ${signal}.`);

        process.exitCode = 1;
        return;
    }

    process.exitCode = code ?? 1;
});
