import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GBABus } from '../../dist/index.mjs';

const DMA3_SOURCE = 0x040000d4;
const DMA3_DESTINATION = 0x040000d8;
const DMA3_COUNT = 0x040000dc;
const DMA3_CONTROL = 0x040000de;
const EEPROM_ADDRESS = 0x0d000000;

function createEEPROMBus() {

    const rom = new Uint8Array(0x100000);

    rom.set(new TextEncoder().encode('EEPROM_V122'), 0x100);

    return new GBABus({ rom });
}

function runDMA3(bus, source, destination, count, control) {

    bus.write32(DMA3_SOURCE, source);
    bus.write32(DMA3_DESTINATION, destination);
    bus.write16(DMA3_COUNT, count);
    bus.write16(DMA3_CONTROL, 0x8000 | control);
    bus.dma.runPending();
}

function writeBits(bus, address, bits) {

    for (let index = 0; index < bits.length; index++) {
        bus.write16(address + index * 2, bits[index] ?? 0);
    }
}

function byteBits(bytes) {

    const bits = [];

    for (const byte of bytes) {
        for (let bit = 7; bit >= 0; bit--) {
            bits.push((byte >>> bit) & 1);
        }
    }

    return bits;
}

describe('GBA EEPROM', () => {

    it('detects EEPROM ROMs and transfers 64-bit blocks through DMA3', () => {

        const bus = createEEPROMBus();
        const commandAddress = 0x02000000;
        const outputAddress = 0x02000200;
        const block = 2;
        const addressBits = [0, 0, 0, 0, 1, 0];
        const data = Uint8Array.of(0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0);
        const writeCommand = [1, 0, ...addressBits, ...byteBits(data), 0];

        assert.equal(bus.regionAt(EEPROM_ADDRESS), 'eeprom');

        writeBits(bus, commandAddress, writeCommand);
        runDMA3(bus, commandAddress, EEPROM_ADDRESS, 73, 0x0040);

        assert.deepEqual([...bus.eeprom.dump().slice(block * 8, block * 8 + 8)], [...data]);

        const readCommand = [1, 1, ...addressBits, 0];

        writeBits(bus, commandAddress, readCommand);
        runDMA3(bus, commandAddress, EEPROM_ADDRESS, 9, 0x0040);
        runDMA3(bus, EEPROM_ADDRESS, outputAddress, 68, 0x0100);

        const output = [];

        for (let index = 0; index < 68; index++) {
            output.push(bus.read16(outputAddress + index * 2) & 1);
        }

        assert.deepEqual(output.slice(0, 4), [0, 0, 0, 0]);
        assert.deepEqual(output.slice(4), byteBits(data));
    });

    it('leaves the wait-state-2 ROM window intact without an EEPROM signature', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100000) });

        assert.equal(bus.eeprom, undefined);
        assert.equal(bus.regionAt(EEPROM_ADDRESS), 'game-pak-2');
    });
});
