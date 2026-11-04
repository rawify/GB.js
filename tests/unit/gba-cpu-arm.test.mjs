import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_MODE,
    ARM_STATUS,
} from '../../dist/index.mjs';
import { createARMHarness } from '../helpers/gba-cpu-harness.mjs';

describe('ARM7TDMI ARM instructions', () => {

    it('executes data processing, immediate rotation and arithmetic flags', () => {

        const { cpu } = createARMHarness([
            0xe3a00480, // mov r0, #0x80000000
            0xe0901000, // adds r1, r0, r0
            0xe2b12000, // adcs r2, r1, #0
        ]);

        assert.equal(cpu.step(), 1);
        assert.equal(cpu.registers.read(0), 0x80000000);

        assert.equal(cpu.step(), 1);
        assert.equal(cpu.registers.read(1), 0);
        assert.equal(
            cpu.registers.cpsr & 0xf0000000,
            ARM_STATUS.zero | ARM_STATUS.carry | ARM_STATUS.overflow,
        );

        assert.equal(cpu.step(), 1);
        assert.equal(cpu.registers.read(2), 1);
        assert.equal(cpu.registers.cpsr & 0xf0000000, 0);
    });

    it('implements immediate, register and RRX barrel shifts with carry', () => {

        const { cpu } = createARMHarness([
            0xe3a00001, // mov r0, #1
            0xe3a01021, // mov r1, #33
            0xe1b02110, // movs r2, r0, lsl r1
            0xe1b03060, // movs r3, r0, rrx
        ]);

        cpu.step();
        cpu.step();
        cpu.step();

        assert.equal(cpu.registers.read(2), 0);
        assert.equal((cpu.registers.cpsr & ARM_STATUS.carry) !== 0, false);
        assert.equal((cpu.registers.cpsr & ARM_STATUS.zero) !== 0, true);

        cpu.registers.setStatusBits(ARM_STATUS.carry, true);
        cpu.step();

        assert.equal(cpu.registers.read(3), 0x80000000);
        assert.equal((cpu.registers.cpsr & ARM_STATUS.carry) !== 0, true);
    });

    it('executes multiply and long multiply with operand-dependent cycles', () => {

        const { cpu } = createARMHarness([
            0xe0030291, // mul r3, r1, r2
            0xe0854291, // umull r4, r5, r1, r2
        ]);

        cpu.registers.write(1, 0xffffffff);
        cpu.registers.write(2, 2);

        assert.equal(cpu.step(), 2);
        assert.equal(cpu.registers.read(3), 0xfffffffe);
        assert.equal(cpu.step(), 3);
        assert.equal(cpu.registers.read(4), 0xfffffffe);
        assert.equal(cpu.registers.read(5), 1);
    });

    it('loads rotated words and signed halfwords and applies writeback', () => {

        const { bus, cpu } = createARMHarness([
            0xe5941001, // ldr r1, [r4, #1]
            0xe1d420f1, // ldrsh r2, [r4, #1]
            0xe5a43004, // str r3, [r4, #4]!
        ]);

        bus.store32(0x02000000, 0x1122ff80);
        cpu.registers.write(3, 0xaabbccdd);
        cpu.registers.write(4, 0x02000000);

        assert.equal(cpu.step(), 3);
        assert.equal(cpu.registers.read(1), 0x801122ff);
        assert.equal(cpu.step(), 3);
        assert.equal(cpu.registers.read(2), 0xffffffff);
        assert.equal(cpu.step(), 2);
        assert.equal(cpu.registers.read(4), 0x02000004);
        assert.equal(bus.peek32(0x02000004), 0xaabbccdd);
    });

    it('performs SWP and increment-after block transfers in bus order', () => {

        const { bus, cpu } = createARMHarness([
            0xe1042091, // swp r2, r1, [r4]
            0xe8a40007, // stmia r4!, {r0-r2}
        ]);

        bus.store32(0x02000000, 0x12345678);
        cpu.registers.write(0, 0xaaaaaaaa);
        cpu.registers.write(1, 0xbbbbbbbb);
        cpu.registers.write(4, 0x02000000);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.read(2), 0x12345678);
        assert.equal(bus.peek32(0x02000000), 0xbbbbbbbb);

        bus.clearAccesses();
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.read(4), 0x0200000c);
        assert.deepEqual(bus.accesses.filter((access) => access[0] === 'write32'), [
            ['write32', 0x02000000, 0xaaaaaaaa, 'nonsequential'],
            ['write32', 0x02000004, 0xbbbbbbbb, 'sequential'],
            ['write32', 0x02000008, 0x12345678, 'sequential'],
        ]);
    });

    it('reads and writes status flags and restores CPSR through MOVS PC, LR', () => {

        const { bus, cpu } = createARMHarness([
            0xe128f001, // msr cpsr_f, r1
            0xe10f2000, // mrs r2, cpsr
            0xe1b0f00e, // movs pc, lr
        ]);

        bus.load16(0x08000100, [0x46c0, 0x46c0]);
        cpu.registers.write(1, ARM_STATUS.negative | ARM_STATUS.carry);
        cpu.registers.write(14, 0x08000101);
        cpu.registers.spsr = ARM_MODE.system | ARM_STATUS.thumb | ARM_STATUS.zero;

        cpu.step();
        cpu.step();

        assert.equal(
            cpu.registers.read(2) & 0xf0000000,
            ARM_STATUS.negative | ARM_STATUS.carry,
        );

        assert.equal(cpu.step(), 3);
        assert.equal(cpu.thumb, true);
        assert.equal(cpu.registers.mode, ARM_MODE.system);
        assert.equal(cpu.instructionAddress, 0x08000100);
        assert.equal(cpu.registers.cpsr & ARM_STATUS.zero, ARM_STATUS.zero);
    });

    it('honors every condition class without mutating skipped destinations', () => {

        const { cpu } = createARMHarness([
            0x03a00001, // moveq r0, #1
            0x13a01002, // movne r1, #2
            0xc3a02003, // movgt r2, #3
            0xd3a03004, // movle r3, #4
        ]);

        cpu.registers.cpsr = ARM_MODE.supervisor | ARM_STATUS.zero;
        cpu.step();
        cpu.step();
        cpu.step();
        cpu.step();

        assert.equal(cpu.registers.read(0), 1);
        assert.equal(cpu.registers.read(1), 0);
        assert.equal(cpu.registers.read(2), 0);
        assert.equal(cpu.registers.read(3), 4);
    });
});
