import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARM_STATUS } from '../../dist/index.mjs';
import { createARMHarness } from '../helpers/gba-cpu-harness.mjs';

describe('ARM7TDMI Thumb instructions', () => {

    it('executes shifts, add/subtract and immediate ALU formats', () => {

        const { cpu } = createARMHarness([
            0x2001, // mov r0, #1
            0x07c0, // lsl r0, r0, #31
            0x1c41, // add r1, r0, #1
            0x1e4a, // sub r2, r1, #1
            0x2a00, // cmp r2, #0
        ], { thumb: true });

        cpu.step();
        cpu.step();
        assert.equal(cpu.registers.read(0), 0x80000000);
        assert.equal((cpu.registers.cpsr & ARM_STATUS.negative) !== 0, true);

        cpu.step();
        assert.equal(cpu.registers.read(1), 0x80000001);
        cpu.step();
        assert.equal(cpu.registers.read(2), 0x80000000);
        cpu.step();
        assert.equal((cpu.registers.cpsr & ARM_STATUS.negative) !== 0, true);
    });

    it('executes all representative ALU and high-register operations', () => {

        const { cpu } = createARMHarness([
            0x2003, // mov r0, #3
            0x2104, // mov r1, #4
            0x4348, // mul r0, r1
            0x424a, // neg r2, r1
            0x4680, // mov r8, r0
            0x4488, // add r8, r1
            0x4643, // mov r3, r8
        ], { thumb: true });

        cpu.step();
        cpu.step();
        assert.equal(cpu.step(), 2);
        assert.equal(cpu.registers.read(0), 12);
        cpu.step();
        assert.equal(cpu.registers.read(2), 0xfffffffc);
        cpu.step();
        cpu.step();
        cpu.step();
        assert.equal(cpu.registers.read(3), 16);
    });

    it('loads literals and supports register-offset word and signed transfers', () => {

        const { bus, cpu } = createARMHarness([
            0x4802, // ldr r0, [pc, #8]
            0x588b, // ldr r3, [r1, r2]
            0x568c, // ldrsb r4, [r1, r2]
            0x5e8d, // ldrsh r5, [r1, r2]
            0x46c0,
            0x46c0,
            0xbeef,
            0xdead,
        ], { thumb: true });

        bus.store32(0x02000000, 0x1122ff80);
        cpu.registers.write(1, 0x02000000);
        cpu.registers.write(2, 1);

        cpu.step();
        assert.equal(cpu.registers.read(0), 0xdeadbeef);
        cpu.step();
        assert.equal(cpu.registers.read(3), 0x801122ff);
        cpu.step();
        assert.equal(cpu.registers.read(4), 0xffffffff);
        cpu.step();
        assert.equal(cpu.registers.read(5), 0xffffffff);
    });

    it('executes immediate, halfword and SP-relative memory formats', () => {

        const { bus, cpu } = createARMHarness([
            0x6048, // str r0, [r1, #4]
            0x684a, // ldr r2, [r1, #4]
            0x8088, // strh r0, [r1, #4]
            0x888b, // ldrh r3, [r1, #4]
            0x9401, // str r4, [sp, #4]
            0x9d01, // ldr r5, [sp, #4]
        ], { thumb: true });

        cpu.registers.write(0, 0xaabbccdd);
        cpu.registers.write(1, 0x02000000);
        cpu.registers.write(4, 0x12345678);
        cpu.registers.write(13, 0x03007f00);

        cpu.step();
        cpu.step();
        assert.equal(cpu.registers.read(2), 0xaabbccdd);
        cpu.step();
        cpu.step();
        assert.equal(cpu.registers.read(3), 0xccdd);
        cpu.step();
        cpu.step();
        assert.equal(cpu.registers.read(5), 0x12345678);
        assert.equal(bus.peek32(0x03007f04), 0x12345678);
    });

    it('pushes, pops and refills the pipeline when PC is restored', () => {

        const { bus, cpu } = createARMHarness([
            0xb503, // push {r0, r1, lr}
            0xbd03, // pop {r0, r1, pc}
        ], { thumb: true });

        bus.load16(0x08000100, [0x46c0, 0x46c0]);
        cpu.registers.write(0, 0x11111111);
        cpu.registers.write(1, 0x22222222);
        cpu.registers.write(13, 0x03007f00);
        cpu.registers.write(14, 0x08000101);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.read(13), 0x03007ef4);
        cpu.registers.write(0, 0);
        cpu.registers.write(1, 0);
        assert.equal(cpu.step(), 7);
        assert.equal(cpu.registers.read(0), 0x11111111);
        assert.equal(cpu.registers.read(1), 0x22222222);
        assert.equal(cpu.registers.read(13), 0x03007f00);
        assert.equal(cpu.instructionAddress, 0x08000100);
    });

    it('executes multiple transfers with sequential bus accesses', () => {

        const { bus, cpu } = createARMHarness([
            0xc407, // stmia r4!, {r0-r2}
            0xcc07, // ldmia r4!, {r0-r2}
        ], { thumb: true });

        cpu.registers.write(0, 0x11111111);
        cpu.registers.write(1, 0x22222222);
        cpu.registers.write(2, 0x33333333);
        cpu.registers.write(4, 0x02000000);
        cpu.step();

        assert.equal(cpu.registers.read(4), 0x0200000c);
        cpu.registers.write(4, 0x02000000);
        cpu.registers.write(0, 0);
        cpu.registers.write(1, 0);
        cpu.registers.write(2, 0);
        bus.clearAccesses();
        cpu.step();

        assert.deepEqual(
            [cpu.registers.read(0), cpu.registers.read(1), cpu.registers.read(2)],
            [0x11111111, 0x22222222, 0x33333333],
        );
        assert.deepEqual(bus.accesses.filter((access) => access[0] === 'read32'), [
            ['read32', 0x02000000, 'nonsequential'],
            ['read32', 0x02000004, 'sequential'],
            ['read32', 0x02000008, 'sequential'],
        ]);
    });

    it('branches conditionally and completes two-halfword BL with a Thumb link', () => {

        const { bus, cpu } = createARMHarness([
            0x2000, // mov r0, #0
            0x2800, // cmp r0, #0
            0xd100, // bne +0 (not taken)
            0xf000, // bl prefix
            0xf87b, // bl suffix to 0x08000100
            0x46c0,
        ], { thumb: true });

        bus.load16(0x08000100, [0x46c0, 0x46c0]);

        cpu.step();
        cpu.step();
        assert.equal(cpu.step(), 1);
        cpu.step();
        assert.equal(cpu.step(), 3);
        assert.equal(cpu.instructionAddress, 0x08000100);
        assert.equal(cpu.registers.read(14), 0x0800000b);
    });
});
