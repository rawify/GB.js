import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_DMA_BASE_ADDRESS,
    GBA_FIFO_A_ADDRESS,
    GBA_FIFO_B_ADDRESS,
    GBA_SOUND_BIAS_ADDRESS,
    GBA_SOUND_CONTROL_HIGH_ADDRESS,
    GBA_SOUND_CONTROL_X_ADDRESS,
    GBAAPU,
    GBABus,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

function createAPU(options = {}) {

    const requests = [];
    const apu = new GBAAPU({
        requestSoundFIFO: (address) => requests.push(address),
    }, options);

    return { apu, requests };
}

describe('GBA APU', () => {

    it('masks Direct Sound control and resets both FIFOs', () => {

        const { apu } = createAPU();

        apu.writeFIFO(0, 0x7f);
        apu.writeFIFO(1, 0x80);
        apu.writeControlHigh(0xffff);

        assert.equal(apu.readControlHigh(), 0x770f);
        assert.equal(apu.fifoLevel(0), 0);
        assert.equal(apu.fifoLevel(1), 0);
        assert.equal(apu.readBias(), 0x0200);

        apu.writeControlX(0xffff);
        apu.writeBias(0xffff);

        assert.equal(apu.readControlX(), 0x80);
        assert.equal(apu.readBias(), 0xc3fe);
    });

    it('applies FIFO reset bits independently without latching them', () => {

        const { apu } = createAPU();

        apu.writeFIFO(0, 0x11);
        apu.writeFIFO(1, 0x22);
        apu.writeControlHigh(0x0800);

        assert.equal(apu.fifoLevel(0), 0);
        assert.equal(apu.fifoLevel(1), 1);
        assert.equal(apu.readControlHigh(), 0);

        apu.writeControlHigh(0x8000);

        assert.equal(apu.fifoLevel(1), 0);
        assert.equal(apu.readControlHigh(), 0);
    });

    it('preserves Direct Sound routing and FIFOs across master power-off', () => {

        const { apu } = createAPU();

        apu.writeControlX(0x80);
        apu.writeControlHigh(0x770f);
        apu.writeFIFO(0, 0x11);
        apu.writeFIFO(1, 0x22);
        apu.writeBias(0x4200);
        apu.writePSGByte(0x80, 0x77);
        apu.writeControlX(0);

        assert.equal(apu.readControlX(), 0);
        assert.equal(apu.readControlHigh(), 0x7700);
        assert.equal(apu.fifoLevel(0), 1);
        assert.equal(apu.fifoLevel(1), 1);
        assert.equal(apu.readBias(), 0x4200);
        assert.equal(apu.readPSGByte(0x80), 0);
    });

    it('consumes signed FIFO samples on the selected timers and requests DMA', () => {

        const { apu, requests } = createAPU();

        apu.writeControlHigh(0x4000);
        apu.writeFIFO(0, 0x7f);
        apu.writeFIFO(1, 0x80);
        apu.onTimerOverflow(0);

        assert.equal(apu.fifoSample(0), 0x7f);
        assert.equal(apu.fifoSample(1), 0);
        assert.deepEqual(requests, [0x040000a0]);

        apu.onTimerOverflow(1);

        assert.equal(apu.fifoSample(1), -0x80);
        assert.deepEqual(requests, [0x040000a0, 0x040000a4]);
    });

    it('buffers routed Direct Sound as deterministic stereo samples', () => {

        const { apu } = createAPU({ sampleRate: 65536, bufferCapacity: 2 });

        apu.writeControlX(0x80);
        apu.writeControlHigh(0x0304);
        apu.writeFIFO(0, 0x40);
        apu.onTimerOverflow(0);
        apu.tick(512);

        const audio = apu.drainAudio();

        assert.equal(audio.sampleRate, 65536);
        assert.deepEqual([...audio.left], [0.5, 0.5]);
        assert.deepEqual([...audio.right], [0.5, 0.5]);
        assert.equal(apu.bufferedSamples, 0);
    });

    it('applies SOUNDBIAS clipping and PWM amplitude resolution', () => {

        const defaultResolution = createAPU({ sampleRate: 65536 }).apu;

        defaultResolution.writeControlX(0x80);
        defaultResolution.writeControlHigh(0x0300);
        defaultResolution.writeFIFO(0, 0x01);
        defaultResolution.onTimerOverflow(0);
        defaultResolution.tick(256);

        assert.deepEqual(
            [...defaultResolution.drainAudio().left],
            [0.00390625],
        );

        const eightBitResolution = createAPU({ sampleRate: 65536 }).apu;

        eightBitResolution.writeControlX(0x80);
        eightBitResolution.writeControlHigh(0x0300);
        eightBitResolution.writeBias(0x4200);
        eightBitResolution.writeFIFO(0, 0x01);
        eightBitResolution.onTimerOverflow(0);
        eightBitResolution.tick(256);

        assert.deepEqual([...eightBitResolution.drainAudio().left], [0]);

        const clipped = createAPU({ sampleRate: 65536 }).apu;

        clipped.writeControlX(0x80);
        clipped.writeControlHigh(0x330c);
        clipped.writeBias(0x0100);
        clipped.writeFIFO(0, 0x80);
        clipped.writeFIFO(1, 0x80);
        clipped.onTimerOverflow(0);
        clipped.tick(256);

        assert.deepEqual([...clipped.drainAudio().left], [-0.5]);
    });

    it('holds mixed samples at each SOUNDBIAS PWM rate', () => {

        for (let resolution = 0; resolution < 4; resolution++) {
            const { apu } = createAPU({ sampleRate: 524288 });
            const period = 512 >> resolution;

            apu.writeControlX(0x80);
            apu.writeControlHigh(0x0304);
            apu.writeBias(0x0200 | (resolution << 14));
            apu.writeFIFO(0, 0x20);
            apu.onTimerOverflow(0);
            apu.tick(32);
            apu.writeFIFO(0, 0x40);
            apu.onTimerOverflow(0);
            apu.tick(period + 32);

            const samples = [...apu.drainAudio().left];

            assert.equal(samples.length, period / 32 + 2);
            assert.deepEqual(samples.slice(0, -2), Array(samples.length - 2).fill(0.25));
            assert.deepEqual(samples.slice(-2), [0.5, 0.5]);
        }
    });

    it('maps sound control and write-only FIFOs through the GBA bus', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_SOUND_CONTROL_HIGH_ADDRESS, 0xffff);
        bus.write16(GBA_SOUND_CONTROL_X_ADDRESS, 0xffff);
        bus.write16(GBA_SOUND_BIAS_ADDRESS, 0xffff);
        bus.write32(GBA_FIFO_A_ADDRESS, 0x807f0102);
        bus.write16(GBA_FIFO_B_ADDRESS, 0x3412);

        assert.equal(bus.read16(GBA_SOUND_CONTROL_HIGH_ADDRESS), 0x770f);
        assert.equal(bus.read16(GBA_SOUND_CONTROL_X_ADDRESS), 0x0080);
        assert.equal(bus.read16(GBA_SOUND_BIAS_ADDRESS), 0xc3fe);
        assert.equal(bus.read32(GBA_FIFO_A_ADDRESS), 0);
        assert.equal(bus.apu.fifoLevel(0), 4);
        assert.equal(bus.apu.fifoLevel(1), 2);

        bus.setOpenBus(0x44332211);

        assert.equal(bus.read32(GBA_FIFO_A_ADDRESS), 0x44332211);
    });

    it('queues FIFO words least-significant byte first and ignores overflow', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write32(GBA_FIFO_A_ADDRESS, 0x807f0102);

        for (let index = 4; index < 33; index++) {
            bus.write8(GBA_FIFO_A_ADDRESS, index);
        }

        assert.equal(bus.apu.fifoLevel(0), 32);

        const samples = [];

        for (let index = 0; index < 4; index++) {
            bus.apu.onTimerOverflow(0);
            samples.push(bus.apu.fifoSample(0));
        }

        assert.deepEqual(samples, [0x02, 0x01, 0x7f, -0x80]);
        assert.equal(bus.apu.fifoLevel(0), 28);
    });

    it('requests only the FIFO that crosses the DMA refill threshold', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        for (let index = 0; index < 17; index++) {
            bus.write8(GBA_FIFO_A_ADDRESS, index);
        }

        for (let index = 0; index < 18; index++) {
            bus.write8(GBA_FIFO_B_ADDRESS, index);
        }

        for (let index = 0; index < 4; index++) {
            bus.write32(0x03000000 + index * 4, 0x10101010 + index);
            bus.write32(0x03000020 + index * 4, 0x20202020 + index);
        }

        bus.write32(GBA_DMA_BASE_ADDRESS + 12, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 16, GBA_FIFO_A_ADDRESS);
        bus.write32(GBA_DMA_BASE_ADDRESS + 20, 0xb6000001);
        bus.write32(GBA_DMA_BASE_ADDRESS + 24, 0x03000020);
        bus.write32(GBA_DMA_BASE_ADDRESS + 28, GBA_FIFO_B_ADDRESS);
        bus.write32(GBA_DMA_BASE_ADDRESS + 32, 0xb6000001);
        bus.timers.writeReload(0, 0xffff);
        bus.timers.writeControl(0, 0x80);
        bus.timers.tick(2);

        assert.equal(bus.apu.fifoLevel(0), 16);
        assert.equal(bus.apu.fifoLevel(1), 17);
        assert.equal(bus.dma.hasPending, true);
        assert.equal(bus.dma.runPending(), 10);
        assert.equal(bus.apu.fifoLevel(0), 32);
        assert.equal(bus.apu.fifoLevel(1), 17);
        assert.equal(bus.dma.hasPending, false);
    });

    it('clocks and drains audio through the GBA system', () => {

        const system = new GameBoyAdvanceSystem({
            rom: new Uint8Array(0x100),
            audioSampleRate: 65536,
            audioBufferCapacity: 4,
        });

        system.bus.write16(GBA_SOUND_CONTROL_X_ADDRESS, 0x80);
        system.bus.write16(GBA_SOUND_CONTROL_HIGH_ADDRESS, 0x0304);
        system.bus.write8(GBA_FIFO_A_ADDRESS, 0x40);
        system.bus.apu.onTimerOverflow(0);
        system.scheduler.advance(256);

        const audio = system.drainAudio();

        assert.deepEqual([...audio.left], [0.5]);
        assert.deepEqual([...audio.right], [0.5]);

        system.reset();

        assert.equal(system.bus.apu.fifoLevel(0), 0);
        assert.equal(system.bus.apu.readBias(), 0x0200);
    });

    it('keeps the newest samples when the output ring buffer overflows', () => {

        const { apu } = createAPU({ sampleRate: 65536, bufferCapacity: 2 });

        apu.writeControlX(0x80);
        apu.writeControlHigh(0x0304);

        for (const sample of [0x20, 0x40, 0x60]) {
            apu.writeFIFO(0, sample);
            apu.onTimerOverflow(0);
            apu.tick(256);
        }

        const audio = apu.drainAudio();

        assert.deepEqual([...audio.left], [0.25, 0.5]);
        assert.deepEqual([...audio.right], [0.25, 0.5]);
        assert.equal(apu.droppedSamples, 1);
    });

    it('rejects invalid output settings', () => {

        assert.throws(
            () => createAPU({ sampleRate: 0 }),
            /audio sample rate/,
        );
        assert.throws(
            () => createAPU({ sampleRate: 16777217 }),
            /audio sample rate/,
        );
        assert.throws(
            () => createAPU({ bufferCapacity: 0 }),
            /audio buffer capacity/,
        );
    });
});
