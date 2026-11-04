import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
    GAME_BOY_ADVANCE_CLOCK_HZ,
    GAME_BOY_ADVANCE_CYCLES_PER_FRAME,
    GameBoyAdvanceSystem,
} from '../dist/gba.mjs';

const DEFAULT_FRAMES = 120;
const DEFAULT_WARMUP_FRAMES = 30;
const options = parseArguments(process.argv.slice(2));

if (options.rom === undefined) {
    console.error('Usage: npm run benchmark:gba -- <rom.gba> [--bios <bios.bin>] [--frames 120] [--warmup 30]');
    process.exitCode = 1;
} else {
    await benchmark(options);
}

async function benchmark({ rom, bios, frames, warmup }) {

    const romPath = resolve(rom);
    const romBytes = new Uint8Array(await readFile(romPath));
    const biosBytes = bios === undefined
        ? undefined
        : new Uint8Array(await readFile(resolve(bios)));
    const system = new GameBoyAdvanceSystem({
        rom: romBytes,
        ...(biosBytes === undefined ? {} : { bootROM: biosBytes }),
        audioSampleRate: 48_000,
        audioBufferCapacity: 4096,
    });

    runFrames(system, warmup);

    const start = performance.now();

    runFrames(system, frames);

    const elapsedSeconds = (performance.now() - start) / 1000;
    const framesPerSecond = frames / elapsedSeconds;
    const nativeFramesPerSecond = GAME_BOY_ADVANCE_CLOCK_HZ / GAME_BOY_ADVANCE_CYCLES_PER_FRAME;

    console.log(`ROM: ${basename(romPath)}`);
    console.log(`Warm-up: ${warmup} frames`);
    console.log(`Measured: ${frames} frames in ${elapsedSeconds.toFixed(3)} s`);
    console.log(`Speed: ${framesPerSecond.toFixed(2)} FPS (${(framesPerSecond / nativeFramesPerSecond * 100).toFixed(1)}% realtime)`);
}

function runFrames(system, frameCount) {

    const targetFrame = Math.floor(system.cycles / GAME_BOY_ADVANCE_CYCLES_PER_FRAME) + frameCount;

    while (Math.floor(system.cycles / GAME_BOY_ADVANCE_CYCLES_PER_FRAME) < targetFrame) {
        system.step();
    }
}

function parseArguments(args) {

    const parsed = {
        rom: undefined,
        bios: undefined,
        frames: DEFAULT_FRAMES,
        warmup: DEFAULT_WARMUP_FRAMES,
    };

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];

        if (argument === '--bios') {
            parsed.bios = requireValue(args, ++index, argument);
        } else if (argument === '--frames') {
            parsed.frames = parseFrameCount(requireValue(args, ++index, argument), argument);
        } else if (argument === '--warmup') {
            parsed.warmup = parseFrameCount(requireValue(args, ++index, argument), argument);
        } else if (argument?.startsWith('--')) {
            throw new TypeError(`Unknown option: ${argument}`);
        } else if (parsed.rom === undefined) {
            parsed.rom = argument;
        } else {
            throw new TypeError(`Unexpected argument: ${argument}`);
        }
    }

    return parsed;
}

function requireValue(args, index, option) {

    const value = args[index];

    if (value === undefined) {
        throw new TypeError(`${option} requires a value.`);
    }

    return value;
}

function parseFrameCount(value, option) {

    const frameCount = Number(value);

    if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
        throw new TypeError(`${option} must be a non-negative integer.`);
    }

    return frameCount;
}
