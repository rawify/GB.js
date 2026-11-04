import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_GPIO_CONTROL_ADDRESS,
    GBA_GPIO_DATA_ADDRESS,
    GBA_GPIO_DIRECTION_ADDRESS,
    GBA_INTERRUPT,
    GBABus,
} from '../../dist/index.mjs';

function createRTCROM() {

    const rom = new Uint8Array(0x1000);

    rom.set(new TextEncoder().encode('SIIRTC_V001'), 0x200);

    return rom;
}

function beginTransfer(bus) {

    bus.write16(GBA_GPIO_DIRECTION_ADDRESS, 0x07);
    bus.write16(GBA_GPIO_DATA_ADDRESS, 0x01);
    bus.write16(GBA_GPIO_DATA_ADDRESS, 0x05);
}

function endTransfer(bus) {

    bus.write16(GBA_GPIO_DIRECTION_ADDRESS, 0x07);
    bus.write16(GBA_GPIO_DATA_ADDRESS, 0x01);
}

function writeSerialByte(bus, value) {

    for (let bit = 0; bit < 8; bit++) {
        const pins = 0x04 | (((value >>> bit) & 1) << 1);

        bus.write16(GBA_GPIO_DATA_ADDRESS, pins);
        bus.write16(GBA_GPIO_DATA_ADDRESS, pins | 1);
    }
}

function writeRTC(bus, command, bytes = []) {

    beginTransfer(bus);
    writeSerialByte(bus, command);

    for (const byte of bytes) {
        writeSerialByte(bus, byte);
    }

    endTransfer(bus);
}

function readRTC(bus, command, byteCount) {

    beginTransfer(bus);
    writeSerialByte(bus, command);
    bus.write16(GBA_GPIO_DIRECTION_ADDRESS, 0x05);

    const bytes = [];

    for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
        let byte = 0;

        for (let bit = 0; bit < 8; bit++) {
            bus.write16(GBA_GPIO_DATA_ADDRESS, 0x04);
            byte |= ((bus.read16(GBA_GPIO_DATA_ADDRESS) >>> 1) & 1) << bit;
            bus.write16(GBA_GPIO_DATA_ADDRESS, 0x05);
        }

        bytes.push(byte);
    }

    endTransfer(bus);

    return bytes;
}

describe('GBA cartridge GPIO and RTC', () => {

    it('detects RTC SDK signatures and maps direction-controlled GPIO pins', () => {

        const bus = new GBABus({ rom: createRTCROM() });

        assert.ok(bus.gpio);
        assert.equal(bus.read16(GBA_GPIO_DATA_ADDRESS), 0);

        bus.write16(GBA_GPIO_CONTROL_ADDRESS, 1);
        bus.write16(GBA_GPIO_DIRECTION_ADDRESS, 0x07);
        bus.write16(GBA_GPIO_DATA_ADDRESS, 0x05);

        assert.equal(bus.read16(GBA_GPIO_CONTROL_ADDRESS), 1);
        assert.equal(bus.read16(GBA_GPIO_DIRECTION_ADDRESS), 0x07);
        assert.equal(bus.read16(GBA_GPIO_DATA_ADDRESS), 0x05);

        bus.write16(GBA_GPIO_DIRECTION_ADDRESS, 0x05);
        assert.equal(bus.read16(GBA_GPIO_DATA_ADDRESS), 0x07);
    });

    it('leaves ordinary ROM bytes untouched without RTC hardware', () => {

        const rom = new Uint8Array(0x1000);

        rom[GBA_GPIO_DATA_ADDRESS & 0xfff] = 0x34;
        rom[(GBA_GPIO_DATA_ADDRESS & 0xfff) + 1] = 0x12;

        const bus = new GBABus({ rom });

        assert.equal(bus.gpio, undefined);
        assert.equal(bus.read16(GBA_GPIO_DATA_ADDRESS), 0x1234);
        bus.write16(GBA_GPIO_DATA_ADDRESS, 0xffff);
        assert.equal(bus.read16(GBA_GPIO_DATA_ADDRESS), 0x1234);

        const disabled = new GBABus({ rom: createRTCROM(), rtc: false });

        assert.equal(disabled.gpio, undefined);
    });

    it('reads deterministic BCD date and time in 24-hour and 12-hour modes', () => {

        const timestamp = new Date(2024, 6, 14, 23, 58, 59).getTime();
        const bus = new GBABus({
            rom: createRTCROM(),
            rtc: { now: () => timestamp },
        });

        bus.write16(GBA_GPIO_CONTROL_ADDRESS, 1);

        assert.deepEqual(readRTC(bus, 0xa6, 7), [0x24, 0x07, 0x14, 0x00, 0x23, 0x58, 0x59]);
        assert.deepEqual(readRTC(bus, 0xc6, 1), [0x40]);
        assert.deepEqual(readRTC(bus, 0x63, 1), [0x40]);

        writeRTC(bus, 0x46, [0x00]);
        assert.deepEqual(readRTC(bus, 0xe6, 3), [0x91, 0x58, 0x59]);
    });

    it('accepts RTC writes, restores persistent state, and requests Game Pak IRQ', () => {

        const timestamp = new Date(2024, 0, 1, 0, 0, 0).getTime();
        const writes = [];
        const bus = new GBABus({
            rom: new Uint8Array(0x1000),
            rtc: {
                now: () => timestamp,
                onWrite: (state) => writes.push(state),
            },
        });

        bus.write16(GBA_GPIO_CONTROL_ADDRESS, 1);
        writeRTC(bus, 0x66, [0x17, 0x34, 0x56]);

        assert.deepEqual(readRTC(bus, 0xe6, 3), [0x17, 0x34, 0x56]);
        assert.equal(writes.length, 1);

        const state = bus.gpio.rtc.getState();
        const restored = new GBABus({
            rom: new Uint8Array(0x1000),
            rtc: { initialState: state, now: () => timestamp },
        });

        restored.write16(GBA_GPIO_CONTROL_ADDRESS, 1);
        assert.deepEqual(readRTC(restored, 0xe6, 3), [0x17, 0x34, 0x56]);

        restored.reset();
        restored.write16(GBA_GPIO_CONTROL_ADDRESS, 1);
        assert.deepEqual(readRTC(restored, 0xe6, 3), [0x17, 0x34, 0x56]);

        writeRTC(bus, 0x36);
        assert.equal(bus.interrupts.requested & GBA_INTERRUPT.gamePak, GBA_INTERRUPT.gamePak);
    });
});
