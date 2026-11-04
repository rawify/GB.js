import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
    DMGBus,
    SM83CPU,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;
const bootROMPath = process.env.GAMEBOY_DMG_BOOT_ROM
    ?? (testROMDirectory === undefined
        ? undefined
        : resolve(testROMDirectory, '../bios/original/dmg_boot.bin'));
const testDataAvailable = testROMDirectory !== undefined
    && bootROMPath !== undefined
    && existsSync(bootROMPath)
    && existsSync(join(testROMDirectory, 'dmg-acid2.gb'));

test('renders the official dmg-acid2 reference frame', {
    skip: !testDataAvailable,
}, async () => {

    const bootROM = new Uint8Array(await readFile(bootROMPath));
    const rom = new Uint8Array(await readFile(join(testROMDirectory, 'dmg-acid2.gb')));
    const bus = new DMGBus({
        bootROM,
        cartridge: createGameBoyCartridge(rom),
    });
    const cpu = new SM83CPU(bus);

    for (let instructions = 0; instructions < 3_000_000; instructions++) {
        cpu.step();
    }

    const shades = Uint8Array.from(bus.frame.pixels, (pixel) => pixel & 0xff);
    const frameHash = createHash('sha256').update(shades).digest('hex');

    assert.equal(frameHash, 'cb26ef6174cd5b61662c2e74f2bdb2b0f8da0750234c75144c3a4d258fda8347');
});
