import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let RingBufferProcessor;

globalThis.AudioWorkletProcessor = class {

    constructor() {

        this.messages = [];
        this.port = {
            onmessage: null,
            postMessage: (message) => this.messages.push(message),
        };
    }
};
globalThis.registerProcessor = (name, processor) => {

    assert.equal(name, 'gb-audio-ring-buffer');
    RingBufferProcessor = processor;
};

await import('../../demo/audio-worklet.js');

delete globalThis.AudioWorkletProcessor;
delete globalThis.registerProcessor;

function createProcessor(adaptivePlayback = false) {

    return new RingBufferProcessor({
        processorOptions: {
            capacity: 128,
            startThreshold: 128,
            generation: 7,
            adaptivePlayback,
        },
    });
}

function write(processor, left, right = left) {

    processor.port.onmessage({
        data: {
            type: 'write',
            left: Float32Array.from(left),
            right: Float32Array.from(right),
        },
    });
}

function process(processor, length) {

    const left = new Float32Array(length);
    const right = new Float32Array(length);

    processor.process([], [[left, right]]);

    return { left, right };
}

describe('demo AudioWorklet ring buffer', () => {

    it('prebuffers samples and then reads stereo frames in FIFO order', () => {

        const processor = createProcessor();

        write(processor, Array.from({ length: 64 }, (_, index) => index + 1));
        assert.deepEqual([...process(processor, 16).left], Array(16).fill(0));

        write(
            processor,
            Array.from({ length: 64 }, (_, index) => index + 65),
            Array.from({ length: 64 }, (_, index) => -(index + 65)),
        );

        const output = process(processor, 16);

        assert.deepEqual([...output.left], Array.from({ length: 16 }, (_, index) => index + 1));
        assert.deepEqual([...output.right], Array.from({ length: 16 }, (_, index) => index + 1));
    });

    it('keeps the newest frames on overflow and clears buffered audio', () => {

        const processor = createProcessor();

        write(processor, Array.from({ length: 128 }, (_, index) => index));
        process(processor, 64);
        write(processor, Array.from({ length: 100 }, (_, index) => index + 1000));

        assert.deepEqual(
            [...process(processor, 32).left],
            [
                ...Array.from({ length: 28 }, (_, index) => index + 100),
                1000,
                1001,
                1002,
                1003,
            ],
        );

        processor.port.onmessage({ data: { type: 'clear' } });
        assert.deepEqual([...process(processor, 16).left], Array(16).fill(0));
    });

    it('reports an underrun after playback starts', () => {

        const processor = createProcessor();

        write(processor, Array(128).fill(1));
        process(processor, 96);

        const output = process(processor, 64);

        assert.deepEqual([...output.left], [...Array(32).fill(1), ...Array(32).fill(0)]);
        assert.deepEqual(processor.messages, [{
            type: 'underrun',
            missingFrames: 32,
            generation: 7,
        }]);
    });

    it('resumes adaptive playback after a transient underrun without rebuffering', () => {

        const processor = new RingBufferProcessor({
            processorOptions: {
                capacity: 8192,
                startThreshold: 4096,
                generation: 7,
                adaptivePlayback: true,
            },
        });

        write(processor, Array(4096).fill(1));

        for (let block = 0; block < 64 && processor.messages.length === 0; block++) {
            process(processor, 128);
        }

        assert.equal(processor.messages.length, 1);
        assert.equal(processor.playing, true);

        write(processor, Array(2048).fill(1));

        assert.deepEqual([...process(processor, 128).left], Array(128).fill(1));
        assert.equal(processor.playing, true);
    });

    it('estimates the producer rate while prebuffering', () => {

        const processor = new RingBufferProcessor({
            processorOptions: {
                capacity: 16_384,
                startThreshold: 7200,
                generation: 7,
                adaptivePlayback: true,
            },
        });
        const sourceRate = 52 / 59.7275;
        let producedFrames = 0;

        for (let block = 1; !processor.playing; block++) {
            const nextProducedFrames = Math.floor(block * 128 * sourceRate);

            write(processor, Array(nextProducedFrames - producedFrames).fill(1));
            producedFrames = nextProducedFrames;
            process(processor, 128);
        }

        assert.ok(Math.abs(processor.playbackRate - sourceRate) < 0.015);
        assert.equal(processor.messages.filter((message) => message.type === 'underrun').length, 0);
    });

    it('adapts consumption to a sustained slower producer', () => {

        const processor = new RingBufferProcessor({
            processorOptions: {
                capacity: 16_384,
                startThreshold: 4800,
                generation: 7,
                adaptivePlayback: true,
            },
        });
        const sourceRate = 51 / 59.7275;
        const samplesPerEmulatedFrame = 48_000 / 59.7275;
        const settledRates = [];
        let emulatedFrames = 0;
        let minimumAvailableFrames = Number.POSITIVE_INFINITY;

        write(processor, Array(7200).fill(1));

        for (let block = 1; block <= 2250; block++) {
            const nextEmulatedFrames = Math.floor(block * 128 * sourceRate / samplesPerEmulatedFrame);

            while (emulatedFrames < nextEmulatedFrames) {
                const previousSamples = Math.floor(emulatedFrames * samplesPerEmulatedFrame);

                emulatedFrames++;
                write(
                    processor,
                    Array(Math.floor(emulatedFrames * samplesPerEmulatedFrame) - previousSamples).fill(1),
                );
            }

            const output = process(processor, 128);

            minimumAvailableFrames = Math.min(minimumAvailableFrames, processor.available);

            if (block > 1875) {
                settledRates.push(processor.playbackRate);
            }

            assert.ok(
                output.left.every((sample) => sample === 1),
                `audio gap in block ${block}: available=${processor.available}, rate=${processor.playbackRate}, estimate=${processor.estimatedInputRate}`,
            );
        }

        assert.equal(processor.messages.filter((message) => message.type === 'underrun').length, 0);
        assert.ok(Math.abs(processor.playbackRate - sourceRate) < 0.015);
        assert.ok(
            Math.max(...settledRates) - Math.min(...settledRates) < 0.03,
            'playback-rate modulation should remain inaudible after settling',
        );
        assert.ok(minimumAvailableFrames > 1500);
    });

    it('preserves pitch while stretching slower emulation audio', () => {

        const processor = new RingBufferProcessor({
            processorOptions: {
                capacity: 16_384,
                startThreshold: 4800,
                generation: 7,
                adaptivePlayback: true,
            },
        });
        const sourceRate = 52 / 59.7275;
        const samplesPerEmulatedFrame = 48_000 / 59.7275;
        const frequency = 440;
        const source = (start, length) => Array.from(
            { length },
            (_, index) => Math.sin(2 * Math.PI * frequency * (start + index) / 48_000),
        );
        const rendered = [];
        let emulatedFrames = 0;
        let generatedSamples = 4800;

        write(processor, source(0, generatedSamples));

        for (let block = 1; block <= 750; block++) {
            const nextEmulatedFrames = Math.floor(block * 128 * sourceRate / samplesPerEmulatedFrame);

            while (emulatedFrames < nextEmulatedFrames) {
                const previousSamples = Math.floor(emulatedFrames * samplesPerEmulatedFrame);

                emulatedFrames++;

                const frameSamples = Math.floor(emulatedFrames * samplesPerEmulatedFrame) - previousSamples;

                write(processor, source(generatedSamples, frameSamples));
                generatedSamples += frameSamples;
            }

            rendered.push(...process(processor, 128).left);
        }

        const measured = rendered.slice(24_000).reduce((crossings, sample, index, samples) => (
            index > 0 && samples[index - 1] <= 0 && sample > 0 ? crossings + 1 : crossings
        ), 0) / ((rendered.length - 24_000) / 48_000);
        const consumedRate = (generatedSamples - processor.available) / rendered.length;

        assert.equal(processor.messages.filter((message) => message.type === 'underrun').length, 0);
        assert.ok(measured > 430 && measured < 450, `expected 440 Hz, measured ${measured} Hz`);
        assert.ok(
            Math.abs(consumedRate - sourceRate) < 0.015,
            `expected ${sourceRate.toFixed(3)} consumption, measured ${consumedRate.toFixed(3)}`,
        );
    });

    it('preserves broadband energy while stretching slower emulation audio', () => {

        const processor = new RingBufferProcessor({
            processorOptions: {
                capacity: 16_384,
                startThreshold: 7200,
                generation: 7,
                adaptivePlayback: true,
            },
        });
        const sourceRate = 51 / 59.7275;
        const sample = (index) => {

            const noise = (((index * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;

            return 0.45 * Math.sin(2 * Math.PI * 110 * index / 48_000)
                + 0.25 * Math.sin(2 * Math.PI * 440 * index / 48_000)
                + 0.15 * Math.sin(2 * Math.PI * 3100 * index / 48_000)
                + 0.1 * noise;
        };
        const rendered = [];
        let generatedFrames = 0;

        for (let block = 1; block <= 1500; block++) {
            const nextGeneratedFrames = Math.floor(block * 128 * sourceRate);

            write(
                processor,
                Array.from(
                    { length: nextGeneratedFrames - generatedFrames },
                    (_, index) => sample(generatedFrames + index),
                ),
            );
            generatedFrames = nextGeneratedFrames;

            const output = process(processor, 128).left;

            if (processor.playing) {
                rendered.push(...output);
            }
        }

        const settled = rendered.slice(24_000);
        const outputRMS = Math.sqrt(
            settled.reduce((sum, value) => sum + value * value, 0) / settled.length,
        );
        const sourceRMS = Math.sqrt(
            Array.from({ length: settled.length }, (_, index) => sample(index))
                .reduce((sum, value) => sum + value * value, 0) / settled.length,
        );
        const energyRatio = outputRMS / sourceRMS;

        assert.ok(
            energyRatio > 0.97 && energyRatio < 1.03,
            `expected preserved broadband energy, measured ${energyRatio.toFixed(3)}×`,
        );
    });
});
