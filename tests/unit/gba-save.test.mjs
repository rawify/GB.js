import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBABus,
    GBA_FLASH1M_SIZE,
    GBA_FLASH512_SIZE,
    GBA_SRAM_SIZE,
} from '../../dist/index.mjs';

const SAVE_ADDRESS = 0x0e000000;

function createSaveROM(signature) {

    const rom = new Uint8Array(0x100000);

    rom.set(new TextEncoder().encode(signature), 0x100);

    return rom;
}

function flashCommand(bus, command) {

    bus.write8(SAVE_ADDRESS + 0x5555, 0xaa);
    bus.write8(SAVE_ADDRESS + 0x2aaa, 0x55);
    bus.write8(SAVE_ADDRESS + 0x5555, command);
}

function programFlash(bus, offset, value) {

    flashCommand(bus, 0xa0);
    bus.write8(SAVE_ADDRESS + offset, value);
}

function selectFlashBank(bus, bank) {

    flashCommand(bus, 0xb0);
    bus.write8(SAVE_ADDRESS, bank);
}

describe('GBA cartridge save memory', () => {

    it('detects SRAM and mirrors its 32-KiB byte bus', () => {

        const writes = [];
        const bus = new GBABus({
            rom: createSaveROM('SRAM_V113'),
            onSaveWrite: (data) => writes.push(data),
        });

        assert.equal(bus.save?.type, 'sram');
        assert.equal(bus.save?.byteLength, GBA_SRAM_SIZE);
        assert.equal(bus.read8(SAVE_ADDRESS), 0xff);

        bus.write8(SAVE_ADDRESS + 0x1234, 0x5a);

        assert.equal(bus.read8(SAVE_ADDRESS + 0x9234), 0x5a);
        assert.equal(bus.read16(SAVE_ADDRESS + 0x1234), 0x5a5a);
        assert.equal(bus.read32(SAVE_ADDRESS + 0x1234), 0x5a5a5a5a);
        assert.equal(writes.length, 1);
        assert.equal(writes[0][0x1234], 0x5a);
    });

    it('writes only the low byte of wide save-bus stores', () => {

        const bus = new GBABus({ rom: createSaveROM('SRAM_F_V110') });

        bus.write16(SAVE_ADDRESS + 2, 0xabcd);
        bus.write32(SAVE_ADDRESS + 4, 0x12345678);

        assert.equal(bus.read8(SAVE_ADDRESS + 2), 0xcd);
        assert.equal(bus.read8(SAVE_ADDRESS + 3), 0xff);
        assert.equal(bus.read8(SAVE_ADDRESS + 4), 0x78);
        assert.equal(bus.read8(SAVE_ADDRESS + 5), 0xff);
    });

    it('implements Flash512 identification, programming, and erasure', () => {

        const writes = [];
        const bus = new GBABus({
            rom: createSaveROM('FLASH512_V131'),
            onSaveWrite: (data) => writes.push(data),
        });

        assert.equal(bus.save?.type, 'flash512');
        assert.equal(bus.save?.byteLength, GBA_FLASH512_SIZE);

        flashCommand(bus, 0x90);
        assert.equal(bus.read8(SAVE_ADDRESS), 0x32);
        assert.equal(bus.read8(SAVE_ADDRESS + 1), 0x1b);
        bus.write8(SAVE_ADDRESS, 0xf0);

        programFlash(bus, 0x2345, 0x5a);
        programFlash(bus, 0x3456, 0xa5);
        programFlash(bus, 0x4567, 0xf0);
        assert.equal(bus.read8(SAVE_ADDRESS + 0x2345), 0x5a);
        assert.equal(bus.read8(SAVE_ADDRESS + 0x3456), 0xa5);
        assert.equal(bus.read8(SAVE_ADDRESS + 0x4567), 0xf0);

        flashCommand(bus, 0x80);
        bus.write8(SAVE_ADDRESS + 0x5555, 0xaa);
        bus.write8(SAVE_ADDRESS + 0x2aaa, 0x55);
        bus.write8(SAVE_ADDRESS + 0x2000, 0x30);

        assert.equal(bus.read8(SAVE_ADDRESS + 0x2345), 0xff);
        assert.equal(bus.read8(SAVE_ADDRESS + 0x3456), 0xa5);
        assert.equal(writes.length, 4);
    });

    it('switches Flash1M banks and persists both banks', () => {

        const bus = new GBABus({ rom: createSaveROM('FLASH1M_V103') });

        assert.equal(bus.save?.type, 'flash1m');
        assert.equal(bus.save?.byteLength, GBA_FLASH1M_SIZE);

        programFlash(bus, 0x1234, 0x11);
        selectFlashBank(bus, 1);
        programFlash(bus, 0x1234, 0x22);
        assert.equal(bus.read8(SAVE_ADDRESS + 0x1234), 0x22);

        selectFlashBank(bus, 0);
        assert.equal(bus.read8(SAVE_ADDRESS + 0x1234), 0x11);
        assert.equal(bus.save?.dump()[GBA_FLASH512_SIZE + 0x1234], 0x22);
    });
});
