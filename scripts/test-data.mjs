import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { testDataManifest } from './test-data-manifest.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(projectRoot, 'test-data');

async function exists(path) {

    try {
        await stat(path);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }

        throw error;
    }
}

async function hashFile(path, algorithm = 'sha256') {

    return createHash(algorithm).update(await readFile(path)).digest('hex');
}

async function run(command, arguments_, options = {}) {

    try {
        return await execFileAsync(command, arguments_, {
            cwd: projectRoot,
            maxBuffer: 16 * 1024 * 1024,
            ...options,
        });
    } catch (error) {
        const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;

        throw new Error(`${command} failed: ${detail}`, { cause: error });
    }
}

async function download(entry) {

    const destination = join(dataRoot, entry.path);

    if (await exists(destination) && await hashFile(destination) === entry.sha256) {
        console.log(`verified ${entry.name}`);
        return;
    }

    const response = await fetch(entry.url, { redirect: 'follow' });

    if (!response.ok) {
        throw new Error(`Download failed for ${entry.name}: HTTP ${response.status}`);
    }

    const temporary = `${destination}.download`;

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));

    const actual = await hashFile(temporary);

    if (actual !== entry.sha256) {
        await rm(temporary, { force: true });
        throw new Error(`SHA-256 mismatch for ${entry.name}: ${actual}`);
    }

    await rename(temporary, destination);
    console.log(`downloaded ${entry.name}`);
}

async function checkout(source) {

    const destination = join(dataRoot, source.path);

    if (!await exists(join(destination, '.git'))) {
        await mkdir(dirname(destination), { recursive: true });
        await run('git', ['clone', '--quiet', source.repository, destination]);
        await run('git', ['-C', destination, 'checkout', '--quiet', source.revision]);
    }

    await verifyCheckout(source);
}

async function verifyCheckout(source) {

    const destination = join(dataRoot, source.path);

    if (!await exists(join(destination, '.git'))) {
        throw new Error(`Missing ${source.name} source; run npm run data:fetch.`);
    }

    const { stdout } = await run('git', ['-C', destination, 'rev-parse', 'HEAD']);

    if (stdout.trim() !== source.revision) {
        throw new Error(`${source.name} is at ${stdout.trim()}, expected ${source.revision}`);
    }

    console.log(`verified ${source.name} source`);
}

async function collectFiles(root, extension, current = root) {

    const entries = await readdir(current, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {

        const path = join(current, entry.name);

        if (entry.isDirectory()) {
            return collectFiles(root, extension, path);
        }

        return entry.name.endsWith(extension) ? [path] : [];
    }));

    return files.flat().sort();
}

async function hashInventory(root, extension) {

    const files = await collectFiles(root, extension);
    const hash = createHash('sha256');

    for (const path of files) {
        hash.update(relative(root, path));
        hash.update('\0');
        hash.update(await readFile(path));
        hash.update('\0');
    }

    return {
        count: files.length,
        files,
        sha256: hash.digest('hex'),
    };
}

async function verifyInventory(name, inventory, root = dataRoot) {

    const path = join(root, inventory.path);
    const actual = await hashInventory(path, inventory.extension);

    if (actual.count !== inventory.count || actual.sha256 !== inventory.sha256) {
        throw new Error(
            `${name} inventory mismatch: ${actual.count} files, SHA-256 ${actual.sha256}`,
        );
    }

    console.log(`verified ${name}: ${actual.count} ROMs`);
    return actual;
}

async function copyInventory(sourceRoot, destinationRoot, extension) {

    const files = await collectFiles(sourceRoot, extension);

    await rm(destinationRoot, { force: true, recursive: true });

    for (const source of files) {
        const destination = join(destinationRoot, relative(sourceRoot, source));

        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
    }
}

async function fetchData() {

    await mkdir(dataRoot, { recursive: true });

    for (const entry of testDataManifest.downloads) {
        await download(entry);
    }

    const mooneye = testDataManifest.inventories.mooneye;
    const mooneyeRoot = join(dataRoot, mooneye.path);

    if (!await exists(mooneyeRoot)) {
        const archive = join(dataRoot, testDataManifest.downloads[0].path);
        const destination = join(dataRoot, 'roms/mooneye');

        await rm(destination, { force: true, recursive: true });
        await mkdir(destination, { recursive: true });
        await run('unzip', ['-q', archive, '-d', destination]);
    }

    await verifyInventory('Mooneye', mooneye);

    for (const source of testDataManifest.sources) {
        await checkout(source);
    }
}

async function buildData() {

    const sameSuiteSource = join(dataRoot, 'sources/samesuite');
    const sameBoySource = join(dataRoot, 'sources/sameboy');
    const mgbaSource = join(dataRoot, 'sources/mgba-suite');

    for (const source of testDataManifest.sources) {
        await verifyCheckout(source);
    }

    await run('make', ['-C', sameSuiteSource]);
    await copyInventory(sameSuiteSource, join(dataRoot, 'roms/samesuite'), '.gb');

    await run('make', ['-C', sameBoySource, 'bootroms']);

    const bootSource = join(sameBoySource, 'build/bin/BootROMs');
    const bootDestination = join(dataRoot, 'bios/free/sameboy');

    await rm(bootDestination, { force: true, recursive: true });
    await mkdir(bootDestination, { recursive: true });

    for (const [file] of testDataManifest.freeBootROMs) {
        await copyFile(join(bootSource, file), join(bootDestination, file));
    }

    const suite = join(mgbaSource, 'suite.gba');

    if (!await exists(suite)) {
        if (process.env.DEVKITARM !== undefined) {
            await run('make', ['-C', mgbaSource]);
        } else {
            try {
                await run('docker', ['info']);
            } catch (error) {
                throw new Error(
                    'Building suite.gba requires DEVKITARM or a running Docker daemon.',
                    { cause: error },
                );
            }

            await run('docker', [
                'run',
                '--rm',
                '-v',
                `${mgbaSource}:/root/suite`,
                '-w',
                '/root/suite',
                testDataManifest.devkitARMImage,
                'make',
            ]);
        }
    }

    await copyFile(suite, join(dataRoot, 'roms/mgba-suite.gba'));
    await verifyGeneratedData();
    console.log('built and normalized free test data');
}

async function verifyGeneratedData() {

    await verifyInventory('SameSuite', testDataManifest.inventories.samesuite);

    for (const [file, expected] of testDataManifest.freeBootROMs) {
        const actual = await hashFile(join(dataRoot, 'bios/free/sameboy', file));

        if (actual !== expected) {
            throw new Error(`${file} SHA-256 mismatch: ${actual}`);
        }
    }

    const suite = testDataManifest.mgbaSuite;
    const suitePath = join(dataRoot, suite.path);
    const metadata = await stat(suitePath);
    const actual = await hashFile(suitePath);

    if (metadata.size !== suite.size || actual !== suite.sha256) {
        throw new Error(`mGBA suite mismatch: ${metadata.size} bytes, SHA-256 ${actual}`);
    }

    console.log('verified generated ROMs and free boot ROMs');
}

async function verifyData() {

    for (const entry of testDataManifest.downloads) {
        const actual = await hashFile(join(dataRoot, entry.path));

        if (actual !== entry.sha256) {
            throw new Error(`${entry.name} SHA-256 mismatch: ${actual}`);
        }

        console.log(`verified ${entry.name}`);
    }

    for (const source of testDataManifest.sources) {
        await verifyCheckout(source);
    }

    await verifyInventory('Mooneye', testDataManifest.inventories.mooneye);
    await verifyGeneratedData();

    for (const [model, descriptor] of Object.entries(testDataManifest.originalBIOS)) {
        const path = join(dataRoot, 'bios/original', descriptor.file);

        if (await exists(path)) {
            await verifyOriginalBIOS(model, path);
        }
    }

    console.log('all local test data is valid');
}

async function verifyOriginalBIOS(model, path) {

    const descriptor = testDataManifest.originalBIOS[model];

    if (descriptor === undefined) {
        throw new Error(`Unknown BIOS model ${model}.`);
    }

    const metadata = await stat(path);
    const md5 = await hashFile(path, 'md5');

    if (metadata.size !== descriptor.size || md5 !== descriptor.md5) {
        throw new Error(
            `${model} BIOS is not a known original dump: ${metadata.size} bytes, MD5 ${md5}`,
        );
    }

    console.log(`verified original ${model} BIOS`);
}

async function importBIOS(model, source) {

    const descriptor = testDataManifest.originalBIOS[model];

    if (descriptor === undefined || source === undefined) {
        const models = Object.keys(testDataManifest.originalBIOS).join(', ');

        throw new Error(`Usage: npm run data:bios -- <model> <file>; models: ${models}`);
    }

    const sourcePath = resolve(projectRoot, source);

    await verifyOriginalBIOS(model, sourcePath);

    const destination = join(dataRoot, 'bios/original', descriptor.file);

    await mkdir(dirname(destination), { recursive: true });

    if (sourcePath !== destination) {
        await copyFile(sourcePath, destination);
    }

    console.log(`imported ${model} BIOS to ${relative(projectRoot, destination)}`);
}

async function main() {

    const [command, ...arguments_] = process.argv.slice(2);

    switch (command) {
        case 'fetch':
            await fetchData();
            break;
        case 'build':
            await buildData();
            break;
        case 'verify':
            await verifyData();
            break;
        case 'bios':
            await importBIOS(arguments_[0], arguments_[1]);
            break;
        default:
            throw new Error('Usage: node scripts/test-data.mjs <fetch|build|verify|bios>');
    }
}

await main();
