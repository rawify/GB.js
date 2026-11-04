import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { testDataManifest } from '../../scripts/test-data-manifest.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;

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

async function assertInventory(name, inventory) {

    const root = join(testROMDirectory, inventory.path.replace(/^roms\//u, ''));
    const files = await collectFiles(root, inventory.extension);
    const hash = createHash('sha256');

    for (const path of files) {
        hash.update(relative(root, path));
        hash.update('\0');
        hash.update(await readFile(path));
        hash.update('\0');
    }

    assert.equal(files.length, inventory.count, `${name} ROM count`);
    assert.equal(hash.digest('hex'), inventory.sha256, `${name} inventory hash`);
}

test('Mooneye inventory is exact', {
    skip: testROMDirectory === undefined,
}, async () => {

    await assertInventory('Mooneye', testDataManifest.inventories.mooneye);
});

test('SameSuite inventory is exact', {
    skip: testROMDirectory === undefined,
}, async () => {

    await assertInventory('SameSuite', testDataManifest.inventories.samesuite);
});

test('Acid2 ROMs match official releases', {
    skip: testROMDirectory === undefined,
}, async () => {

    for (const entry of testDataManifest.downloads.slice(1)) {
        const path = join(testROMDirectory, entry.path.replace(/^roms\//u, ''));
        const hash = createHash('sha256').update(await readFile(path)).digest('hex');

        assert.equal(hash, entry.sha256, entry.name);
    }
});

test('mGBA suite is available', {
    skip: testROMDirectory === undefined,
}, async () => {

    const suite = testDataManifest.mgbaSuite;
    const path = join(testROMDirectory, suite.path.replace(/^roms\//u, ''));
    const metadata = await stat(path);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');

    assert.equal(metadata.size, suite.size);
    assert.equal(hash, suite.sha256);
});
