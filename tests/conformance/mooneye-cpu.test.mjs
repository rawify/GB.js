import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { testDataManifest } from '../../scripts/test-data-manifest.mjs';
import {
    DMGBus,
    SM83CPU,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;
const suiteRoot = testDataManifest.inventories.mooneye.path.replace(/^roms\//u, '');
const acceptanceSignature = [3, 5, 8, 13, 21, 34];
const failureSignature = [0x42, 0x42, 0x42, 0x42, 0x42, 0x42];
const instructionLimits = new Map([
    ['acceptance/ppu/intr_2_mode0_timing_sprites.gb', 2_000_000],
]);
const testROMs = [
    'acceptance/bits/mem_oam.gb',
    'acceptance/bits/reg_f.gb',
    'acceptance/instr/daa.gb',
    'acceptance/oam_dma_restart.gb',
    'acceptance/oam_dma_start.gb',
    'acceptance/oam_dma_timing.gb',
    'acceptance/oam_dma/basic.gb',
    'acceptance/oam_dma/reg_read.gb',
    'acceptance/oam_dma/sources-GS.gb',
    'acceptance/ppu/hblank_ly_scx_timing-GS.gb',
    'acceptance/ppu/intr_2_0_timing.gb',
    'acceptance/ppu/intr_2_mode0_timing.gb',
    'acceptance/ppu/intr_2_mode0_timing_sprites.gb',
    'acceptance/ppu/intr_2_mode3_timing.gb',
    'acceptance/ppu/intr_2_oam_ok_timing.gb',
    'acceptance/ppu/lcdon_timing-GS.gb',
    'acceptance/ppu/lcdon_write_timing-GS.gb',
    'acceptance/ppu/stat_irq_blocking.gb',
    'acceptance/ppu/stat_lyc_onoff.gb',
    'acceptance/ppu/vblank_stat_intr-GS.gb',
    'acceptance/timer/div_write.gb',
    'acceptance/timer/rapid_toggle.gb',
    'acceptance/timer/tim00.gb',
    'acceptance/timer/tim00_div_trigger.gb',
    'acceptance/timer/tim01.gb',
    'acceptance/timer/tim01_div_trigger.gb',
    'acceptance/timer/tim10.gb',
    'acceptance/timer/tim10_div_trigger.gb',
    'acceptance/timer/tim11.gb',
    'acceptance/timer/tim11_div_trigger.gb',
    'acceptance/timer/tima_reload.gb',
    'acceptance/timer/tima_write_reloading.gb',
    'acceptance/timer/tma_write_reloading.gb',
];

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

for (const relativePath of testROMs) {
    test(`Mooneye ${relativePath} reaches the acceptance signature`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        const path = join(testROMDirectory, suiteRoot, relativePath);
        const rom = new Uint8Array(await readFile(path));
        const bus = new DMGBus({ cartridge: createGameBoyCartridge(rom) });
        const cpu = new SM83CPU(bus);
        const instructionLimit = instructionLimits.get(relativePath) ?? 1_000_000;
        let instructions = 0;

        cpu.registers.af = 0x01b0;
        cpu.registers.bc = 0x0013;
        cpu.registers.de = 0x00d8;
        cpu.registers.hl = 0x014d;
        cpu.registers.sp = 0xfffe;
        cpu.registers.pc = 0x0100;
        bus.write(0xff40, 0x91);

        while (instructions < instructionLimit && !isTerminalSignature(registerSignature(cpu))) {
            cpu.step();
            instructions++;
        }

        assert.equal(cpu.isLocked, false);
        assert.ok(instructions < instructionLimit, `${relativePath} exceeded instruction limit`);
        assert.deepEqual(registerSignature(cpu), acceptanceSignature);
    });
}
