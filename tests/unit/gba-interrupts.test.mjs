import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_EXCEPTION,
    ARM_MODE,
    GBA_INTERRUPT,
    GBA_INTERRUPT_ENABLE_ADDRESS,
    GBA_INTERRUPT_FLAGS_ADDRESS,
    GBA_INTERRUPT_MASTER_ENABLE_ADDRESS,
    GBAInterruptController,
    GameBoyAdvanceSystem,
    GBABus,
} from '../../dist/index.mjs';

describe('GBA interrupt controller', () => {

    it('latches requests and drives IRQ only through IE and IME', () => {

        const interrupts = new GBAInterruptController();
        const lineChanges = [];

        interrupts.setLineListener((pending) => lineChanges.push(pending));
        interrupts.request(GBA_INTERRUPT.timer0 | GBA_INTERRUPT.dma3);

        assert.equal(interrupts.requested, GBA_INTERRUPT.timer0 | GBA_INTERRUPT.dma3);
        assert.equal(interrupts.pending, 0);
        assert.equal(interrupts.irqLine, false);

        interrupts.enabled = GBA_INTERRUPT.timer0;
        interrupts.masterEnabled = true;

        assert.equal(interrupts.pending, GBA_INTERRUPT.timer0);
        assert.equal(interrupts.irqLine, true);

        interrupts.acknowledge(GBA_INTERRUPT.dma3);
        assert.equal(interrupts.irqLine, true);

        interrupts.acknowledge(GBA_INTERRUPT.timer0);
        assert.equal(interrupts.requested, 0);
        assert.equal(interrupts.irqLine, false);
        assert.deepEqual(lineChanges, [false, true, false]);
    });

    it('maps masked IE, write-one-to-clear IF and one-bit IME registers', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_INTERRUPT_ENABLE_ADDRESS, 0xffff);
        bus.interrupts.request(GBA_INTERRUPT.vblank | GBA_INTERRUPT.timer2 | GBA_INTERRUPT.gamePak);
        bus.write16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS, 0xffff);

        assert.equal(bus.read16(GBA_INTERRUPT_ENABLE_ADDRESS), 0x3fff);
        assert.equal(
            bus.read16(GBA_INTERRUPT_FLAGS_ADDRESS),
            GBA_INTERRUPT.vblank | GBA_INTERRUPT.timer2 | GBA_INTERRUPT.gamePak,
        );
        assert.equal(bus.read16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS), 1);
        assert.equal(bus.interrupts.irqLine, true);

        bus.write8(GBA_INTERRUPT_FLAGS_ADDRESS, GBA_INTERRUPT.vblank | GBA_INTERRUPT.timer2);

        assert.equal(bus.read16(GBA_INTERRUPT_FLAGS_ADDRESS), GBA_INTERRUPT.gamePak);

        bus.write8(GBA_INTERRUPT_FLAGS_ADDRESS + 1, GBA_INTERRUPT.gamePak >>> 8);

        assert.equal(bus.read16(GBA_INTERRUPT_FLAGS_ADDRESS), 0);
        assert.equal(bus.interrupts.irqLine, false);

        bus.write8(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS, 2);
        assert.equal(bus.read16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS), 0);

        bus.write8(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS, 1);
        bus.interrupts.request(GBA_INTERRUPT.vblank);
        assert.equal(bus.interrupts.irqLine, true);

        bus.reset();

        assert.equal(bus.read16(GBA_INTERRUPT_ENABLE_ADDRESS), 0);
        assert.equal(bus.read16(GBA_INTERRUPT_FLAGS_ADDRESS), 0);
        assert.equal(bus.read16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS), 0);
        assert.equal(bus.interrupts.irqLine, false);
    });

    it('routes an enabled request into the ARM IRQ exception and clears the line', () => {

        const bootROM = new Uint8Array(0x4000);

        bootROM.set([0x00, 0x00, 0xa0, 0xe1], 0x00);
        bootROM.set([0x00, 0x00, 0xa0, 0xe1], ARM_EXCEPTION.irq);

        const system = new GameBoyAdvanceSystem({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        system.cpu.registers.cpsr = ARM_MODE.system;
        system.bus.write16(GBA_INTERRUPT_ENABLE_ADDRESS, GBA_INTERRUPT.vblank);
        system.bus.interrupts.request(GBA_INTERRUPT.vblank);

        assert.equal(system.bus.interrupts.irqLine, false);

        system.bus.write16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS, 1);

        assert.equal(system.bus.interrupts.irqLine, true);
        assert.equal(system.step(), 3);
        assert.equal(system.cpu.registers.mode, ARM_MODE.irq);
        assert.equal(system.cpu.registers.read(14), 4);
        assert.equal(system.cpu.instructionAddress, ARM_EXCEPTION.irq);

        system.bus.write16(GBA_INTERRUPT_FLAGS_ADDRESS, GBA_INTERRUPT.vblank);

        assert.equal(system.bus.interrupts.irqLine, false);
    });
});
