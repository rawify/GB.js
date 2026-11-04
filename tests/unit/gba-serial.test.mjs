import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_INTERRUPT,
    GBA_JOY_BUS_CONTROL_ADDRESS,
    GBA_JOY_BUS_RECEIVE_ADDRESS,
    GBA_JOY_BUS_STATUS_ADDRESS,
    GBA_JOY_BUS_TRANSMIT_ADDRESS,
    GBA_SIO_CONTROL_ADDRESS,
    GBA_SIO_DATA_32_ADDRESS,
    GBA_SIO_DATA_8_ADDRESS,
    GBA_SIO_MODE_CONTROL_ADDRESS,
    GBABus,
    GBAInterruptController,
    GBASerial,
} from '../../dist/index.mjs';

describe('GBA serial I/O', () => {

    it('applies mode-specific register masks', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const modes = [
            { control: 0x2000, expectedControl: 0x6f8f, expectedMode: 0x01ff },
            { control: 0x0000, expectedControl: 0x4f8f, expectedMode: 0x01f5 },
            { control: 0x1000, expectedControl: 0x5f8f, expectedMode: 0x01f5 },
            { control: 0x3000, expectedControl: 0x7faf, expectedMode: 0x01ff },
        ];

        for (const mode of modes) {
            bus.write16(GBA_SIO_MODE_CONTROL_ADDRESS, 0);
            bus.write16(GBA_SIO_CONTROL_ADDRESS, mode.control);
            bus.write16(GBA_SIO_CONTROL_ADDRESS, (mode.control & 0x3000) | 0xcfff);
            bus.write16(GBA_SIO_MODE_CONTROL_ADDRESS, 0x3fff);

            assert.equal(bus.read16(GBA_SIO_CONTROL_ADDRESS), mode.expectedControl);
            assert.equal(bus.read16(GBA_SIO_MODE_CONTROL_ADDRESS), mode.expectedMode);
        }

        bus.write16(GBA_SIO_MODE_CONTROL_ADDRESS, 0xbfff);
        assert.equal(bus.read16(GBA_SIO_MODE_CONTROL_ADDRESS), 0x81ff);

        bus.write16(GBA_SIO_MODE_CONTROL_ADDRESS, 0xffff);
        assert.equal(bus.read16(GBA_SIO_MODE_CONTROL_ADDRESS), 0xc1fc);
    });

    it('maps normal, multiplayer, UART and Joy Bus data registers', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_SIO_CONTROL_ADDRESS, 0x1000);
        bus.write32(GBA_SIO_DATA_32_ADDRESS, 0x89abcdef);
        assert.equal(bus.read32(GBA_SIO_DATA_32_ADDRESS), 0x89abcdef);

        bus.write16(GBA_SIO_CONTROL_ADDRESS, 0);
        bus.write16(GBA_SIO_DATA_8_ADDRESS, 0x55aa);
        assert.equal(bus.read16(GBA_SIO_DATA_8_ADDRESS), 0x55aa);

        bus.write16(GBA_SIO_CONTROL_ADDRESS, 0x2000);
        bus.write16(GBA_SIO_DATA_8_ADDRESS, 0x1234);
        assert.equal(bus.read16(GBA_SIO_DATA_8_ADDRESS), 0x1234);
        assert.equal(bus.read32(GBA_SIO_DATA_32_ADDRESS), 0);

        bus.write16(GBA_SIO_CONTROL_ADDRESS, 0x3000);
        bus.write32(GBA_SIO_DATA_32_ADDRESS, 0xffffffff);
        bus.write16(GBA_SIO_DATA_8_ADDRESS, 0xffff);
        assert.equal(bus.read32(GBA_SIO_DATA_32_ADDRESS), 0);
        assert.equal(bus.read16(GBA_SIO_DATA_8_ADDRESS), 0);

        bus.write16(GBA_JOY_BUS_CONTROL_ADDRESS, 0xffff);
        bus.write32(GBA_JOY_BUS_RECEIVE_ADDRESS, 0xffffffff);
        bus.write32(GBA_JOY_BUS_TRANSMIT_ADDRESS, 0xffffffff);
        bus.write16(GBA_JOY_BUS_STATUS_ADDRESS, 0xffff);

        assert.equal(bus.read16(GBA_JOY_BUS_CONTROL_ADDRESS), 0x0040);
        assert.equal(bus.read32(GBA_JOY_BUS_RECEIVE_ADDRESS), 0);
        assert.equal(bus.read32(GBA_JOY_BUS_TRANSMIT_ADDRESS), 0);
        assert.equal(bus.read16(GBA_JOY_BUS_STATUS_ADDRESS), 0);
    });

    it('clocks normal 8-bit transfers and requests the serial interrupt', () => {

        const interrupts = new GBAInterruptController();
        const outgoingBits = [];
        const serial = new GBASerial(interrupts, {
            exchangeBit: (outgoingBit) => {

                outgoingBits.push(outgoingBit);

                return outgoingBit === 0 ? 1 : 0;
            },
        });

        serial.writeByte(0x12a, 0xa5);
        serial.writeByte(0x128, 0x81);
        serial.writeByte(0x129, 0x40);
        serial.tick(521);

        assert.equal(serial.readByte(0x128) & 0x80, 0x80);
        assert.equal(interrupts.requested, 0);

        serial.tick(1);

        assert.deepEqual(outgoingBits, [1, 0, 1, 0, 0, 1, 0, 1]);
        assert.equal(serial.readByte(0x12a), 0x5a);
        assert.equal(serial.readByte(0x128) & 0x80, 0);
        assert.equal(interrupts.requested, GBA_INTERRUPT.serial);
    });

    it('clocks fast normal 32-bit transfers after the ten-cycle start delay', () => {

        const interrupts = new GBAInterruptController();
        const serial = new GBASerial(interrupts);

        for (let index = 0; index < 4; index++) {
            serial.writeByte(0x120 + index, 0);
        }
        serial.writeByte(0x128, 0x83);
        serial.writeByte(0x129, 0x50);
        serial.tick(265);

        assert.equal(serial.readByte(0x128) & 0x80, 0x80);

        serial.tick(1);

        assert.equal(serial.readByte(0x128) & 0x80, 0);
        assert.equal(
            serial.readByte(0x120)
                | (serial.readByte(0x121) << 8)
                | (serial.readByte(0x122) << 16)
                | (serial.readByte(0x123) << 24),
            -1,
        );
    });

    it('accepts externally clocked normal transfers without advancing itself', () => {

        const interrupts = new GBAInterruptController();
        const serial = new GBASerial(interrupts);

        serial.writeByte(0x12a, 0x80);
        serial.writeByte(0x128, 0x80);
        serial.tick(10_000);

        assert.equal(serial.readByte(0x128) & 0x80, 0x80);
        assert.equal(serial.clockNormal(0), 1);

        for (let bit = 1; bit < 8; bit++) {
            serial.clockNormal(0);
        }

        assert.equal(serial.readByte(0x12a), 0);
        assert.equal(serial.readByte(0x128) & 0x80, 0);
    });
});
