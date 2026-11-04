import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_EXCEPTION,
    ARM_MODE,
    ARM_STATUS,
} from '../../dist/index.mjs';
import { createARMHarness } from '../helpers/gba-cpu-harness.mjs';

describe('ARM7TDMI edge behavior', () => {

    it('evaluates all fourteen executable ARM condition codes', () => {

        const passingStatus = [
            ARM_STATUS.zero,
            0,
            ARM_STATUS.carry,
            0,
            ARM_STATUS.negative,
            0,
            ARM_STATUS.overflow,
            0,
            ARM_STATUS.carry,
            0,
            0,
            ARM_STATUS.negative,
            0,
            ARM_STATUS.zero,
        ];

        for (let condition = 0; condition < passingStatus.length; condition++) {
            const instruction = (condition << 28) | 0x03a00001;
            const { cpu } = createARMHarness([instruction >>> 0]);

            cpu.registers.cpsr = ARM_MODE.supervisor | (passingStatus[condition] ?? 0);
            assert.equal(cpu.step(), 1, `condition 0x${condition.toString(16)}`);
            assert.equal(cpu.registers.read(0), 1, `condition 0x${condition.toString(16)}`);
        }
    });

    it('charges the internal cycle for register-controlled ARM shifts', () => {

        const { cpu } = createARMHarness([
            0xe1a02110, // mov r2, r0, lsl r1
        ]);

        cpu.registers.write(0, 1);
        cpu.registers.write(1, 4);

        assert.equal(cpu.step(), 2);
        assert.equal(cpu.registers.read(2), 16);
    });

    it('vectors reserved ARM register-offset transfers and Thumb BLX', () => {

        const arm = createARMHarness([
            0xe7900010, // reserved LDR register offset with bit 4 set
        ]);

        arm.bus.load32(ARM_EXCEPTION.undefined, [0xe1a00000, 0xe1a00000]);
        assert.equal(arm.cpu.step(), 3);
        assert.equal(arm.cpu.registers.mode, ARM_MODE.undefined);
        assert.equal(arm.cpu.instructionAddress, ARM_EXCEPTION.undefined);

        const thumb = createARMHarness([
            0x4780, // BLX r0, unavailable on ARMv4T
        ], { thumb: true });

        thumb.bus.load32(ARM_EXCEPTION.undefined, [0xe1a00000, 0xe1a00000]);
        assert.equal(thumb.cpu.step(), 3);
        assert.equal(thumb.cpu.registers.mode, ARM_MODE.undefined);
        assert.equal(thumb.cpu.thumb, false);
    });

    it('applies ARM7 empty block-list PC transfer and 0x40 writeback', () => {

        const { bus, cpu } = createARMHarness([
            0xe8a40000, // stmia r4!, {}
            0xe8b40000, // ldmia r4!, {}
        ]);

        bus.load32(0x08000100, [0xe1a00000, 0xe1a00000]);
        cpu.registers.write(4, 0x02000000);

        assert.equal(cpu.step(), 17);
        assert.equal(bus.peek32(0x02000000), 0x0800000c);
        assert.equal(cpu.registers.read(4), 0x02000040);

        cpu.registers.write(4, 0x02000100);
        bus.store32(0x02000100, 0x08000100);
        assert.equal(cpu.step(), 20);
        assert.equal(cpu.registers.read(4), 0x02000140);
        assert.equal(cpu.instructionAddress, 0x08000100);
    });

    it('routes empty Thumb PUSH/POP through the ARM7 block-transfer quirk', () => {

        const { bus, cpu } = createARMHarness([
            0xb400, // push {}
            0xbc00, // pop {}
            0x46c0,
        ], { thumb: true });

        cpu.registers.write(13, 0x03007f00);

        assert.equal(cpu.step(), 17);
        assert.equal(cpu.registers.read(13), 0x03007ec0);
        assert.equal(bus.peek32(0x03007ec0), 0x08000004);
        assert.equal(cpu.step(), 20);
        assert.equal(cpu.registers.read(13), 0x03007f00);
        assert.equal(cpu.instructionAddress, 0x08000004);
    });
});
