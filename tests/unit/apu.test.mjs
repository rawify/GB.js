import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DMGBus,
    GAME_BOY_LOGO,
    calculateGameBoyHeaderChecksum,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

function createROM() {

    const rom = new Uint8Array(0x8000);

    rom.set(GAME_BOY_LOGO, 0x0104);
    rom.set([0x41, 0x50, 0x55], 0x0134);
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    return rom;
}

function createBus(options = {}) {

    return new DMGBus({
        cartridge: createGameBoyCartridge(createROM()),
        ...options,
    });
}

function startWaveChannel(bus) {

    bus.write(0xff26, 0x80);

    for (let index = 0; index < 16; index++) {
        bus.write(0xff30 + index, index * 0x11);
    }

    bus.write(0xff1a, 0x80);
    bus.write(0xff1c, 0x20);
    bus.write(0xff1d, 0xff);
    bus.write(0xff1e, 0x87);
}

describe('DMG APU', () => {

    it('implements NR52 power control and preserves wave RAM', () => {

        const bus = createBus();

        assert.equal(bus.read(0xff26), 0x70);
        bus.write(0xff12, 0xf3);
        assert.equal(bus.read(0xff12), 0);

        bus.write(0xff30, 0xab);
        bus.write(0xff26, 0x80);
        assert.equal(bus.read(0xff26), 0xf0);

        bus.write(0xff11, 0x80);
        bus.write(0xff12, 0xf3);
        bus.write(0xff13, 0);
        bus.write(0xff14, 0x80);
        assert.equal(bus.read(0xff11), 0xbf);
        assert.equal(bus.read(0xff12), 0xf3);
        assert.equal(bus.read(0xff26), 0xf1);

        bus.write(0xff26, 0);
        assert.equal(bus.read(0xff26), 0x70);
        assert.equal(bus.read(0xff12), 0);
        assert.equal(bus.read(0xff30), 0xab);
    });

    it('buffers a routed pulse channel as deterministic stereo samples', () => {

        const bus = createBus({
            audioSampleRate: 65536,
            audioBufferCapacity: 128,
        });

        bus.write(0xff26, 0x80);
        bus.write(0xff24, 0x77);
        bus.write(0xff25, 0x10);
        bus.write(0xff11, 0x80);
        bus.write(0xff12, 0xf0);
        bus.write(0xff13, 0);
        bus.write(0xff14, 0x87);
        bus.tick(8192);

        const audio = bus.drainAudio();

        assert.equal(audio.sampleRate, 65536);
        assert.equal(audio.left.length, 128);
        assert.equal(audio.right.length, 128);
        assert.ok(audio.left.some((sample) => sample > 0));
        assert.ok(audio.left.some((sample) => sample < 0));
        assert.ok(audio.right.every((sample) => sample === 0));

        const empty = bus.drainAudio();

        assert.equal(empty.left.length, 0);
        assert.equal(empty.right.length, 0);
    });

    it('clocks channel length from DIV and disables overflowing sweep', () => {

        const bus = createBus();

        bus.write(0xff26, 0x80);
        bus.write(0xff16, 0x3f);
        bus.write(0xff17, 0xf0);
        bus.write(0xff19, 0xc0);
        assert.equal(bus.read(0xff26) & 0x02, 0x02);

        bus.tick(4096);
        assert.equal(bus.read(0xff26) & 0x02, 0x02);
        bus.write(0xff04, 0);
        assert.equal(bus.read(0xff26) & 0x02, 0);

        const sweepBus = createBus();

        sweepBus.write(0xff26, 0x80);
        sweepBus.write(0xff10, 0x11);
        sweepBus.write(0xff12, 0xf0);
        sweepBus.write(0xff13, 0);
        sweepBus.write(0xff14, 0x86);
        sweepBus.tick(90119);
        assert.equal(sweepBus.read(0xff26) & 0x01, 0x01);
        sweepBus.tick(1);
        assert.equal(sweepBus.read(0xff26) & 0x01, 0);
    });

    it('disables channel 1 when a used sweep negate is cleared', () => {

        const bus = createBus({ model: 'cgb', cgbRevision: 'e' });

        bus.write(0xff26, 0x80);
        bus.write(0xff10, 0x19);
        bus.write(0xff11, 0x80);
        bus.write(0xff12, 0xf0);
        bus.write(0xff13, 0);
        bus.write(0xff14, 0x84);
        assert.equal(bus.read(0xff26) & 0x01, 0x01);

        bus.tick(24584);
        bus.write(0xff10, 0x11);
        assert.equal(bus.read(0xff26) & 0x01, 0);
    });

    it('pauses and reloads delayed sweep calculations on CGB-E NR10 writes', () => {

        const startSweep = (bus) => {

            bus.write(0xff26, 0x80);
            bus.write(0xff10, 0x11);
            bus.write(0xff11, 0x80);
            bus.write(0xff12, 0xf0);
            bus.write(0xff13, 0);
            bus.write(0xff14, 0x86);
        };
        const pausedBus = createBus({ model: 'cgb', cgbRevision: 'e' });

        startSweep(pausedBus);
        pausedBus.tick(90116);
        pausedBus.write(0xff10, 0);
        pausedBus.tick(50000);
        assert.equal(pausedBus.read(0xff26) & 0x01, 0x01);

        const reloadedBus = createBus({ model: 'cgb', cgbRevision: 'e' });

        startSweep(reloadedBus);
        reloadedBus.tick(90112);
        reloadedBus.write(0xff10, 0x17);
        reloadedBus.tick(31);
        assert.equal(reloadedBus.read(0xff26) & 0x01, 0x01);
        reloadedBus.tick(1);
        assert.equal(reloadedBus.read(0xff26) & 0x01, 0);
    });

    it('applies extra length clocks to every channel', () => {

        const bus = createBus();

        bus.write(0xff26, 0x80);

        bus.write(0xff11, 0x3f);
        bus.write(0xff12, 0xf0);
        bus.write(0xff14, 0x80);

        bus.write(0xff16, 0x3f);
        bus.write(0xff17, 0xf0);
        bus.write(0xff19, 0x80);

        bus.write(0xff1a, 0x80);
        bus.write(0xff1b, 0xff);
        bus.write(0xff1c, 0x20);
        bus.write(0xff1e, 0x80);

        bus.write(0xff20, 0x3f);
        bus.write(0xff21, 0xf0);
        bus.write(0xff23, 0x80);

        bus.tick(8192);

        bus.write(0xff14, 0x40);
        bus.write(0xff19, 0x40);
        bus.write(0xff1e, 0x40);
        bus.write(0xff23, 0x40);
        assert.equal(bus.read(0xff26) & 0x0f, 0);
    });

    it('reloads an empty triggered length counter to maximum minus one', () => {

        const bus = createBus();

        bus.write(0xff26, 0x80);
        bus.write(0xff16, 0x3f);
        bus.write(0xff17, 0xf0);
        bus.write(0xff19, 0x80);
        bus.tick(8192);
        bus.write(0xff19, 0x40);
        assert.equal(bus.read(0xff26) & 0x02, 0);

        bus.write(0xff19, 0xc0);
        assert.equal(bus.read(0xff26) & 0x02, 0x02);
        bus.tick(63 * 16384);
        assert.equal(bus.read(0xff26) & 0x02, 0);
    });

    it('suppresses a starting pulse until its first duty step', () => {

        const bus = createBus();

        bus.write(0xff26, 0x80);
        bus.write(0xff11, 0x40);
        bus.write(0xff12, 0xf0);
        bus.write(0xff13, 0xff);
        bus.write(0xff14, 0x87);
        assert.equal(bus.apu.pcm12 & 0x0f, 0);

        bus.tick(11);
        bus.write(0xff11, 0xc0);
        assert.equal(bus.apu.pcm12 & 0x0f, 0);

        bus.tick(1);
        assert.equal(bus.apu.pcm12 & 0x0f, 0x0f);

        bus.write(0xff14, 0x87);
        assert.equal(bus.apu.pcm12 & 0x0f, 0x0f);

        bus.write(0xff12, 0);
        bus.write(0xff12, 0xf0);
        bus.write(0xff14, 0x87);
        assert.equal(bus.apu.pcm12 & 0x0f, 0);

        bus.tick(11);
        assert.equal(bus.apu.pcm12 & 0x0f, 0);
        bus.tick(1);
        assert.equal(bus.apu.pcm12 & 0x0f, 0x0f);
    });

    it('renders wave and noise channels through independent stereo routes', () => {

        const waveBus = createBus({ audioSampleRate: 65536 });

        waveBus.write(0xff26, 0x80);
        waveBus.write(0xff24, 0x77);
        waveBus.write(0xff25, 0x40);

        for (let address = 0xff30; address <= 0xff3f; address++) {
            waveBus.write(address, 0xf0);
        }

        waveBus.write(0xff1a, 0x80);
        waveBus.write(0xff1c, 0x20);
        waveBus.write(0xff1d, 0);
        waveBus.write(0xff1e, 0x80);
        waveBus.tick(12288);

        const waveAudio = waveBus.drainAudio();

        assert.ok(waveAudio.left.some((sample) => sample > 0));
        assert.ok(waveAudio.left.some((sample) => sample < 0));
        assert.ok(waveAudio.right.every((sample) => sample === 0));

        const noiseBus = createBus({ audioSampleRate: 65536 });

        noiseBus.write(0xff26, 0x80);
        noiseBus.write(0xff24, 0x77);
        noiseBus.write(0xff25, 0x08);
        noiseBus.write(0xff21, 0xf0);
        noiseBus.write(0xff22, 0x08);
        noiseBus.write(0xff23, 0x80);
        noiseBus.tick(8192);

        const noiseAudio = noiseBus.drainAudio();

        assert.ok(noiseAudio.left.every((sample) => sample === 0));
        assert.ok(noiseAudio.right.some((sample) => sample > 0));
        assert.ok(noiseAudio.right.some((sample) => sample < 0));
    });

    it('gates active DMG wave RAM access to the fetch cycle', () => {

        const bus = createBus();

        startWaveChannel(bus);
        assert.equal(bus.read(0xff30), 0xff);
        bus.write(0xff35, 0xaa);

        bus.tick(8);
        assert.equal(bus.read(0xff3f), 0x00);
        bus.write(0xff3f, 0xaa);
        assert.equal(bus.read(0xff30), 0xaa);

        bus.tick(1);
        assert.equal(bus.read(0xff30), 0xff);

        bus.write(0xff1a, 0);
        assert.equal(bus.read(0xff35), 0x55);
    });

    it('aliases active CGB wave RAM accesses to the current byte', () => {

        const bus = createBus({ model: 'cgb' });

        startWaveChannel(bus);
        assert.equal(bus.read(0xff3f), 0x00);
        bus.write(0xff3f, 0xaa);
        assert.equal(bus.read(0xff30), 0xaa);
        assert.equal(bus.read(0xff35), 0xaa);

        bus.tick(10);
        assert.equal(bus.read(0xff30), 0x11);
        bus.write(0xff30, 0xbb);

        bus.write(0xff1a, 0);
        assert.equal(bus.read(0xff31), 0xbb);
        assert.equal(bus.read(0xff3f), 0xff);
    });

    it('applies DMG wave RAM retrigger corruption without affecting CGB', () => {

        const dmgBus = createBus();

        startWaveChannel(dmgBus);
        dmgBus.tick(13);
        dmgBus.write(0xff1e, 0x87);
        dmgBus.write(0xff1a, 0);
        assert.equal(dmgBus.read(0xff30), 0x22);

        const cgbBus = createBus({ model: 'cgb' });

        startWaveChannel(cgbBus);
        cgbBus.tick(13);
        cgbBus.write(0xff1e, 0x87);
        cgbBus.write(0xff1a, 0);
        assert.equal(cgbBus.read(0xff30), 0x00);
        assert.equal(cgbBus.read(0xff32), 0x22);
    });

    it('applies revision-specific NRx2 writes to an active pulse envelope', () => {

        const cases = [
            [0x20, 0x20, 0x02],
            [0x08, 0x08, 0x01],
            [0x22, 0x22, 0x02],
            [0x32, 0x32, 0x03],
            [0x20, 0x08, 0x0d],
            [0x08, 0x47, 0x0f],
            [0x22, 0x08, 0x0c],
            [0x08, 0x32, 0x0f],
        ];

        for (const [initialEnvelope, writtenEnvelope, expectedVolume] of cases) {
            const bus = createBus({ model: 'cgb', cgbRevision: 'e' });

            bus.write(0xff26, 0x80);
            bus.write(0xff11, 0x40);
            bus.write(0xff12, initialEnvelope);
            bus.write(0xff13, 0xff);
            bus.write(0xff14, 0x87);
            bus.tick(12);
            bus.write(0xff11, 0xc0);
            bus.write(0xff12, writtenEnvelope);

            assert.equal(bus.apu.pcm12 & 0x0f, expectedVolume);
        }

        const revisionCases = [
            [{}, 0x03],
            [{ model: 'cgb', cgbRevision: '0' }, 0x03],
            [{ model: 'cgb', cgbRevision: 'a' }, 0x03],
            [{ model: 'cgb', cgbRevision: 'b' }, 0x03],
            [{ model: 'cgb', cgbRevision: 'c' }, 0x03],
            [{ model: 'cgb', cgbRevision: 'd' }, 0x02],
            [{ model: 'cgb', cgbRevision: 'e' }, 0x02],
        ];

        for (const [options, expectedVolume] of revisionCases) {
            const bus = createBus(options);

            bus.write(0xff26, 0x80);
            bus.write(0xff11, 0x40);
            bus.write(0xff12, 0x20);
            bus.write(0xff13, 0xff);
            bus.write(0xff14, 0x87);
            bus.tick(12);
            bus.tick(1);
            bus.write(0xff11, 0xc0);
            bus.write(0xff12, 0x20);

            assert.equal(bus.apu.pcm12 & 0x0f, expectedVolume);
        }
    });

    it('masks a pulse edge from PCM12 for one CGB-C APU run', () => {

        const startPulseBeforeRisingEdge = (bus) => {

            bus.write(0xff26, 0x80);
            bus.write(0xff11, 0);
            bus.write(0xff12, 0xf0);
            bus.write(0xff13, 0xff);
            bus.write(0xff14, 0x87);
            bus.tick(32);
        };
        const cgbCBus = createBus({ model: 'cgb', cgbRevision: 'c' });

        startPulseBeforeRisingEdge(cgbCBus);
        cgbCBus.tick(4);
        assert.equal(cgbCBus.apu.pcm12 & 0x0f, 0);
        cgbCBus.tick(1);
        assert.equal(cgbCBus.apu.pcm12 & 0x0f, 0x0f);

        const cgbEBus = createBus({ model: 'cgb', cgbRevision: 'e' });

        startPulseBeforeRisingEdge(cgbEBus);
        cgbEBus.tick(4);
        assert.equal(cgbEBus.apu.pcm12 & 0x0f, 0x0f);
    });

    it('masks a noise edge from PCM34 for one CGB-C APU run', () => {

        const startNoise = (bus) => {

            bus.write(0xff26, 0x80);
            bus.write(0xff21, 0xf0);
            bus.write(0xff22, 0x08);
            bus.write(0xff23, 0x80);
        };
        const cgbCBus = createBus({ model: 'cgb', cgbRevision: 'c' });

        startNoise(cgbCBus);
        cgbCBus.tick(60);
        assert.equal(cgbCBus.apu.pcm34 >> 4, 0);
        cgbCBus.tick(1);
        assert.equal(cgbCBus.apu.pcm34 >> 4, 0x0f);

        const cgbEBus = createBus({ model: 'cgb', cgbRevision: 'e' });

        startNoise(cgbEBus);
        cgbEBus.tick(60);
        assert.equal(cgbEBus.apu.pcm34 >> 4, 0x0f);
    });

    it('shares NRx2 glitches across pulse 2 and noise and resets them on trigger', () => {

        const pulseBus = createBus({ model: 'cgb', cgbRevision: 'e' });

        pulseBus.write(0xff26, 0x80);
        pulseBus.write(0xff16, 0x40);
        pulseBus.write(0xff17, 0x20);
        pulseBus.write(0xff18, 0xff);
        pulseBus.write(0xff19, 0x87);
        pulseBus.tick(12);
        pulseBus.write(0xff16, 0xc0);
        pulseBus.write(0xff17, 0x08);
        assert.equal(pulseBus.apu.pcm12 >> 4, 0x0d);

        pulseBus.write(0xff17, 0x28);
        pulseBus.write(0xff19, 0x80);
        assert.equal(pulseBus.apu.pcm12 >> 4, 0x02);

        pulseBus.write(0xff17, 0);
        assert.equal(pulseBus.read(0xff26) & 0x02, 0);
        assert.equal(pulseBus.apu.pcm12 >> 4, 0);

        const noiseBus = createBus({ model: 'cgb', cgbRevision: 'e' });

        noiseBus.write(0xff26, 0x80);
        noiseBus.write(0xff21, 0x20);
        noiseBus.write(0xff22, 0);
        noiseBus.write(0xff23, 0x80);
        noiseBus.tick(124);
        assert.equal(noiseBus.apu.pcm34 >> 4, 0x02);

        noiseBus.write(0xff21, 0x08);
        assert.equal(noiseBus.apu.pcm34 >> 4, 0x0d);
        noiseBus.write(0xff21, 0);
        assert.equal(noiseBus.read(0xff26) & 0x08, 0);
        assert.equal(noiseBus.apu.pcm34 >> 4, 0);
    });

    it('resamples exact frame rates and bounds queued audio', () => {

        const frameBus = createBus({
            audioSampleRate: 48000,
            audioBufferCapacity: 2000,
        });

        frameBus.tick(70224);
        assert.equal(frameBus.drainAudio().left.length, 803);
        frameBus.tick(70224);
        assert.equal(frameBus.drainAudio().left.length, 804);

        const boundedBus = createBus({
            audioSampleRate: 65536,
            audioBufferCapacity: 8,
        });

        boundedBus.tick(64 * 12);
        assert.equal(boundedBus.apu.bufferedSamples, 8);
        assert.equal(boundedBus.apu.droppedSamples, 4);
        assert.equal(boundedBus.drainAudio().left.length, 8);

        assert.throws(
            () => createBus({ audioSampleRate: 0 }),
            /audio sample rate/,
        );
        assert.throws(
            () => createBus({ audioBufferCapacity: 0 }),
            /audio buffer capacity/,
        );
    });

    it('box-filters channel edges across each output sample', () => {

        const bus = createBus({
            audioSampleRate: 524288,
            audioBufferCapacity: 4,
        });

        bus.write(0xff26, 0x80);
        bus.write(0xff24, 0x70);
        bus.write(0xff25, 0x10);
        bus.write(0xff11, 0xc0);
        bus.write(0xff12, 0xf0);
        bus.write(0xff13, 0xff);
        bus.write(0xff14, 0x87);
        bus.tick(16);

        const audio = bus.drainAudio();
        const chargeFactor = 0.999958;
        const firstSample = 0.25 * (1 - chargeFactor ** 8)
            / (8 * (1 - chargeFactor));
        const firstHalfDifference = 0.25 * chargeFactor ** 8;
        const secondHalfDifference = -0.5 + 0.25 * chargeFactor ** 12;
        const secondSample = (firstHalfDifference + secondHalfDifference)
            * (1 - chargeFactor ** 4)
            / (8 * (1 - chargeFactor));

        assert.ok(Math.abs(audio.left[0] - firstSample) < 1e-7);
        assert.ok(Math.abs(audio.left[1] - secondSample) < 1e-7);
        assert.deepEqual([...audio.right], [0, 0]);
    });

    it('models the DMG and CGB high-pass capacitors and DAC disconnect', () => {

        const cases = [
            [{}, 0.999958],
            [{ model: 'cgb' }, 0.998943],
        ];

        for (const [options, chargeFactor] of cases) {
            const bus = createBus({
                ...options,
                audioSampleRate: 4194304,
                audioBufferCapacity: 32,
            });

            bus.write(0xff26, 0x80);
            bus.write(0xff24, 0x70);
            bus.write(0xff25, 0x10);
            bus.write(0xff12, 0x08);
            bus.tick(16);

            const charged = bus.drainAudio();

            assert.ok(Math.abs(charged.left[0] - 0.25) < 1e-7);
            assert.ok(Math.abs(charged.left[15] - 0.25 * chargeFactor ** 15) < 1e-7);
            assert.deepEqual([...charged.right], Array(16).fill(0));

            bus.write(0xff12, 0);
            bus.tick(1);
            assert.equal(bus.drainAudio().left[0], 0);

            bus.write(0xff12, 0x08);
            bus.tick(1);

            const resumed = bus.drainAudio();

            assert.ok(Math.abs(resumed.left[0] - 0.25 * chargeFactor ** 16) < 1e-7);
        }
    });
});
