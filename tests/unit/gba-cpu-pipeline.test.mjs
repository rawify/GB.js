import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_EXCEPTION,
    ARM_MODE,
    ARM_STATUS,
} from '../../dist/index.mjs';
import { createARMHarness } from '../helpers/gba-cpu-harness.mjs';

describe('ARM7TDMI pipeline and exceptions', () => {

    it('exposes ARM PC+8 and advances sequential pipeline fetches', () => {

        const { bus, cpu } = createARMHarness([
            0xe1a00000,
            0xe1a00000,
            0xe1a00000,
        ]);

        assert.equal(cpu.instructionAddress, 0x08000000);
        assert.equal(cpu.registers.read(15), 0x08000008);
        assert.equal(cpu.step(), 1);
        assert.equal(cpu.instructionAddress, 0x08000004);
        assert.equal(cpu.registers.read(15), 0x0800000c);
        assert.deepEqual(bus.accesses, [
            ['read32', 0x08000008, 'sequential'],
        ]);
    });

    it('refills ARM branches with one nonsequential and one sequential fetch', () => {

        const { bus, cpu } = createARMHarness([
            0xea000002,
            0xe1a00000,
            0xe1a00000,
            0xe1a00000,
            0xe1a00000,
        ]);

        assert.equal(cpu.step(), 3);
        assert.equal(cpu.instructionAddress, 0x08000010);
        assert.equal(cpu.registers.read(15), 0x08000018);
        assert.deepEqual(bus.accesses.slice(-2), [
            ['read32', 0x08000010, 'nonsequential'],
            ['read32', 0x08000014, 'sequential'],
        ]);
    });

    it('switches to Thumb through BX and exposes Thumb PC+4', () => {

        const { bus, cpu } = createARMHarness([
            0xe12fff10,
            0xe1a00000,
        ]);

        bus.load16(0x08000100, [0x46c0, 0x46c0, 0x46c0]);
        cpu.registers.write(0, 0x08000101);

        assert.equal(cpu.step(), 3);
        assert.equal(cpu.thumb, true);
        assert.equal(cpu.instructionAddress, 0x08000100);
        assert.equal(cpu.registers.read(15), 0x08000104);
        assert.equal(cpu.step(), 1);
        assert.equal(cpu.registers.read(15), 0x08000106);
    });

    it('enters Supervisor mode on Thumb SWI and preserves return state', () => {

        const { bus, cpu } = createARMHarness([0xdf42, 0x46c0], { thumb: true });

        bus.load32(ARM_EXCEPTION.softwareInterrupt, [0xe1a00000, 0xe1a00000]);
        cpu.registers.cpsr = ARM_MODE.system | ARM_STATUS.thumb;

        assert.equal(cpu.step(), 3);
        assert.equal(cpu.registers.mode, ARM_MODE.supervisor);
        assert.equal(cpu.thumb, false);
        assert.equal(cpu.registers.spsr, ARM_MODE.system | ARM_STATUS.thumb);
        assert.equal(cpu.registers.read(14), 0x08000002);
        assert.equal(cpu.instructionAddress, ARM_EXCEPTION.softwareInterrupt);
    });

    it('takes FIQ before IRQ and uses independently banked link registers', () => {

        const { bus, cpu } = createARMHarness([0xe1a00000, 0xe1a00000]);

        bus.load32(ARM_EXCEPTION.fiq, [0xe1a00000, 0xe1a00000]);
        cpu.registers.cpsr = ARM_MODE.system;
        cpu.setIRQPending(true);
        cpu.setFIQPending(true);

        assert.equal(cpu.step(), 3);
        assert.equal(cpu.cycles, 3);
        assert.equal(cpu.registers.mode, ARM_MODE.fiq);
        assert.equal(cpu.instructionAddress, ARM_EXCEPTION.fiq);
        assert.equal(cpu.registers.read(14), 0x08000004);
        assert.equal((cpu.registers.cpsr & ARM_STATUS.fiqDisable) !== 0, true);
        assert.equal((cpu.registers.cpsr & ARM_STATUS.irqDisable) !== 0, true);
    });

    it('enters banked Prefetch and Data Abort vectors with distinct links', () => {

        const prefetch = createARMHarness([0xe1a00000, 0xe1a00000]);

        prefetch.bus.load32(ARM_EXCEPTION.prefetchAbort, [0xe1a00000, 0xe1a00000]);
        prefetch.cpu.registers.cpsr = ARM_MODE.system | ARM_STATUS.carry;

        assert.equal(prefetch.cpu.raisePrefetchAbort(), 3);
        assert.equal(prefetch.cpu.registers.mode, ARM_MODE.abort);
        assert.equal(prefetch.cpu.registers.read(14), 0x08000004);
        assert.equal(prefetch.cpu.registers.spsr, ARM_MODE.system | ARM_STATUS.carry);
        assert.equal(prefetch.cpu.instructionAddress, ARM_EXCEPTION.prefetchAbort);

        const data = createARMHarness([0xe1a00000, 0xe1a00000]);

        data.bus.load32(ARM_EXCEPTION.dataAbort, [0xe1a00000, 0xe1a00000]);
        data.cpu.registers.cpsr = ARM_MODE.system | ARM_STATUS.overflow;

        assert.equal(data.cpu.raiseDataAbort(), 3);
        assert.equal(data.cpu.registers.mode, ARM_MODE.abort);
        assert.equal(data.cpu.registers.read(14), 0x08000008);
        assert.equal(data.cpu.registers.spsr, ARM_MODE.system | ARM_STATUS.overflow);
        assert.equal(data.cpu.instructionAddress, ARM_EXCEPTION.dataAbort);
    });
});
