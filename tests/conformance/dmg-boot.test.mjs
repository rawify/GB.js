import assert from 'node:assert/strict';
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
const bootROMAvailable = bootROMPath !== undefined && existsSync(bootROMPath);

test('original DMG boot ROM hands control to the cartridge', {
    skip: testROMDirectory === undefined || !bootROMAvailable,
}, async () => {

    const bootROM = new Uint8Array(await readFile(bootROMPath));
    const rom = new Uint8Array(await readFile(join(testROMDirectory, 'dmg-acid2.gb')));
    const bus = new DMGBus({
        bootROM,
        cartridge: createGameBoyCartridge(rom),
    });
    const cpu = new SM83CPU(bus);
    const instructionLimit = 3_000_000;
    let instructions = 0;

    while (instructions < instructionLimit && bus.isBootROMMapped) {
        cpu.step();
        instructions++;
    }

    assert.equal(bus.isBootROMMapped, false, 'boot ROM remained mapped');
    assert.equal(cpu.registers.pc, 0x0100);
    assert.ok(instructions < instructionLimit, 'boot ROM exceeded instruction limit');
});
