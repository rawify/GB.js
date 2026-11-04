import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GAME_BOY_LOGO,
    MBC3Cartridge,
    calculateGameBoyHeaderChecksum,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

function createROM(type, sizeCode, bankCount, ramSizeCode = 0) {

    const rom = new Uint8Array(bankCount * 0x4000);

    for (let bank = 0; bank < bankCount; bank++) {
        rom[bank * 0x4000] = bank & 0xff;
        rom[bank * 0x4000 + 1] = bank >> 8;
    }

    rom.set(GAME_BOY_LOGO, 0x0104);
    rom.set([0x54, 0x45, 0x53, 0x54], 0x0134);
    rom[0x0147] = type;
    rom[0x0148] = sizeCode;
    rom[0x0149] = ramSizeCode;
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    return rom;
}

describe('Game Boy memory bank controllers', () => {

    it('maps MBC1 ROM and RAM banks in both modes', () => {

        const cartridge = createGameBoyCartridge(createROM(0x03, 0x05, 64, 0x03));

        assert.equal(cartridge.read(0x4000), 1);

        cartridge.write(0x2000, 0x02);
        assert.equal(cartridge.read(0x4000), 2);

        cartridge.write(0x4000, 0x01);
        assert.equal(cartridge.read(0x4000), 34);
        assert.equal(cartridge.read(0x0000), 0);

        cartridge.write(0x6000, 0x01);
        assert.equal(cartridge.read(0x0000), 32);

        cartridge.write(0x0000, 0x0a);
        cartridge.write(0xa000, 0x42);
        cartridge.write(0x4000, 0x00);
        cartridge.write(0xa000, 0x24);
        cartridge.write(0x4000, 0x01);
        assert.equal(cartridge.read(0xa000), 0x42);

        cartridge.reset();
        assert.equal(cartridge.read(0x4000), 1);
        assert.equal(cartridge.read(0xa000), 0xff);
        cartridge.write(0x0000, 0x0a);
        assert.equal(cartridge.read(0xa000), 0x24);
    });

    it('uses the full MBC1 low register for forbidden-bank translation', () => {

        const cartridge = createGameBoyCartridge(createROM(0x01, 0x03, 16));

        cartridge.write(0x2000, 0x00);
        assert.equal(cartridge.read(0x4000), 1);

        cartridge.write(0x2000, 0x10);
        assert.equal(cartridge.read(0x4000), 0);
    });

    it('detects MBC1M multicart wiring from the bank 0x10 header', () => {

        const rom = createROM(0x01, 0x05, 64);

        rom.set(GAME_BOY_LOGO, 0x10 * 0x4000 + 0x0104);

        const cartridge = createGameBoyCartridge(rom);

        cartridge.write(0x4000, 0x01);
        cartridge.write(0x2000, 0x02);
        assert.equal(cartridge.read(0x4000), 0x12);

        cartridge.write(0x6000, 0x01);
        assert.equal(cartridge.read(0x0000), 0x10);
    });

    it('implements MBC2 address gating, nibble RAM and mirrors', () => {

        const cartridge = createGameBoyCartridge(createROM(0x06, 0x03, 16));

        cartridge.write(0x2100, 0x03);
        assert.equal(cartridge.read(0x4000), 3);

        cartridge.write(0x0000, 0x0a);
        cartridge.write(0xa123, 0xab);
        assert.equal(cartridge.read(0xa123), 0xfb);
        assert.equal(cartridge.read(0xa323), 0xfb);
    });

    it('latches a deterministic MBC3 clock', () => {

        let now = 0;
        const cartridge = createGameBoyCartridge(createROM(0x10, 0x00, 2, 0x03), {
            now: () => now,
        });

        assert.ok(cartridge instanceof MBC3Cartridge);
        cartridge.write(0x0000, 0x0a);
        cartridge.write(0x4000, 0x08);
        cartridge.write(0x6000, 0x00);
        cartridge.write(0x6000, 0x01);
        assert.equal(cartridge.read(0xa000), 0);

        now = 1000;
        assert.equal(cartridge.read(0xa000), 0);

        cartridge.write(0x6000, 0x00);
        cartridge.write(0x6000, 0x01);
        assert.equal(cartridge.read(0xa000), 1);
    });

    it('halts and overflows the MBC3 day counter deterministically', () => {

        let now = 0;
        const cartridge = createGameBoyCartridge(createROM(0x10, 0x00, 2, 0x03), {
            now: () => now,
        });

        assert.ok(cartridge instanceof MBC3Cartridge);
        cartridge.loadRTCState({
            registers: Uint8Array.of(59, 59, 23, 0xff, 0x01),
            latchedRegisters: new Uint8Array(5),
            lastUpdated: 0,
        });

        now = 1000;
        cartridge.write(0x0000, 0x0a);
        cartridge.write(0x6000, 0x00);
        cartridge.write(0x6000, 0x01);

        cartridge.write(0x4000, 0x08);
        assert.equal(cartridge.read(0xa000), 0);
        cartridge.write(0x4000, 0x0b);
        assert.equal(cartridge.read(0xa000), 0);
        cartridge.write(0x4000, 0x0c);
        assert.equal(cartridge.read(0xa000), 0x80);

        cartridge.write(0xa000, 0x40);
        now = 11_000;
        cartridge.write(0x6000, 0x00);
        cartridge.write(0x6000, 0x01);
        cartridge.write(0x4000, 0x08);
        assert.equal(cartridge.read(0xa000), 0);
    });

    it('does not expose RTC registers on timerless MBC3 cartridges', () => {

        const cartridge = createGameBoyCartridge(createROM(0x13, 0x00, 2, 0x03));

        cartridge.write(0x0000, 0x0a);
        cartridge.write(0x4000, 0x08);
        cartridge.write(0xa000, 0x2a);
        cartridge.write(0x6000, 0x00);
        cartridge.write(0x6000, 0x01);
        assert.equal(cartridge.read(0xa000), 0xff);
    });

    it('supports the ninth MBC5 ROM bit and rumble bank masking', () => {

        const rumble = [];
        const cartridge = createGameBoyCartridge(createROM(0x1e, 0x08, 512, 0x04), {
            onRumble: (enabled) => rumble.push(enabled),
        });

        cartridge.write(0x2000, 0x00);
        cartridge.write(0x3000, 0x01);
        assert.equal(cartridge.read(0x4000), 0);
        assert.equal(cartridge.read(0x4001), 1);

        cartridge.write(0x4000, 0x0b);
        cartridge.write(0x4000, 0x03);
        assert.deepEqual(rumble, [true, false]);

        cartridge.write(0x4000, 0x08);
        cartridge.reset();
        assert.deepEqual(rumble, [true, false, true, false]);
    });

    it('rejects recognized but unsupported cartridge hardware', () => {

        assert.throws(
            () => createGameBoyCartridge(createROM(0x22, 0x00, 2)),
            /recognized but not implemented/i,
        );
    });
});
