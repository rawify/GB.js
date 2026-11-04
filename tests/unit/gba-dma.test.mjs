import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_EXCEPTION,
    ARM_MODE,
    GBA_DISPLAY_CONTROL_ADDRESS,
    GBA_DMA_BASE_ADDRESS,
    GBA_INTERRUPT,
    GBA_INTERRUPT_ENABLE_ADDRESS,
    GBA_INTERRUPT_MASTER_ENABLE_ADDRESS,
    GBAInterruptController,
    GBADMA,
    GBABus,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

function writeRegister(dma, channel, register, value, bytes) {

    for (let byte = 0; byte < bytes; byte++) {
        dma.writeByte(channel, register + byte, value >>> (byte * 8));
    }
}

describe('GBA DMA', () => {

    it('copies immediate halfwords, advances addresses and disables on completion', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const interrupts = new GBAInterruptController();
        const dma = new GBADMA(bus, interrupts);

        bus.write16(0x03000000, 0x1234);
        bus.write16(0x03000002, 0x5678);
        writeRegister(dma, 0, 0, 0x03000000, 4);
        writeRegister(dma, 0, 4, 0x02000000, 4);
        writeRegister(dma, 0, 8, 2, 2);
        writeRegister(dma, 0, 10, 0x8000, 2);

        assert.equal(dma.hasPending, true);
        assert.equal(dma.runPending(), 10);
        assert.equal(bus.read16(0x02000000), 0x1234);
        assert.equal(bus.read16(0x02000002), 0x5678);
        assert.equal(dma.readByte(0, 11) & 0x80, 0);
    });

    it('performs 32-bit fixed/decrement transfers and requests completion IRQ', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const interrupts = new GBAInterruptController();
        const dma = new GBADMA(bus, interrupts);

        bus.write32(0x03000004, 0x11223344);
        bus.write32(0x03000008, 0xaabbccdd);
        writeRegister(dma, 3, 0, 0x03000008, 4);
        writeRegister(dma, 3, 4, 0x02000000, 4);
        writeRegister(dma, 3, 8, 2, 2);
        writeRegister(dma, 3, 10, 0xc4c0, 2);

        dma.runPending();

        assert.equal(bus.read32(0x02000000), 0x11223344);
        assert.equal(interrupts.requested, GBA_INTERRUPT.dma3);
    });

    it('reuses the internal DMA latch for source addresses below EWRAM', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const dma = bus.dma;

        bus.write32(0x03000000, 0xcafebabe);
        writeRegister(dma, 0, 0, 0x03000000, 4);
        writeRegister(dma, 0, 4, 0x02000000, 4);
        writeRegister(dma, 0, 8, 1, 2);
        writeRegister(dma, 0, 10, 0x8400, 2);
        dma.runPending();

        writeRegister(dma, 0, 0, 0x00000000, 4);
        writeRegister(dma, 0, 4, 0x02000004, 4);
        writeRegister(dma, 0, 8, 1, 2);
        writeRegister(dma, 0, 10, 0x8400, 2);
        dma.runPending();

        assert.equal(bus.read32(0x02000004), 0xcafebabe);

        dma.reset();
        writeRegister(dma, 0, 0, 0x00000000, 4);
        writeRegister(dma, 0, 4, 0x02000008, 4);
        writeRegister(dma, 0, 8, 1, 2);
        writeRegister(dma, 0, 10, 0x8400, 2);
        dma.runPending();

        assert.equal(bus.read32(0x02000008), 0);
    });

    it('forces Game Pak ROM source addresses to increment', () => {

        const rom = new Uint8Array(0x100);
        const view = new DataView(rom.buffer);

        view.setUint32(0, 0xdeadbeef, true);
        view.setUint32(4, 0x12345678, true);

        const bus = new GBABus({ rom });
        const dma = bus.dma;

        writeRegister(dma, 1, 0, 0x08000000, 4);
        writeRegister(dma, 1, 4, 0x02000000, 4);
        writeRegister(dma, 1, 8, 4, 2);
        writeRegister(dma, 1, 10, 0x8140, 2);
        dma.runPending();

        assert.equal(bus.read16(0x02000000), 0x1234);
    });

    it('waits for timing triggers and repeats with destination reload', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const interrupts = new GBAInterruptController();
        const dma = new GBADMA(bus, interrupts);

        bus.write16(0x03000000, 1);
        bus.write16(0x03000002, 2);
        writeRegister(dma, 1, 0, 0x03000000, 4);
        writeRegister(dma, 1, 4, 0x02000000, 4);
        writeRegister(dma, 1, 8, 1, 2);
        writeRegister(dma, 1, 10, 0x9260, 2);

        assert.equal(dma.hasPending, false);

        dma.trigger('vblank');
        dma.runPending();
        assert.equal(bus.read16(0x02000000), 1);
        assert.notEqual(dma.readByte(1, 11) & 0x80, 0);

        dma.trigger('vblank');
        dma.runPending();
        assert.equal(bus.read16(0x02000000), 2);
    });

    it('masks channel-specific registers and exposes only count/control', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const dma = new GBADMA(bus, new GBAInterruptController());

        writeRegister(dma, 0, 0, 0xffffffff, 4);
        writeRegister(dma, 0, 4, 0xffffffff, 4);
        writeRegister(dma, 0, 8, 0xffff, 2);
        writeRegister(dma, 0, 10, 0xffff, 2);

        assert.deepEqual(Array.from({ length: 8 }, (_, index) => dma.readByte(0, index)), Array(8).fill(0));
        assert.equal(dma.readByte(0, 8), 0xff);
        assert.equal(dma.readByte(0, 9), 0x3f);
        assert.equal(dma.readByte(0, 10), 0xe0);
        assert.equal(dma.readByte(0, 11), 0xf7);
        assert.throws(() => dma.readByte(4, 0), /outside 0-3/);
    });

    it('maps all DMA registers and executes immediate transfers through the bus', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write32(0x03000000, 0x89abcdef);
        bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0x84000001);

        assert.equal(bus.read32(GBA_DMA_BASE_ADDRESS), 0);
        assert.equal(bus.read32(GBA_DMA_BASE_ADDRESS + 4), 0);
        assert.equal(bus.read16(GBA_DMA_BASE_ADDRESS + 8), 1);
        assert.equal(bus.dma.hasPending, true);

        assert.equal(bus.dma.runPending(), 9);
        assert.equal(bus.read32(0x02000000), 0x89abcdef);
        assert.equal(bus.read16(GBA_DMA_BASE_ADDRESS + 10) & 0x8000, 0);
    });

    it('stalls the CPU and scheduler before executing the next opcode', () => {

        const bootROM = new Uint8Array(0x4000);

        bootROM.set([0x00, 0x00, 0xa0, 0xe1], 0);

        const system = new GameBoyAdvanceSystem({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        system.bus.write16(0x03000000, 0x4321);
        system.bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0x80000001);

        assert.equal(system.cpu.instructionAddress, 0);
        assert.equal(system.step(), 7);
        assert.equal(system.cpu.instructionAddress, 4);
        assert.equal(system.cpu.cycles, 7);
        assert.equal(system.cycles, 7);
        assert.equal(system.bus.read16(0x02000000), 0x4321);
    });

    it('services immediate DMA enabled by the current CPU instruction', () => {

        const bootROM = new Uint8Array(0x4000);

        bootROM.set([0x00, 0x00, 0x81, 0xe5], 0); // str r0, [r1]

        const system = new GameBoyAdvanceSystem({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        system.bus.write16(0x03000000, 0xabcd);
        system.bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        system.cpu.registers.write(0, 0x80000001);
        system.cpu.registers.write(1, GBA_DMA_BASE_ADDRESS + 8);

        assert.equal(system.step(), 8);
        assert.equal(system.bus.read16(0x02000000), 0xabcd);
        assert.equal(system.cpu.instructionAddress, 4);
    });

    it('reads the current count register on each repeat trigger', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const dma = bus.dma;

        for (let index = 0; index < 6; index++) {
            bus.write16(0x03000000 + index * 2, index + 1);
        }

        bus.write32(GBA_DMA_BASE_ADDRESS + 36, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 40, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 44, 0x92000002);
        dma.trigger('vblank');
        dma.runPending();

        assert.equal(bus.read16(0x02000000), 1);
        assert.equal(bus.read16(0x02000002), 2);

        bus.write16(GBA_DMA_BASE_ADDRESS + 44, 4);
        dma.trigger('vblank');
        dma.runPending();

        assert.equal(bus.read16(0x02000004), 3);
        assert.equal(bus.read16(0x0200000a), 6);
    });

    it('services simultaneously triggered channels in DMA0-to-DMA3 priority order', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x03000000, 0x1111);
        bus.write16(0x03000002, 0x2222);

        bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0x90400001);
        bus.write32(GBA_DMA_BASE_ADDRESS + 12, 0x03000002);
        bus.write32(GBA_DMA_BASE_ADDRESS + 16, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 20, 0x90400001);

        bus.dma.trigger('vblank');
        bus.dma.runPending();

        assert.equal(bus.read16(0x02000000), 0x2222);
    });

    it('routes DMA completion IRQ into the following ARM exception check', () => {

        const bootROM = new Uint8Array(0x4000);

        bootROM.set([0x00, 0x00, 0xa0, 0xe1], 0);
        bootROM.set([0x00, 0x00, 0xa0, 0xe1], ARM_EXCEPTION.irq);

        const system = new GameBoyAdvanceSystem({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        system.cpu.registers.cpsr = ARM_MODE.system;
        system.bus.write16(GBA_INTERRUPT_ENABLE_ADDRESS, GBA_INTERRUPT.dma0);
        system.bus.write16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS, 1);
        system.bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0xc0000001);

        assert.equal(system.step(), 9);
        assert.equal(system.bus.interrupts.requested, GBA_INTERRUPT.dma0);
        assert.equal(system.cpu.registers.mode, ARM_MODE.irq);
    });

    it('accepts special triggers only for sound FIFO channels and DMA3', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0xb0000001);
        bus.dma.trigger('special');
        assert.equal(bus.dma.hasPending, false);

        bus.write32(GBA_DMA_BASE_ADDRESS + 12, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 16, 0x040000a0);
        bus.write32(GBA_DMA_BASE_ADDRESS + 20, 0xb0000001);
        bus.dma.trigger('special');
        assert.equal(bus.dma.hasPending, true);
    });

    it('wraps internal DMA addresses and latches sources below EWRAM', () => {

        const bootROM = new Uint8Array(0x4000);
        const bus = new GBABus({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        bootROM.set([0x78, 0x56], 0);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0080);
        bus.write16(0x07fffffe, 0x1234);
        bus.write32(GBA_DMA_BASE_ADDRESS, 0x07fffffe);
        bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0x80000002);
        bus.dma.runPending();

        assert.equal(bus.read16(0x02000000), 0x1234);
        assert.equal(bus.read16(0x02000002), 0x1234);
    });

    it('fills ROM prefetch during non-Game-Pak DMA stalls', () => {

        const rom = new Uint8Array(0x100);

        rom.set([
            0x00, 0x00, 0xa0, 0xe1,
            0x00, 0x00, 0xa0, 0xe1,
            0x00, 0x00, 0xa0, 0xe1,
            0x00, 0x00, 0xa0, 0xe1,
        ]);

        const system = new GameBoyAdvanceSystem({ rom });

        system.bus.write16(0x04000204, 0x4000);
        assert.equal(system.step(), 4);

        system.bus.write16(0x03000000, 0x1234);
        system.bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 8, 0x80000001);

        assert.equal(system.step(), 7);
    });

    it('invalidates ROM prefetch when DMA occupies the Game Pak bus', () => {

        const rom = new Uint8Array(0x100);

        rom.set([
            0x00, 0x00, 0xa0, 0xe1,
            0x00, 0x00, 0xa0, 0xe1,
            0x00, 0x00, 0xa0, 0xe1,
            0x00, 0x00, 0xa0, 0xe1,
        ]);
        rom.set([0x34, 0x12], 0x20);

        const system = new GameBoyAdvanceSystem({ rom });

        system.bus.write16(0x04000204, 0x4000);
        assert.equal(system.step(), 4);

        system.bus.write32(GBA_DMA_BASE_ADDRESS + 12, 0x08000020);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 16, 0x02000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 20, 0x80000001);

        assert.equal(system.step(), 13);
        assert.equal(system.bus.read16(0x02000000), 0x1234);
    });

    it('forces four fixed-destination words for Direct Sound FIFO DMA', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        for (let index = 0; index < 4; index++) {
            bus.write32(0x03000000 + index * 4, index + 1);
        }

        bus.write32(GBA_DMA_BASE_ADDRESS + 12, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 16, 0x040000a0);
        bus.write32(GBA_DMA_BASE_ADDRESS + 20, 0xb6000001);
        bus.dma.trigger('special');

        assert.equal(bus.dma.runPending(), 10);
        assert.equal(bus.apu.fifoLevel(0), 16);
        assert.equal(bus.read32(0x040000a0), 0);
        assert.notEqual(bus.read16(GBA_DMA_BASE_ADDRESS + 22) & 0x8000, 0);
    });

    it('supports HBlank triggers and clears all channel state on bus reset', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write32(GBA_DMA_BASE_ADDRESS + 24, 0x03000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 28, 0x02000000);
        bus.write32(GBA_DMA_BASE_ADDRESS + 32, 0xa0000001);

        bus.dma.trigger('vblank');
        assert.equal(bus.dma.hasPending, false);

        bus.dma.trigger('hblank');
        assert.equal(bus.dma.hasPending, true);

        bus.reset();

        assert.equal(bus.dma.hasPending, false);
        assert.equal(bus.read16(GBA_DMA_BASE_ADDRESS + 32), 0);
        assert.equal(bus.read16(GBA_DMA_BASE_ADDRESS + 34), 0);
    });
});
