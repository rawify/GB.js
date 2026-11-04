import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    DMGBus,
    SM83CPU,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;
const expectedBGPIResults = [0xc4, 0xc5, 0xc4, 0xc5, 0xc4, 0xc5, 0xc4, 0xc5];

function initializeCGBPostBoot(cpu, bus) {

    cpu.registers.af = 0x1180;
    cpu.registers.bc = 0x0000;
    cpu.registers.de = 0xff56;
    cpu.registers.hl = 0x000d;
    cpu.registers.sp = 0xfffe;
    cpu.registers.pc = 0x0100;
    bus.write(0xff40, 0x91);
}

test('SameSuite blocking_bgpi_increase matches the CGB result vector', {
    skip: testROMDirectory === undefined,
}, async () => {

    const path = join(testROMDirectory, 'samesuite/ppu/blocking_bgpi_increase.gb');
    const rom = new Uint8Array(await readFile(path));
    const bus = new DMGBus({
        model: 'cgb',
        cartridge: createGameBoyCartridge(rom),
    });
    const cpu = new SM83CPU(bus);
    let instructions = 0;

    initializeCGBPostBoot(cpu, bus);

    while (instructions < 1_000_000) {
        cpu.step();
        instructions++;

        if (expectedBGPIResults.every((value, index) => bus.wram[index] === value)) {
            break;
        }
    }

    assert.equal(cpu.isLocked, false);
    assert.ok(instructions < 1_000_000, 'blocking_bgpi_increase exceeded instruction limit');
    assert.deepEqual([...bus.wram.slice(0, 8)], expectedBGPIResults);
});

test('renders the official cgb-acid2 reference frame', {
    skip: testROMDirectory === undefined,
}, async () => {

    const rom = new Uint8Array(await readFile(join(testROMDirectory, 'cgb-acid2.gbc')));
    const bus = new DMGBus({
        model: 'cgb',
        cartridge: createGameBoyCartridge(rom),
    });
    const cpu = new SM83CPU(bus);

    initializeCGBPostBoot(cpu, bus);

    for (let instructions = 0; instructions < 3_000_000; instructions++) {
        cpu.step();
    }

    const pixels = Buffer.alloc(bus.frame.pixels.length * 3);

    bus.frame.pixels.forEach((pixel, index) => {

        pixels[index * 3] = pixel & 0xff;
        pixels[index * 3 + 1] = (pixel >> 8) & 0xff;
        pixels[index * 3 + 2] = (pixel >> 16) & 0xff;
    });

    const frameHash = createHash('sha256').update(pixels).digest('hex');

    assert.equal(frameHash, '9b9af43fcac8a79c231b3911163b15f8f21d240ad2ae9279735985da07ba8815');
});
