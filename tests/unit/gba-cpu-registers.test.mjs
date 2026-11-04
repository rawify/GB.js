import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM7TDMIRegisters,
    ARM_MODE,
    ARM_STATUS,
    ARM_STATUS_MASK,
} from '../../dist/index.mjs';

describe('ARM7TDMI registers', () => {

    it('banks FIQ r8-r14 and exception stack/link registers', () => {

        const registers = new ARM7TDMIRegisters();

        registers.setMode(ARM_MODE.system);
        registers.write(8, 0x11111111);
        registers.write(13, 0x03007f00);
        registers.write(14, 0x08000100);

        registers.setMode(ARM_MODE.fiq);
        registers.write(8, 0x22222222);
        registers.write(13, 0x03007e00);
        registers.write(14, 0x08000200);

        registers.setMode(ARM_MODE.irq);
        registers.write(13, 0x03007fa0);
        registers.write(14, 0x08000300);

        assert.equal(registers.read(8), 0x11111111);
        assert.equal(registers.read(13), 0x03007fa0);
        assert.equal(registers.read(14), 0x08000300);

        registers.setMode(ARM_MODE.fiq);
        assert.equal(registers.read(8), 0x22222222);
        assert.equal(registers.read(13), 0x03007e00);
        assert.equal(registers.read(14), 0x08000200);

        registers.setMode(ARM_MODE.system);
        assert.equal(registers.read(8), 0x11111111);
        assert.equal(registers.read(13), 0x03007f00);
        assert.equal(registers.read(14), 0x08000100);
    });

    it('shares the User bank with System mode and exposes it from FIQ', () => {

        const registers = new ARM7TDMIRegisters();

        registers.setMode(ARM_MODE.user);
        registers.write(10, 0x12345678);
        registers.write(13, 0x03007000);
        registers.setMode(ARM_MODE.fiq);

        assert.equal(registers.read(10), 0);
        assert.equal(registers.readUser(10), 0x12345678);
        assert.equal(registers.readUser(13), 0x03007000);

        registers.writeUser(13, 0x03007100);
        registers.setMode(ARM_MODE.system);
        assert.equal(registers.read(13), 0x03007100);
    });

    it('maintains one SPSR for each exception mode', () => {

        const registers = new ARM7TDMIRegisters();

        registers.spsr = 0xa000001f;
        registers.setMode(ARM_MODE.irq);
        registers.spsr = 0x6000003f;
        registers.setMode(ARM_MODE.supervisor);

        assert.equal(registers.spsr, 0xa000001f);
        registers.setMode(ARM_MODE.irq);
        assert.equal(registers.spsr, 0x6000003f);

        registers.setMode(ARM_MODE.system);
        assert.equal(registers.hasSPSR, false);
        assert.throws(() => registers.spsr, /do not have an SPSR/);
    });

    it('validates modes and resets into masked ARM Supervisor mode', () => {

        const registers = new ARM7TDMIRegisters();

        assert.equal(
            registers.cpsr,
            ARM_MODE.supervisor | ARM_STATUS.irqDisable | ARM_STATUS.fiqDisable,
        );
        assert.equal(registers.thumb, false);
        assert.throws(() => {

            registers.cpsr = 0;
        }, /Invalid ARM processor mode/);

        registers.setStatusBits(ARM_STATUS.thumb, true);
        registers.write(0, 0xffffffff);
        registers.reset();

        assert.equal(registers.read(0), 0);
        assert.equal(registers.thumb, false);
    });

    it('keeps reserved CPSR and SPSR bits clear', () => {

        const registers = new ARM7TDMIRegisters();
        const status = 0xffffffd3;

        registers.cpsr = status;
        registers.spsr = 0xffffffff;

        assert.equal(registers.cpsr, (status & ARM_STATUS_MASK) >>> 0);
        assert.equal(registers.spsr, ARM_STATUS_MASK);
    });
});
