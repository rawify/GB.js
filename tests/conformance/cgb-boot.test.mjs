import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { testDataManifest } from '../../scripts/test-data-manifest.mjs';
import {
    DMGBus,
    SM83CPU,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;
const mooneyeRoot = testDataManifest.inventories.mooneye.path.replace(/^roms\//u, '');
const cgbAcid2Path = testROMDirectory === undefined
    ? undefined
    : join(testROMDirectory, 'cgb-acid2.gbc');
const bootRegistersPath = testROMDirectory === undefined
    ? undefined
    : join(testROMDirectory, mooneyeRoot, 'misc/boot_regs-cgb.gb');
const bootHWIOPath = testROMDirectory === undefined
    ? undefined
    : join(testROMDirectory, mooneyeRoot, 'misc/boot_hwio-C.gb');
const unusedHWIOPath = testROMDirectory === undefined
    ? undefined
    : join(testROMDirectory, mooneyeRoot, 'misc/bits/unused_hwio-C.gb');
const freeBootROMDirectory = testROMDirectory === undefined
    ? undefined
    : resolve(testROMDirectory, '../bios/free/sameboy');
const originalBootROMDirectory = testROMDirectory === undefined
    ? undefined
    : resolve(testROMDirectory, '../bios/original');
const acceptanceSignature = [3, 5, 8, 13, 21, 34];
const failureSignature = [0x42, 0x42, 0x42, 0x42, 0x42, 0x42];
const instructionLimit = 3_000_000;
const freeBootROMs = [
    {
        label: 'SameBoy CGB0',
        revision: '0',
        path: freeBootROMDirectory === undefined
            ? undefined
            : join(freeBootROMDirectory, 'cgb0_boot.bin'),
    },
    {
        label: 'SameBoy CGB',
        revision: 'c',
        path: freeBootROMDirectory === undefined
            ? undefined
            : join(freeBootROMDirectory, 'cgb_boot.bin'),
    },
];
const originalBootROMs = [
    {
        label: 'original CGB0',
        revision: '0',
        path: process.env.GAMEBOY_CGB0_BOOT_ROM
            ?? (originalBootROMDirectory === undefined
                ? undefined
                : join(originalBootROMDirectory, 'cgb0_boot.bin')),
        divROM: 'misc/boot_div-cgb0.gb',
    },
    {
        label: 'original CGB',
        revision: 'c',
        path: process.env.GAMEBOY_CGB_BOOT_ROM
            ?? (originalBootROMDirectory === undefined
                ? undefined
                : join(originalBootROMDirectory, 'cgb_boot.bin')),
        divROM: 'misc/boot_div-cgbABCDE.gb',
    },
];

function pathsExist(...paths) {

    return paths.every((path) => path !== undefined && existsSync(path));
}

async function createSystem(bootROMPath, romPath, cgbRevision) {

    const [bootROM, rom] = await Promise.all([
        readFile(bootROMPath),
        readFile(romPath),
    ]);
    const bus = new DMGBus({
        model: 'cgb',
        cgbRevision,
        bootROM: new Uint8Array(bootROM),
        cartridge: createGameBoyCartridge(new Uint8Array(rom)),
    });

    return { bus, cpu: new SM83CPU(bus) };
}

function registerSignature(cpu) {

    return [
        cpu.registers.b,
        cpu.registers.c,
        cpu.registers.d,
        cpu.registers.e,
        cpu.registers.h,
        cpu.registers.l,
    ];
}

function isTerminalSignature(signature) {

    return signature.every((value, index) => value === acceptanceSignature[index])
        || signature.every((value, index) => value === failureSignature[index]);
}

async function assertBootHandoff(label, bootROMPath, cgbRevision) {

    const { bus, cpu } = await createSystem(bootROMPath, cgbAcid2Path, cgbRevision);
    let instructions = 0;

    while (instructions < instructionLimit && bus.isBootROMMapped && !cpu.isLocked) {
        cpu.step();
        instructions++;
    }

    assert.equal(cpu.isLocked, false);
    assert.equal(bus.isBootROMMapped, false, `${label} remained mapped`);
    assert.equal(cpu.registers.pc, 0x0100);
    assert.equal(cpu.registers.af, 0x1180);
    assert.equal(cpu.registers.bc, 0x0000);
    assert.equal(cpu.registers.de, 0xff56);
    assert.equal(cpu.registers.hl, 0x000d);
    assert.equal(cpu.registers.sp, 0xfffe);
    assert.equal(bus.isCGBMode, true);
    assert.ok(instructions < instructionLimit, `${label} exceeded instruction limit`);
}

async function assertMooneyeBootROM(label, bootROMPath, romPath, cgbRevision) {

    const { bus, cpu } = await createSystem(bootROMPath, romPath, cgbRevision);
    let instructions = 0;

    while (instructions < instructionLimit && !isTerminalSignature(registerSignature(cpu))) {
        cpu.step();
        instructions++;
    }

    assert.equal(cpu.isLocked, false);
    assert.equal(bus.isBootROMMapped, false, `${label} remained mapped`);
    assert.ok(instructions < instructionLimit, `${label} exceeded instruction limit`);
    assert.deepEqual(registerSignature(cpu), acceptanceSignature);
}

for (const bootROM of [...freeBootROMs, ...originalBootROMs]) {
    test(`${bootROM.label} boot ROM hands control to a CGB cartridge`, {
        skip: !pathsExist(bootROM.path, cgbAcid2Path),
    }, async () => {

        await assertBootHandoff(bootROM.label, bootROM.path, bootROM.revision);
    });

    test(`${bootROM.label} boot ROM matches Mooneye CGB registers`, {
        skip: !pathsExist(bootROM.path, bootRegistersPath),
    }, async () => {

        await assertMooneyeBootROM(
            bootROM.label,
            bootROM.path,
            bootRegistersPath,
            bootROM.revision,
        );
    });

    test(`${bootROM.label} boot ROM matches Mooneye CGB hardware IO`, {
        skip: !pathsExist(bootROM.path, bootHWIOPath),
    }, async () => {

        await assertMooneyeBootROM(bootROM.label, bootROM.path, bootHWIOPath, bootROM.revision);
    });

    test(`${bootROM.label} boot ROM matches Mooneye CGB unused hardware IO`, {
        skip: !pathsExist(bootROM.path, unusedHWIOPath),
    }, async () => {

        await assertMooneyeBootROM(
            bootROM.label,
            bootROM.path,
            unusedHWIOPath,
            bootROM.revision,
        );
    });
}

for (const bootROM of originalBootROMs) {
    const divROMPath = testROMDirectory === undefined
        ? undefined
        : join(testROMDirectory, mooneyeRoot, bootROM.divROM);

    test(`${bootROM.label} boot ROM matches Mooneye DIV value and phase`, {
        skip: !pathsExist(bootROM.path, divROMPath),
    }, async () => {

        await assertMooneyeBootROM(bootROM.label, bootROM.path, divROMPath, bootROM.revision);
    });
}

test('renders the official cgb-acid2 frame after a complete CGB boot', {
    skip: !pathsExist(freeBootROMs[1].path, cgbAcid2Path),
}, async () => {

    const { bus, cpu } = await createSystem(
        freeBootROMs[1].path,
        cgbAcid2Path,
        freeBootROMs[1].revision,
    );
    let bootInstructions = 0;

    while (bootInstructions < instructionLimit && bus.isBootROMMapped) {
        cpu.step();
        bootInstructions++;
    }

    assert.equal(bus.isBootROMMapped, false, 'CGB boot ROM remained mapped');

    for (let instructions = 0; instructions < instructionLimit; instructions++) {
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
