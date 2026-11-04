import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    DMGBus,
    SM83CPU,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;

function hexVector(value) {

    return value.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16));
}

async function runSameSuiteVector(relativePath, model, expected, options = {}) {

    const {
        instructionLimit = 1_000_000,
        resultOffset = 0,
        ...busOptions
    } = options;
    const rom = new Uint8Array(await readFile(join(
        testROMDirectory,
        'samesuite/apu',
        relativePath,
    )));
    const bus = new DMGBus({
        model,
        cartridge: createGameBoyCartridge(rom),
        ...busOptions,
    });
    const cpu = new SM83CPU(bus);

    cpu.registers.af = model === 'cgb' ? 0x1180 : 0x01b0;
    cpu.registers.bc = 0;
    cpu.registers.de = model === 'cgb' ? 0xff56 : 0;
    cpu.registers.hl = model === 'cgb' ? 0x000d : 0x014d;
    cpu.registers.sp = 0xfffe;
    cpu.registers.pc = 0x0100;

    if (model === 'cgb') {
        bus.write(0xff40, 0x91);
    }

    let instructions = 0;

    while (instructions < instructionLimit) {
        cpu.step();
        instructions++;

        if (expected.every((value, index) => bus.wram[resultOffset + index] === value)) {
            break;
        }
    }

    assert.equal(cpu.isLocked, false);
    assert.ok(instructions < instructionLimit, `${relativePath} exceeded instruction limit`);
    assert.deepEqual([
        ...bus.wram.slice(resultOffset, resultOffset + expected.length),
    ], expected);
}

test('SameSuite permits wave RAM access while the channel is inactive', {
    skip: testROMDirectory === undefined,
}, async () => {

    const pattern = Array.from({ length: 16 }, (_, index) => index * 0x11);

    await runSameSuiteVector('channel_3/channel_3_wave_ram_dac_on_rw.gb', 'dmg', [
        ...pattern,
        ...pattern,
        0x00, 0x11, 0x45, 0x33, 0x44, 0x2a, 0x66, 0x77,
        0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0x04, 0xff,
    ]);
});

test('SameSuite synchronizes active CGB wave RAM reads with PCM34', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector('channel_3/channel_3_wave_ram_sync.gb', 'cgb', [
        0x00, 0x00, 0x00, 0x02, 0x02, 0x02, 0x02, 0x03,
        0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x34,
    ]);
});

test('SameSuite aligns active DMG wave RAM writes with the fetch window', {
    skip: testROMDirectory === undefined,
}, async () => {

    const initialWaveRAM = Array.from({ length: 16 }, (_, index) => index * 0x11);
    const expected = Array.from({ length: 9 }, (_, fetchedByte) => {

        const waveRAM = [...initialWaveRAM];

        waveRAM[fetchedByte] = 0x2a;

        return waveRAM;
    }).flat();

    await runSameSuiteVector(
        'channel_3/channel_3_wave_ram_locked_write.gb',
        'dmg',
        expected,
    );
});

test('SameSuite preserves the CGB wave restart delay', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector('channel_3/channel_3_restart_during_delay.gb', 'cgb', [
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x02, 0x02, 0x02, 0x02, 0x03,
        0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12,
        0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x34,
    ]);
});

for (const channel of [1, 2]) {
    const sample = channel === 1 ? 0x08 : 0x80;
    const alignedStart = [
        ...Array(13).fill(0), ...Array(3).fill(sample),
        ...Array(12).fill(0), ...Array(4).fill(sample),
        ...Array(12).fill(0), ...Array(4).fill(sample),
    ];
    const powerAlignedStart = Array.from(
        { length: 3 },
        () => [...Array(13).fill(0), ...Array(3).fill(sample)],
    ).flat();

    test(`SameSuite aligns CGB-E channel ${channel} starts to sub-instruction phases`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        await runSameSuiteVector(
            `channel_${channel}/channel_${channel}_align.gb`,
            'cgb',
            alignedStart,
            { cgbRevision: 'e' },
        );
    });

    test(`SameSuite aligns CGB-E channel ${channel} starts to the APU power phase`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        await runSameSuiteVector(
            `channel_${channel}/channel_${channel}_align_cpu.gb`,
            'cgb',
            powerAlignedStart,
            { cgbRevision: 'e' },
        );
    });
}

const pulseFrequencyWriteVector = hexVector(`
    00 00 00 00 00 00 00 00  00 00 08 08 08 08 08 08
    00 00 00 00 00 00 00 00  00 08 08 08 08 08 08 08
    00 00 00 00 00 00 00 00  08 08 08 08 08 08 08 08
    00 00 00 00 00 00 00 08  08 08 08 08 08 08 08 00
    00 00 00 00 00 00 08 08  08 08 00 00 00 00 08 08
    00 00 00 00 00 08 08 08  08 00 00 00 00 08 08 08
    00 00 00 00 08 08 08 08  00 00 00 00 08 08 08 08
    00 00 00 08 08 08 08 00  00 00 00 08 08 08 08 00
`);

for (const channel of [1, 2]) {
    test(`SameSuite applies active channel ${channel} frequency writes after the current sample`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        const expected = channel === 1
            ? pulseFrequencyWriteVector
            : pulseFrequencyWriteVector.map((value) => value << 4);

        await runSameSuiteVector(
            `channel_${channel}/channel_${channel}_freq_change.gb`,
            'cgb',
            expected,
            { cgbRevision: 'e' },
        );
    });
}

test('SameSuite aligns the CGB-E noise startup counter', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_4/channel_4_delay.gb',
        'cgb',
        [
            0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0,
            0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0,
            0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0,
            0x00, 0x00, 0x00, 0x00, 0xf0, 0xf0, 0xf0, 0xf0,
        ],
        { cgbRevision: 'e' },
    );
});

test('SameSuite changes the active CGB-E noise frequency', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_4/channel_4_freq_change.gb',
        'cgb',
        [
            0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00,
            0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00,
            0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        { cgbRevision: 'e' },
    );
});

test('SameSuite aligns CGB-E noise polynomial frequencies to counter phases', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_4/channel_4_frequency_alignment.gb',
        'cgb',
        hexVector(`
            00 00 00 f0 f0 f0 f0 f0  00 00 f0 f0 f0 f0 f0 f0
            00 00 00 f0 f0 f0 f0 f0  00 00 00 00 f0 f0 f0 f0
            00 00 00 00 00 f0 f0 f0  00 00 00 f0 f0 f0 f0 f0
            00 00 00 f0 f0 f0 f0 f0  00 00 00 00 00 f0 f0 f0
            00 00 00 00 f0 f0 f0 f0  00 00 f0 f0 f0 f0 f0 f0
            00 00 f0 f0 f0 f0 f0 f0  00 00 00 00 f0 f0 f0 f0
            00 00 00 00 f0 f0 f0 f0  00 00 00 00 00 00 f0 f0
            00 00 00 00 f0 f0 f0 f0  00 00 00 00 f0 f0 f0 f0
            00 00 00 00 f0 f0 f0 f0
        `),
        { cgbRevision: 'e' },
    );
});

const noisePolynomialVectors = {
    '15-bit to 7-bit': hexVector(`
        f0 f0 f0 f0 00 00 f0 f0  f0 f0 00 f0 00 f0 f0 f0
        00 00 00 00 f0 f0 00 f0  f0 f0 00 f0 00 00 f0 f0
        f0 f0 00 f0 00 00 f0 f0  00 00 00 f0 00 f0 00 f0
        f0 00 00 00 00 00 f0 00  f0 f0 f0 f0 00 00 00 f0
        f0 f0 00 f0 f0 00 f0 f0  00 00 f0 00 00 f0 00 f0
        00 00 f0 00 00 00 00 f0  00 00 f0 f0 f0 00 00 f0
        00 f0 f0 00 f0 00 00 00  f0 00 00 00 f0 f0 00 00
        f0 f0 00 f0 00 f0 00 f0  00 00 00 00 00 00 00 f0
    `),
    '7-bit to 15-bit': hexVector(`
        f0 00 00 00 f0 f0 f0 f0  f0 00 00 00 f0 f0 f0 00
        f0 f0 00 f0 f0 f0 f0 00  f0 f0 00 f0 f0 00 00 f0
        f0 f0 00 f0 f0 00 00 f0  00 00 f0 f0 f0 00 00 f0
        00 00 f0 00 f0 00 00 f0  00 f0 f0 00 f0 00 00 f0
        00 00 00 00 f0 00 00 00  f0 00 00 00 f0 00 00 f0
        f0 f0 00 00 f0 f0 00 00  f0 f0 00 00 f0 00 f0 f0
        00 f0 00 f0 00 f0 00 f0  00 f0 00 00 00 f0 00 00
        00 00 00 00 00 00 00 00  00 f0 f0 00 00 f0 f0 f0
    `),
};

for (const [transition, expected] of Object.entries(noisePolynomialVectors)) {
    test(`SameSuite preserves the CGB-E noise polynomial on ${transition}`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        const file = transition.startsWith('15')
            ? 'channel_4_lfsr_15_7.gb'
            : 'channel_4_lfsr_7_15.gb';

        await runSameSuiteVector(
            `channel_4/${file}`,
            'cgb',
            expected,
            { cgbRevision: 'e' },
        );
    });
}

test('SameBoy applies the CGB0-C NR43 intermediate-write glitches', {
    skip: testROMDirectory === undefined,
}, async () => {

    const expected = Array(64).fill(0);

    expected[0] = 0xf0;
    expected[1] = 0xf0;
    expected[16] = 0xf0;

    await runSameSuiteVector(
        'channel_4/channel_4_freq_change.gb',
        'cgb',
        expected,
        { cgbRevision: 'c' },
    );
});

test('SameSuite clears the CGB-E noise LFSR on a fast restart', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_4/channel_4_lfsr_restart_fast.gb',
        'cgb',
        [
            0x7c, 0x7e, 0x3f, 0x5f, 0x6f, 0x77, 0x7b, 0x7d,
            0x3e, 0x1f, 0x4f, 0x67, 0x73, 0x79, 0x3c, 0x5e,
        ],
        { cgbRevision: 'e', resultOffset: 6 },
    );
});

test('SameSuite clears the CGB-E noise polynomial on restart', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_4/channel_4_lfsr_restart.gb',
        'cgb',
        hexVector(`
            7c 7e 3f 5f 6f 77 7b 7d  3e 1f 4f 67 73 79 3c 5e
            2f 57 6b 75 3a 1d 0e 07  43 61 30 58 6c 76 3b 5d
            2e 17 4b 65 32 19 0c 46  23 51 28 54 6a 35 1a 0d
            06 03 41 20 50 68 74 7a  3d 1e 0f 47 63 71 38 5c
            6e 37 5b 6d 36 1b 4d 26  13 49 24 52 29 14 4a 25
            12 09 04 42 21 10 48 64  72 39 1c 4e 27 53 69 34
            5a 2d 16 0b 45 22 11 08  44 62 31 18 4c 66 33 59
            2c 56 2b 55 2a 15 0a 05  02 01 00 40 60 70 78 7c
        `),
        { cgbRevision: 'e', resultOffset: 6 },
    );
});

for (const channel of [1, 2]) {
    test(`SameSuite applies the CGB-E channel ${channel} NRx2 write glitch`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        const expected = channel === 1
            ? [
                0x02, 0x01, 0x02, 0x03, 0x0d, 0x0f, 0x0c, 0x0f,
                0x02, 0x01, 0x01, 0x02, 0x0d, 0x0e, 0x0c, 0x0d,
            ]
            : [
                0x20, 0x10, 0x20, 0x30, 0xd0, 0xf0, 0xc0, 0xf0,
                0x20, 0x10, 0x10, 0x20, 0xd0, 0xe0, 0xc0, 0xd0,
            ];

        await runSameSuiteVector(
            `channel_${channel}/channel_${channel}_nrx2_glitch.gb`,
            'cgb',
            expected,
            { cgbRevision: 'e' },
        );
    });

    test(`SameSuite changes the active CGB-E channel ${channel} envelope speed`, {
        skip: testROMDirectory === undefined,
    }, async () => {

        const expected = channel === 1
            ? [
                0x00, 0x01, 0x01, 0x02, 0x02, 0x03, 0x03, 0x04,
                0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
                0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
                0x01, 0x02, 0x03, 0x03, 0x04, 0x04, 0x05, 0x05,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
                0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x03,
                0x01, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
                0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03,
            ]
            : [
                0x00, 0x10, 0x10, 0x20, 0x20, 0x30, 0x30, 0x40,
                0x00, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60,
                0x10, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90,
                0x10, 0x20, 0x30, 0x30, 0x40, 0x40, 0x50, 0x50,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x10, 0x10, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
                0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x30, 0x30,
                0x10, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
                0x20, 0x20, 0x20, 0x20, 0x20, 0x30, 0x30, 0x30,
            ];

        await runSameSuiteVector(
            `channel_${channel}/channel_${channel}_nrx2_speed_change.gb`,
            'cgb',
            expected,
            { cgbRevision: 'e', instructionLimit: 3_000_000 },
        );
    });
}

test('SameSuite preserves the CGB-E channel 1 startup delay', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_delay.gb',
        'cgb',
        [
            0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00,
            0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00,
            0x00, 0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
            0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x00, 0x00,
        ],
        { cgbRevision: 'e' },
    );
});

test('SameSuite preserves CGB-E pulse restart timing after an NRx2 glitch', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_restart_nrx2_glitch.gb',
        'cgb',
        [...Array(15).fill(0x02), 0x00],
        { cgbRevision: 'e' },
    );
});

test('SameSuite preserves CGB0-C pulse frequency writes in double speed', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_freq_change_timing-cgb0BC.gb',
        'cgb',
        [
            0x00, 0x00, 0x00, 0x0f, 0x0f, 0xff, 0xff, 0xf0,
            0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f,
        ],
        { cgbRevision: 'c' },
    );
});

test('SameSuite preserves CGB-D/E pulse frequency writes in double speed', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_freq_change_timing-cgbDE.gb',
        'cgb',
        [
            0x00, 0x00, 0x00, 0x0f, 0xff, 0xff, 0xff, 0xf0,
            0x00, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0x0f, 0xff,
        ],
        { cgbRevision: 'e' },
    );
});

test('SameSuite delays the CGB-E channel 1 second sweep overflow check', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_sweep.gb',
        'cgb',
        [
            ...Array(16).fill(0x08),
            ...Array(16).fill(0x00),
        ],
        {
            cgbRevision: 'e',
            instructionLimit: 5_000_000,
            resultOffset: 112,
        },
    );
});

test('SameSuite preserves CGB-E channel 1 sweep restart state', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_sweep_restart.gb',
        'cgb',
        [
            ...Array(7).fill(0xf1),
            ...Array(9).fill(0xf0),
            ...Array(16).fill(0xf1),
            ...Array(5).fill(0xf1),
            ...Array(11).fill(0xf0),
            ...Array(5).fill(0xf1),
            ...Array(11).fill(0xf0),
        ],
        {
            cgbRevision: 'e',
            instructionLimit: 5_000_000,
            resultOffset: 80,
        },
    );
});

test('SameSuite preserves CGB-E channel 1 sweep restart hold', {
    skip: testROMDirectory === undefined,
}, async () => {

    await runSameSuiteVector(
        'channel_1/channel_1_sweep_restart_2.gb',
        'cgb',
        [
            0xf1, 0xf1,
            ...Array(14).fill(0xf0),
            ...Array(112).fill(0xf1),
        ],
        { cgbRevision: 'e', instructionLimit: 5_000_000 },
    );
});
