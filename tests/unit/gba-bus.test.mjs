import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_BIOS_SIZE,
    GBA_DISPLAY_CONTROL_ADDRESS,
    GBA_MAX_ROM_SIZE,
    GBA_WAITCNT_ADDRESS,
    GBABus,
} from '../../dist/index.mjs';

function createBus(options = {}) {

    const rom = options.rom ?? new Uint8Array(0x100);

    return new GBABus({ rom, ...options });
}

describe('GBA bus', () => {

    it('maps BIOS, mirrored RAM, video memory and Game Pak windows', () => {

        const bootROM = new Uint8Array(GBA_BIOS_SIZE);
        const rom = new Uint8Array(0x100);

        bootROM[0] = 0x31;
        bootROM[0x3fff] = 0xea;
        rom[0] = 0x42;

        const bus = createBus({ bootROM, rom });

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0080);

        assert.equal(bus.read8(0x00000000), 0x31);
        assert.equal(bus.read8(0x00003fff), 0xea);

        bus.write8(0x02000000, 0x12);
        bus.write8(0x03000000, 0x34);
        bus.write8(0x04000002, 0x56);
        bus.write16(0x05000000, 0x789a);
        bus.write16(0x06010000, 0xbcde);
        bus.write16(0x07000000, 0xf012);

        assert.equal(bus.read8(0x02040000), 0x12);
        assert.equal(bus.read8(0x03008000), 0x34);
        assert.equal(bus.read8(0x04000002), 0x56);
        assert.equal(bus.read16(0x05000400), 0x789a);
        assert.equal(bus.read16(0x06018000), 0xbcde);
        assert.equal(bus.read16(0x07000400), 0xf012);
        assert.equal(bus.read8(0x08000000), 0x42);
        assert.equal(bus.read8(0x0a000000), 0x42);
        assert.equal(bus.read8(0x0c000000), 0x42);
    });

    it('performs aligned little-endian halfword and word transfers', () => {

        const bus = createBus();

        bus.write32(0x03000001, 0x89abcdef);

        assert.equal(bus.read8(0x03000000), 0xef);
        assert.equal(bus.read16(0x03000001), 0xcdef);
        assert.equal(bus.read32(0x03000003), 0x89abcdef);
    });

    it('applies byte-write behavior for palette, BG/OBJ VRAM and OAM', () => {

        const bus = createBus();

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0080);

        bus.write8(0x05000001, 0x12);
        bus.write8(0x06000001, 0x34);
        bus.write16(0x06010000, 0x5678);
        bus.write8(0x06010000, 0x9a);
        bus.write16(0x07000000, 0x5678);
        bus.write8(0x07000000, 0x9a);

        assert.equal(bus.read16(0x05000000), 0x1212);
        assert.equal(bus.read16(0x06000000), 0x3434);
        assert.equal(bus.read16(0x06010000), 0x5678);
        assert.equal(bus.read16(0x07000000), 0x5678);

        bus.write8(0x04000000, 3);
        bus.write8(0x06010000, 0xbc);
        bus.write16(0x06014000, 0xdef0);
        bus.write8(0x06014000, 0x12);

        assert.equal(bus.read16(0x06010000), 0xbcbc);
        assert.equal(bus.read16(0x06014000), 0xdef0);
    });

    it('classifies timing regions independently of their mirrored storage', () => {

        const bus = createBus();

        assert.equal(bus.regionAt(0x00004000), 'unmapped');
        assert.equal(bus.regionAt(0x02040000), 'ewram');
        assert.equal(bus.regionAt(0x08000000), 'game-pak-0');
        assert.equal(bus.regionAt(0x0a000000), 'game-pak-1');
        assert.equal(bus.regionAt(0x0c000000), 'game-pak-2');
        assert.equal(bus.regionAt(0x0e000000), 'save');
    });

    it('uses the configured open-bus word for absent and unmapped storage', () => {

        const bus = createBus();

        bus.setOpenBus(0x44332211);

        assert.equal(bus.read8(0x01000000), 0x11);
        assert.equal(bus.read8(0x01000001), 0x22);
        assert.equal(bus.read16(0x01000002), 0x4433);
        assert.equal(bus.read32(0x01000000), 0x44332211);
        assert.equal(bus.read8(0x08000100), 0x11);
    });

    it('validates immutable memory sizes and resets mutable storage', () => {

        assert.throws(
            () => createBus({ bootROM: new Uint8Array(GBA_BIOS_SIZE - 1) }),
            /exactly 16384 bytes/,
        );
        assert.throws(
            () => createBus({ rom: new Uint8Array(GBA_MAX_ROM_SIZE + 1) }),
            /cannot exceed 32 MiB/,
        );

        const bus = createBus();

        bus.write8(0x02000000, 0xff);
        bus.write8(0x04000000, 0xff);
        bus.setOpenBus(0xffffffff);
        bus.reset();

        assert.equal(bus.read8(0x02000000), 0);
        assert.equal(bus.read8(0x04000000), 0);
        assert.equal(bus.openBus, 0);
    });

    it('maps WAITCNT and applies Game Pak first and second access timings', () => {

        const bus = createBus();

        assert.equal(bus.waitControl, 0);
        assert.equal(bus.prefetchEnabled, false);
        assert.equal(bus.accessCycles(0x08000000, 16), 4);
        assert.equal(bus.accessCycles(0x08000000, 32), 6);
        assert.equal(bus.accessCycles(0x08000000, 32, 'sequential'), 4);
        assert.equal(bus.accessCycles(0x0a000000, 32), 8);
        assert.equal(bus.accessCycles(0x0c000000, 32), 12);

        bus.write16(GBA_WAITCNT_ADDRESS, 0x47ff);

        assert.equal(bus.waitControl, 0x47ff);
        assert.equal(bus.prefetchEnabled, true);
        assert.equal(bus.accessCycles(0x08000000, 16), 8);
        assert.equal(bus.accessCycles(0x08000000, 16, 'sequential'), 1);
        assert.equal(bus.accessCycles(0x0a000000, 32), 9);
        assert.equal(bus.accessCycles(0x0a000000, 32, 'sequential'), 2);
        assert.equal(bus.accessCycles(0x0c000000, 32), 9);
        assert.equal(bus.accessCycles(0x0c000000, 32, 'sequential'), 2);

        bus.write16(GBA_WAITCNT_ADDRESS, 0xffff);
        assert.equal(bus.waitControl, 0x5fff);
    });

    it('accounts for physical bus widths outside Game Pak ROM', () => {

        const bus = createBus();

        assert.equal(bus.accessCycles(0x00000000, 32), 1);
        assert.equal(bus.accessCycles(0x02000000, 8), 3);
        assert.equal(bus.accessCycles(0x02000000, 16), 3);
        assert.equal(bus.accessCycles(0x02000000, 32), 6);
        assert.equal(bus.accessCycles(0x03000000, 32), 1);
        assert.equal(bus.accessCycles(0x05000000, 32), 2);
        assert.equal(bus.accessCycles(0x06000000, 32), 2);
        assert.equal(bus.accessCycles(0x07000000, 32), 1);
        assert.equal(bus.accessCycles(0x0e000000, 8), 4);
        assert.equal(bus.accessCycles(0x0e000000, 32), 16);
    });
});
