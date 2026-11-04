import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_EXCEPTION,
    ARM_MODE,
    GBA_INTERRUPT,
    GBA_INTERRUPT_ENABLE_ADDRESS,
    GBA_INTERRUPT_MASTER_ENABLE_ADDRESS,
    GBA_TIMER_BASE_ADDRESS,
    GBAInterruptController,
    GameBoyAdvanceSystem,
    GBABus,
    GBAScheduler,
    GBATimers,
} from '../../dist/index.mjs';

function createTimers() {

    const interrupts = new GBAInterruptController();
    const scheduler = new GBAScheduler();
    const timers = new GBATimers(interrupts);

    scheduler.register(timers);

    return { interrupts, scheduler, timers };
}

describe('GBA timers', () => {

    it('applies reload and control writes one cycle after the bus write', () => {

        const { scheduler, timers } = createTimers();

        timers.writeReload(0, 0xfffe);
        timers.writeControl(0, 0x80);

        assert.equal(timers.readCounter(0), 0);
        assert.equal(timers.readControl(0), 0);

        scheduler.advance(1);

        assert.equal(timers.readCounter(0), 0xfffe);
        assert.equal(timers.readControl(0), 0x80);
    });

    it('aligns prescaler pulses to the global scheduler clock', () => {

        const { scheduler, timers } = createTimers();

        scheduler.advance(60);
        timers.writeControl(0, 0x81);
        scheduler.advance(1);

        assert.equal(timers.readCounter(0), 0);

        scheduler.advance(3);
        assert.equal(timers.readCounter(0), 1);
    });

    it('loads reload on start, freezes on stop and preserves live counter writes', () => {

        const { scheduler, timers } = createTimers();

        timers.writeReload(0, 0xfffc);
        timers.writeControl(0, 0x80);
        scheduler.advance(2);

        assert.equal(timers.readCounter(0), 0xfffd);

        timers.writeReload(0, 0x1234);
        assert.equal(timers.readCounter(0), 0xfffd);

        timers.writeControl(0, 0);
        scheduler.advance(10);
        assert.equal(timers.readCounter(0), 0xfffe);

        timers.writeControl(0, 0x80);
        assert.equal(timers.readCounter(0), 0xfffe);
        scheduler.advance(1);
        assert.equal(timers.readCounter(0), 0x1234);
    });

    it('applies prescalers and slices the scheduler at overflow boundaries', () => {

        const { scheduler, timers } = createTimers();

        timers.writeReload(0, 0xfffe);
        timers.writeControl(0, 0x81);

        assert.equal(timers.cyclesUntilNextEvent(200), 1);
        scheduler.advance(1);
        assert.equal(timers.cyclesUntilNextEvent(200), 127);

        scheduler.advance(63);
        assert.equal(timers.readCounter(0), 0xffff);

        scheduler.advance(64);
        assert.equal(timers.readCounter(0), 0xfffe);
    });

    it('increments on each of the four selectable prescaler periods', () => {

        const periods = [1, 64, 256, 1024];

        periods.forEach((period, selection) => {

            const { scheduler, timers } = createTimers();

            timers.writeControl(0, 0x80 | selection);
            scheduler.advance(1);

            const cyclesToFirstPulse = period === 1 ? 1 : period - 1;

            scheduler.advance(cyclesToFirstPulse - 1);
            assert.equal(timers.readCounter(0), 0, `prescaler ${period} before edge`);

            scheduler.advance(1);
            assert.equal(timers.readCounter(0), 1, `prescaler ${period} at edge`);
        });
    });

    it('reloads across multiple overflows and requests the assigned IRQ', () => {

        const { interrupts, scheduler, timers } = createTimers();

        timers.writeReload(0, 0xfffe);
        timers.writeControl(0, 0xc0);
        scheduler.advance(8);

        assert.equal(timers.readCounter(0), 0xffff);
        assert.equal(interrupts.requested, GBA_INTERRUPT.timer0);
    });

    it('cascades every predecessor overflow through timers 1-3', () => {

        const { interrupts, scheduler, timers } = createTimers();

        for (let index = 0; index < 4; index++) {
            timers.writeReload(index, 0xffff);
            timers.writeControl(index, index === 0 ? 0x80 : 0x84 | (index === 3 ? 0x40 : 0));
        }

        scheduler.advance(2);

        assert.equal(timers.readCounter(0), 0xffff);
        assert.equal(timers.readCounter(1), 0xffff);
        assert.equal(timers.readCounter(2), 0xffff);
        assert.equal(timers.readCounter(3), 0xffff);
        assert.equal(interrupts.requested, GBA_INTERRUPT.timer3);
    });

    it('requests the distinct interrupt source assigned to every timer', () => {

        const expected = [
            GBA_INTERRUPT.timer0,
            GBA_INTERRUPT.timer1,
            GBA_INTERRUPT.timer2,
            GBA_INTERRUPT.timer3,
        ];

        expected.forEach((interrupt, index) => {

            const { interrupts, scheduler, timers } = createTimers();

            timers.writeReload(index, 0xffff);
            timers.writeControl(index, 0xc0);
            scheduler.advance(2);

            assert.equal(interrupts.requested, interrupt);
        });
    });

    it('masks control bits and rejects invalid timer indices', () => {

        const { timers } = createTimers();

        timers.writeControl(0, 0xffff);
        timers.writeControl(1, 0xffff);
        timers.tick(1);

        assert.equal(timers.readControl(0), 0x00c3);
        assert.equal(timers.readControl(1), 0x00c7);
        assert.throws(() => timers.readCounter(4), /outside 0-3/);
    });

    it('maps reload, live counters and control registers through the bus', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_TIMER_BASE_ADDRESS, 0xfffe);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0);

        bus.write16(GBA_TIMER_BASE_ADDRESS + 2, 0x00c0);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS + 2), 0);

        bus.timers.tick(1);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0xfffe);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS + 2), 0x00c0);

        bus.timers.tick(1);

        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0xffff);
        bus.timers.tick(1);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0xfffe);
        assert.equal(bus.interrupts.requested, GBA_INTERRUPT.timer0);

        bus.write16(GBA_TIMER_BASE_ADDRESS + 2, 0);
        bus.write16(GBA_TIMER_BASE_ADDRESS, 0x1234);

        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0xfffe);
        bus.timers.tick(1);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0xffff);

        bus.write16(GBA_TIMER_BASE_ADDRESS + 2, 0x0080);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0xffff);
        bus.timers.tick(1);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0x1234);

        bus.reset();

        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS), 0);
        assert.equal(bus.read16(GBA_TIMER_BASE_ADDRESS + 2), 0);
        assert.equal(bus.timers.readReload(0), 0);
    });

    it('raises a timer IRQ through the system scheduler on the next CPU step', () => {

        const bootROM = new Uint8Array(0x4000);

        bootROM.set([0x00, 0x00, 0xa0, 0xe1], 0);
        bootROM.set([0x00, 0x00, 0xa0, 0xe1], ARM_EXCEPTION.irq);

        const system = new GameBoyAdvanceSystem({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        system.cpu.registers.cpsr = ARM_MODE.system;
        system.bus.write16(GBA_INTERRUPT_ENABLE_ADDRESS, GBA_INTERRUPT.timer0);
        system.bus.write16(GBA_INTERRUPT_MASTER_ENABLE_ADDRESS, 1);
        system.bus.write32(GBA_TIMER_BASE_ADDRESS, 0x00c0ffff);

        assert.equal(system.step(), 1);
        assert.equal(system.bus.interrupts.requested, 0);
        assert.equal(system.step(), 1);
        assert.equal(system.bus.interrupts.requested, GBA_INTERRUPT.timer0);
        assert.equal(system.step(), 3);
        assert.equal(system.cpu.registers.mode, ARM_MODE.irq);
        assert.equal(system.cpu.instructionAddress, ARM_EXCEPTION.irq);
    });
});
