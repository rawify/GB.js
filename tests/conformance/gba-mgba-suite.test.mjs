import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { testDataManifest } from '../../scripts/test-data-manifest.mjs';
import {
    GAME_BOY_ADVANCE_CYCLES_PER_FRAME,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

const testROMDirectory = process.env.GAMEBOY_TEST_ROMS;
const bootROMPath = process.env.GAMEBOY_GBA_BOOT_ROM
    ?? (testROMDirectory === undefined
        ? undefined
        : join(testROMDirectory, '../bios/original/gba_bios.bin'));
const suitePath = testROMDirectory === undefined
    ? undefined
    : join(testROMDirectory, testDataManifest.mgbaSuite.path.replace(/^roms\//u, ''));
const testDataAvailable = suitePath !== undefined
    && bootROMPath !== undefined
    && existsSync(suitePath)
    && existsSync(bootROMPath);
const suiteHeader = 'Game Boy Advance Test Suite\n===\n';
const activeInfoMagic = Uint8Array.of(0x49, 0x6e, 0x66, 0x6f);
const suites = [
    { failureLimit: 224, index: 0, name: 'Memory tests' },
    { failureLimit: 92, index: 1, name: 'I/O read tests' },
    { failureLimit: 1_616, index: 2, name: 'Timing tests' },
    { failureLimit: 402, index: 3, name: 'Timer count-up tests' },
    { failureLimit: 90, index: 4, name: 'Timer IRQ tests' },
    { failureLimit: 8, index: 5, name: 'Shifter tests' },
    { failureLimit: 0, index: 6, name: 'Carry tests' },
    { failureLimit: 20, index: 7, name: 'Multiply long tests' },
    { failureLimit: 0, index: 8, name: 'BIOS math tests' },
    { failureLimit: 0, index: 9, name: 'DMA tests' },
    { failureLimit: 0, index: 10, name: 'SIO register R/W tests' },
    { failureLimit: 0, index: 11, name: 'SIO timing tests' },
    { failureLimit: 10, index: 12, name: 'Misc. edge case tests' },
];

function runFrame(system) {

    system.runCycles(GAME_BOY_ADVANCE_CYCLES_PER_FRAME);
}

function saveLog(system) {

    const data = system.bus.save?.dump();

    assert.ok(data, 'mGBA Suite did not expose SRAM');

    const terminator = data.indexOf(0);
    const end = terminator < 0 ? data.length : terminator;

    return new TextDecoder().decode(data.subarray(0, end));
}

function findActiveInfo(system) {

    const memory = system.bus.iwram;

    for (let offset = 0; offset <= memory.length - 8; offset += 4) {
        if (activeInfoMagic.every((value, index) => memory[offset + index] === value)) {
            return offset;
        }
    }

    return undefined;
}

function readActiveInfo(system, offset) {

    const memory = system.bus.iwram;

    return {
        subtest: (memory[offset + 4] ?? 0) | ((memory[offset + 5] ?? 0) << 8),
        test: memory[offset + 6] ?? 0,
        suite: memory[offset + 7] ?? 0,
    };
}

function findSuiteResult(system, name) {

    const memory = system.bus.iwram;
    const prefix = new TextEncoder().encode(name.slice(0, 20));

    for (let offset = 0; offset <= memory.length - 32; offset++) {
        if (!prefix.every((value, index) => memory[offset + index] === value)) {
            continue;
        }

        const result = new TextDecoder().decode(memory.subarray(offset + 21, offset + 31));
        const match = /^\s*(\d+)\/\s*(\d+)/u.exec(result);

        if (match !== null) {
            return {
                passes: Number(match[1]),
                total: Number(match[2]),
            };
        }
    }

    return undefined;
}

function runUntil(system, maximumFrames, predicate, message) {

    for (let frames = 1; frames <= maximumFrames; frames++) {
        runFrame(system);

        if (predicate()) {
            return frames;
        }
    }

    assert.fail(`${message} after ${maximumFrames} frames`);
}

function pressButton(system, button) {

    system.setButton(button, true);
    runFrame(system);
    system.setButton(button, false);
    runFrame(system);
}

async function runSuite(suite) {

    assert.ok(suitePath);
    assert.ok(bootROMPath);

    const [rom, bootROM] = await Promise.all([
        readFile(suitePath),
        readFile(bootROMPath),
    ]);
    const system = new GameBoyAdvanceSystem({
        bootROM: new Uint8Array(bootROM),
        rom: new Uint8Array(rom),
    });
    let activeInfoOffset;
    const bootFrames = runUntil(system, 600, () => {

        activeInfoOffset ??= findActiveInfo(system);

        return activeInfoOffset !== undefined && saveLog(system).startsWith(suiteHeader);
    }, 'mGBA Suite did not reach its menu');

    assert.notEqual(activeInfoOffset, undefined);
    for (let index = 0; index < suite.index; index++) {
        pressButton(system, 'down');
    }
    pressButton(system, 'a');

    let suiteResult;
    const runFrames = runUntil(system, 3_000, () => {

        const active = readActiveInfo(system, activeInfoOffset);

        suiteResult = active.suite === suite.index
            ? findSuiteResult(system, suite.name)
            : undefined;

        return suiteResult !== undefined;
    }, `mGBA ${suite.name} did not complete`);
    const log = saveLog(system);
    const failures = log.split('\n').filter((line) => line.includes('FAIL'));

    assert.ok(suiteResult);

    return { ...suiteResult, bootFrames, failures, log, runFrames };
}

for (const suite of suites) {
    test(`mGBA ${suite.name} completes within its failure baseline`, {
        skip: !testDataAvailable,
    }, async (context) => {

        const result = await runSuite(suite);
        const failedResults = result.total - result.passes;

        context.diagnostic(
            `mGBA ${suite.name}: ${result.passes}/${result.total}, `
            + `${result.failures.length} failures logged, ${result.runFrames} frames`,
        );
        assert.ok(result.log.startsWith(suiteHeader));
        assert.ok(
            failedResults <= suite.failureLimit,
            `mGBA ${suite.name} failure count exceeded baseline:\n${result.failures.slice(0, 8).join('\n')}`,
        );
        assert.ok(result.passes <= result.total);
        assert.ok(result.bootFrames <= 600);
    });
}

test('mGBA Video tests are manual visual comparisons', {
    skip: 'The upstream suite exposes no automated result counters for video tests.',
}, () => {});
