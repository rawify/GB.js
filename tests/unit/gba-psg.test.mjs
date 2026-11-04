import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_SOUND_BIAS_ADDRESS,
    GBA_SOUND1_CONTROL_HIGH_ADDRESS,
    GBA_SOUND1_CONTROL_LOW_ADDRESS,
    GBA_SOUND1_CONTROL_X_ADDRESS,
    GBA_SOUND2_CONTROL_HIGH_ADDRESS,
    GBA_SOUND2_CONTROL_LOW_ADDRESS,
    GBA_SOUND3_CONTROL_HIGH_ADDRESS,
    GBA_SOUND3_CONTROL_LOW_ADDRESS,
    GBA_SOUND3_CONTROL_X_ADDRESS,
    GBA_SOUND4_CONTROL_HIGH_ADDRESS,
    GBA_SOUND4_CONTROL_LOW_ADDRESS,
    GBA_SOUND_CONTROL_HIGH_ADDRESS,
    GBA_SOUND_CONTROL_LOW_ADDRESS,
    GBA_SOUND_CONTROL_X_ADDRESS,
    GBA_WAVE_RAM_ADDRESS,
    GBABus,
    GBAPSG,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

function startPulse(psg, channel, options = {}) {

    const base = channel === 0 ? 0x62 : 0x68;
    const frequency = options.frequency ?? 0x07f8;

    psg.writeByte(base, (options.duty ?? 2) << 6 | (options.length ?? 0));
    psg.writeByte(base + 1, options.envelope ?? 0xf0);
    psg.writeByte(channel === 0 ? 0x64 : 0x6c, frequency & 0xff);
    psg.writeByte(channel === 0 ? 0x65 : 0x6d, 0x80 | (frequency >> 8));
}

describe('GBA PSG pulse channels', () => {

    it('ignores channel writes while powered off and applies read masks', () => {

        const psg = new GBAPSG();

        psg.writeByte(0x60, 0xff);
        psg.writeByte(0x63, 0xf3);

        assert.equal(psg.readByte(0x60), 0);
        assert.equal(psg.readByte(0x63), 0);

        psg.setPowered(true);
        psg.writeByte(0x60, 0xff);
        psg.writeByte(0x62, 0xff);
        psg.writeByte(0x63, 0xf3);
        psg.writeByte(0x64, 0xff);
        psg.writeByte(0x65, 0xff);

        assert.equal(psg.readByte(0x60), 0x7f);
        assert.equal(psg.readByte(0x62), 0xc0);
        assert.equal(psg.readByte(0x63), 0xf3);
        assert.equal(psg.readByte(0x64), 0);
        assert.equal(psg.readByte(0x65), 0x40);
    });

    it('advances pulse duty at the GBA master-clock period', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        startPulse(psg, 0);

        assert.equal(psg.channelLevel(0), 15);

        psg.tick(127);
        assert.equal(psg.channelLevel(0), 15);

        psg.tick(1);
        assert.equal(psg.channelLevel(0), 0);
    });

    it('clocks length and envelopes from the 512 Hz frame sequencer', () => {

        const lengthPSG = new GBAPSG();

        lengthPSG.setPowered(true);
        lengthPSG.writeByte(0x68, 0x80 | 0x3f);
        lengthPSG.writeByte(0x69, 0xf0);
        lengthPSG.writeByte(0x6d, 0xc0);

        assert.equal(lengthPSG.activeChannels, 0x02);
        lengthPSG.tick(32768);
        assert.equal(lengthPSG.activeChannels, 0);

        const envelopePSG = new GBAPSG();

        envelopePSG.setPowered(true);
        startPulse(envelopePSG, 1, {
            envelope: 0x19,
            frequency: 0,
        });

        assert.equal(envelopePSG.channelLevel(1), 1);
        envelopePSG.tick(8 * 32768);
        assert.equal(envelopePSG.channelLevel(1), 2);
    });

    it('applies an extra length clock to every channel in the odd phase', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x62, 0x3f);
        psg.writeByte(0x63, 0xf0);
        psg.writeByte(0x65, 0x80);
        psg.writeByte(0x68, 0x3f);
        psg.writeByte(0x69, 0xf0);
        psg.writeByte(0x6d, 0x80);
        psg.writeByte(0x70, 0x80);
        psg.writeByte(0x72, 0xff);
        psg.writeByte(0x73, 0x20);
        psg.writeByte(0x75, 0x80);
        psg.writeByte(0x78, 0x3f);
        psg.writeByte(0x79, 0xf0);
        psg.writeByte(0x7d, 0x80);

        assert.equal(psg.activeChannels, 0x0f);

        psg.tick(32768);
        psg.writeByte(0x65, 0x40);
        psg.writeByte(0x6d, 0x40);
        psg.writeByte(0x75, 0x40);
        psg.writeByte(0x7d, 0x40);

        assert.equal(psg.activeChannels, 0);
    });

    it('reloads an empty triggered length counter to maximum minus one', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x68, 0x3f);
        psg.writeByte(0x69, 0xf0);
        psg.writeByte(0x6d, 0x80);
        psg.tick(32768);
        psg.writeByte(0x6d, 0x40);

        assert.equal(psg.activeChannels & 0x02, 0);

        psg.writeByte(0x6d, 0xc0);
        psg.tick(62 * 65536);

        assert.equal(psg.activeChannels & 0x02, 0x02);

        psg.tick(65536);

        assert.equal(psg.activeChannels & 0x02, 0);
    });

    it('disables pulse 1 when an increasing sweep overflows', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x60, 0x11);
        startPulse(psg, 0, { frequency: 0x07f8 });

        assert.equal(psg.activeChannels & 0x01, 0);
    });

    it('disables pulse 1 when sweep negate is cleared after subtraction', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x60, 0x19);
        startPulse(psg, 0, { frequency: 1000 });

        assert.equal(psg.activeChannels & 0x01, 0x01);

        psg.writeByte(0x60, 0x11);

        assert.equal(psg.activeChannels & 0x01, 0);
    });

    it('checks sweep overflow again after updating the frequency', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x60, 0x11);
        startPulse(psg, 0, { frequency: 1200 });

        assert.equal(psg.activeChannels & 0x01, 0x01);

        psg.tick(3 * 32768);

        assert.equal(psg.activeChannels & 0x01, 0);
    });

    it('does not run periodic sweep calculations when pace is zero', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x60, 0x01);
        startPulse(psg, 0, { frequency: 1000 });

        assert.equal(psg.activeChannels & 0x01, 0x01);

        psg.tick(31 * 32768);

        assert.equal(psg.activeChannels & 0x01, 0x01);
    });

    it('routes pulse channels independently through SOUNDCNT_L', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x80, 0x77);
        psg.writeByte(0x81, 0x21);
        startPulse(psg, 0);
        startPulse(psg, 1, { duty: 0 });

        const [left, right] = psg.output();

        assert.equal(left, -0.25);
        assert.equal(right, 0.25);

        psg.setPowered(false);

        assert.equal(psg.activeChannels, 0);
        assert.deepEqual(psg.output(), [0, 0]);
        assert.equal(psg.readByte(0x80), 0);
    });

    it('applies independent left and right master volume', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x80, 0x07);
        psg.writeByte(0x81, 0x11);
        startPulse(psg, 0);

        assert.deepEqual(psg.output(), [0.03125, 0.25]);
    });
});

describe('GBA PSG wave and noise channels', () => {

    it('exposes the inactive wave bank and plays the selected bank', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x70, 0x80);
        psg.writeByte(0x90, 0xf0);

        assert.equal(psg.readByte(0x90), 0xf0);

        psg.writeByte(0x70, 0xc0);

        assert.equal(psg.readByte(0x90), 0);

        psg.writeByte(0x90, 0x12);
        psg.writeByte(0x70, 0x80);

        assert.equal(psg.readByte(0x90), 0xf0);

        psg.writeByte(0x70, 0xc0);
        psg.writeByte(0x73, 0x20);
        psg.writeByte(0x74, 0xf8);
        psg.writeByte(0x75, 0x87);

        assert.equal(psg.channelLevel(2), 15);

        psg.tick(64);

        assert.equal(psg.channelLevel(2), 0);
        assert.equal(psg.activeChannels & 0x04, 0x04);
    });

    it('clocks wave length and preserves wave RAM across sound power-off', () => {

        const psg = new GBAPSG();

        psg.writeByte(0x90, 0xab);
        psg.setPowered(true);
        psg.writeByte(0x70, 0x80);
        psg.writeByte(0x72, 0xff);
        psg.writeByte(0x73, 0x20);
        psg.writeByte(0x75, 0xc0);

        assert.equal(psg.activeChannels & 0x04, 0x04);

        psg.tick(32768);

        assert.equal(psg.activeChannels & 0x04, 0);

        psg.setPowered(false);

        assert.equal(psg.readByte(0x90), 0xab);

        psg.reset();

        assert.equal(psg.readByte(0x90), 0);
    });

    it('switches playback banks after 32 samples in 64-sample mode', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x70, 0x80);
        psg.writeByte(0x90, 0x12);
        psg.writeByte(0x70, 0xc0);
        psg.writeByte(0x90, 0x34);
        psg.writeByte(0x70, 0xa0);
        psg.writeByte(0x73, 0x20);
        psg.writeByte(0x74, 0xf8);
        psg.writeByte(0x75, 0x87);

        assert.equal(psg.channelLevel(2), 3);
        assert.equal(psg.readByte(0x90), 0x12);

        psg.tick(32 * 64);

        assert.equal(psg.channelLevel(2), 1);
        assert.equal(psg.readByte(0x90), 0x34);
    });

    it('advances the 15-bit noise LFSR at its selected period', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x79, 0xf0);
        psg.writeByte(0x7c, 0);
        psg.writeByte(0x7d, 0x80);

        assert.equal(psg.channelLevel(3), 0);

        psg.tick(14 * 32);
        assert.equal(psg.channelLevel(3), 0);

        psg.tick(32);
        assert.equal(psg.channelLevel(3), 15);
    });

    it('does not clock noise for unused shift values 14 and 15', () => {

        for (const shift of [14, 15]) {
            const psg = new GBAPSG();

            psg.setPowered(true);
            psg.writeByte(0x79, 0xf0);
            psg.writeByte(0x7c, shift << 4);
            psg.writeByte(0x7d, 0x80);
            psg.tick(8000000);

            assert.equal(psg.channelLevel(3), 0);
            assert.equal(psg.activeChannels & 0x08, 0x08);
        }
    });

    it('feeds back into bit 6 in the short noise mode', () => {

        const psg = new GBAPSG();

        psg.setPowered(true);
        psg.writeByte(0x79, 0xf0);
        psg.writeByte(0x7c, 0x08);
        psg.writeByte(0x7d, 0x80);
        psg.tick(6 * 32);

        assert.equal(psg.channelLevel(3), 0);

        psg.tick(32);

        assert.equal(psg.channelLevel(3), 15);
    });

    it('clocks noise length and envelope with the shared frame sequencer', () => {

        const lengthPSG = new GBAPSG();

        lengthPSG.setPowered(true);
        lengthPSG.writeByte(0x78, 0x3f);
        lengthPSG.writeByte(0x79, 0xf0);
        lengthPSG.writeByte(0x7d, 0xc0);
        lengthPSG.tick(32768);

        assert.equal(lengthPSG.activeChannels & 0x08, 0);

        const envelopePSG = new GBAPSG();

        envelopePSG.setPowered(true);
        envelopePSG.writeByte(0x79, 0x19);
        envelopePSG.writeByte(0x7c, 0xf7);
        envelopePSG.writeByte(0x7d, 0x80);
        envelopePSG.tick(8 * 32768);

        assert.equal(envelopePSG.activeChannels & 0x08, 0x08);
    });
});

describe('GBA PSG integration', () => {

    it('applies the documented read/write masks to every sound register', () => {

        const registers = [
            [GBA_SOUND1_CONTROL_LOW_ADDRESS, 0x007f],
            [GBA_SOUND1_CONTROL_HIGH_ADDRESS, 0xffc0],
            [GBA_SOUND1_CONTROL_X_ADDRESS, 0x4000],
            [GBA_SOUND2_CONTROL_LOW_ADDRESS, 0xffc0],
            [GBA_SOUND2_CONTROL_HIGH_ADDRESS, 0x4000],
            [GBA_SOUND3_CONTROL_LOW_ADDRESS, 0x00e0],
            [GBA_SOUND3_CONTROL_HIGH_ADDRESS, 0xe000],
            [GBA_SOUND3_CONTROL_X_ADDRESS, 0x4000],
            [GBA_SOUND4_CONTROL_LOW_ADDRESS, 0xff00],
            [GBA_SOUND4_CONTROL_HIGH_ADDRESS, 0x40ff],
            [GBA_SOUND_CONTROL_LOW_ADDRESS, 0xff77],
            [GBA_SOUND_CONTROL_HIGH_ADDRESS, 0x770f],
            [GBA_SOUND_CONTROL_X_ADDRESS, 0x0080],
            [GBA_SOUND_BIAS_ADDRESS, 0xc3fe],
        ];

        for (const [address, expected] of registers) {
            const bus = new GBABus({ rom: new Uint8Array(0x100) });

            bus.write16(GBA_SOUND_CONTROL_X_ADDRESS, 0x0080);
            bus.write16(address, 0xffff);

            assert.equal(bus.read16(address), expected);
        }
    });

    it('maps PSG control, channel status and wave RAM through the bus', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_SOUND1_CONTROL_HIGH_ADDRESS, 0xf080);

        assert.equal(bus.read16(GBA_SOUND1_CONTROL_HIGH_ADDRESS), 0);

        bus.write16(GBA_SOUND_CONTROL_X_ADDRESS, 0x0080);
        bus.write16(GBA_SOUND_CONTROL_LOW_ADDRESS, 0xffff);
        bus.write16(GBA_SOUND1_CONTROL_LOW_ADDRESS, 0x007f);
        bus.write16(GBA_SOUND1_CONTROL_HIGH_ADDRESS, 0xf080);
        bus.write16(GBA_SOUND1_CONTROL_X_ADDRESS, 0xc7f8);
        bus.write16(GBA_SOUND3_CONTROL_LOW_ADDRESS, 0x0080);
        bus.write8(GBA_WAVE_RAM_ADDRESS, 0xab);

        assert.equal(bus.read16(GBA_SOUND_CONTROL_LOW_ADDRESS), 0xff77);
        assert.equal(bus.read16(GBA_SOUND1_CONTROL_LOW_ADDRESS), 0x007f);
        assert.equal(bus.read16(GBA_SOUND1_CONTROL_HIGH_ADDRESS), 0xf080);
        assert.equal(bus.read16(GBA_SOUND1_CONTROL_X_ADDRESS), 0x4000);
        assert.equal(bus.read16(GBA_SOUND_CONTROL_X_ADDRESS), 0x0081);
        assert.equal(bus.read8(GBA_WAVE_RAM_ADDRESS), 0xab);

        bus.write16(GBA_SOUND_CONTROL_X_ADDRESS, 0);

        assert.equal(bus.read16(GBA_SOUND_CONTROL_LOW_ADDRESS), 0);
        assert.equal(bus.read16(GBA_SOUND_CONTROL_X_ADDRESS), 0);
        assert.equal(bus.read8(GBA_WAVE_RAM_ADDRESS), 0xab);
    });

    it('mixes scheduler-clocked PSG output into the public audio buffer', () => {

        const system = new GameBoyAdvanceSystem({
            rom: new Uint8Array(0x100),
            audioSampleRate: 65536,
            audioBufferCapacity: 16,
        });

        system.bus.write16(GBA_SOUND_CONTROL_X_ADDRESS, 0x0080);
        system.bus.write16(GBA_SOUND_CONTROL_LOW_ADDRESS, 0x1177);
        system.bus.write16(GBA_SOUND_CONTROL_HIGH_ADDRESS, 0x0002);
        system.bus.write16(GBA_SOUND1_CONTROL_HIGH_ADDRESS, 0xf080);
        system.bus.write16(GBA_SOUND1_CONTROL_X_ADDRESS, 0x87f8);
        system.scheduler.advance(2048);

        const audio = system.drainAudio();

        assert.equal(audio.left.length, 8);
        assert.deepEqual([...audio.left], [...audio.right]);
        assert.ok(audio.left.some((sample) => sample > 0));
        assert.ok(audio.left.some((sample) => sample < 0));
    });
});
