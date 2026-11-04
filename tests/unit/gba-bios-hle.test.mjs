import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ARM_EXCEPTION,
    ARM_MODE,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

function createSystem(instructions) {

    const rom = new Uint8Array(0x100);
    const view = new DataView(rom.buffer);

    instructions.forEach((instruction, index) => view.setUint32(index * 4, instruction, true));

    return new GameBoyAdvanceSystem({ rom });
}

describe('GBA BIOS HLE', () => {

    it('dispatches ARM Div without entering Supervisor mode', () => {

        const system = createSystem([0xef060000, 0xe1a00000]);

        system.cpu.registers.cpsr = ARM_MODE.system;
        system.cpu.registers.write(0, -17);
        system.cpu.registers.write(1, 5);

        system.step();

        assert.equal(system.cpu.registers.read(0), 0xfffffffd);
        assert.equal(system.cpu.registers.read(1), 0xfffffffe);
        assert.equal(system.cpu.registers.read(3), 3);
        assert.equal(system.cpu.registers.mode, ARM_MODE.system);
        assert.equal(system.cpu.instructionAddress, 0x08000004);
    });

    it('implements DivArm and unsigned Sqrt', () => {

        const system = createSystem([0xef070000, 0xef080000]);

        system.cpu.registers.write(0, 5);
        system.cpu.registers.write(1, 17);

        system.step();

        assert.equal(system.cpu.registers.read(0), 3);
        assert.equal(system.cpu.registers.read(1), 2);
        assert.equal(system.cpu.registers.read(3), 3);

        system.cpu.registers.write(0, 0x12345678);
        system.step();

        assert.equal(system.cpu.registers.read(0), Math.floor(Math.sqrt(0x12345678)));
    });

    it('decodes Thumb SWI immediates through the same HLE dispatcher', () => {

        const rom = new Uint8Array(0x100);
        const view = new DataView(rom.buffer);

        view.setUint16(0, 0xdf08, true);
        view.setUint16(2, 0x46c0, true);

        const system = new GameBoyAdvanceSystem({ rom });

        system.cpu.branch(0x08000000, true);
        system.cpu.registers.write(0, 255);
        system.step();

        assert.equal(system.cpu.registers.read(0), 15);
        assert.equal(system.cpu.thumb, true);
        assert.equal(system.cpu.instructionAddress, 0x08000002);
    });

    it('copies and fills halfwords and words through CpuSet', () => {

        const system = createSystem([0xef0b0000, 0xef0b0000]);

        system.bus.write16(0x02000000, 0x1234);
        system.bus.write16(0x02000002, 0x5678);
        system.cpu.registers.write(0, 0x02000000);
        system.cpu.registers.write(1, 0x03000000);
        system.cpu.registers.write(2, 2);

        system.step();

        assert.equal(system.bus.read16(0x03000000), 0x1234);
        assert.equal(system.bus.read16(0x03000002), 0x5678);

        system.bus.write32(0x02000000, 0x89abcdef);
        system.cpu.registers.write(0, 0x02000000);
        system.cpu.registers.write(1, 0x03000010);
        system.cpu.registers.write(2, 0x05000003);

        system.step();

        assert.equal(system.bus.read32(0x03000010), 0x89abcdef);
        assert.equal(system.bus.read32(0x03000014), 0x89abcdef);
        assert.equal(system.bus.read32(0x03000018), 0x89abcdef);
    });

    it('rounds CpuFastSet word counts up to complete eight-word blocks', () => {

        const system = createSystem([0xef0c0000]);

        system.bus.write32(0x02000000, 0x10203040);
        system.cpu.registers.write(0, 0x02000000);
        system.cpu.registers.write(1, 0x03000000);
        system.cpu.registers.write(2, 0x01000001);

        system.step();

        for (let index = 0; index < 8; index++) {
            assert.equal(system.bus.read32(0x03000000 + index * 4), 0x10203040);
        }
    });

    it('preserves the hardware SWI exception path when a BIOS is present', () => {

        const bootROM = new Uint8Array(0x4000);
        const view = new DataView(bootROM.buffer);

        view.setUint32(0, 0xef060000, true);
        view.setUint32(4, 0xe1a00000, true);
        view.setUint32(ARM_EXCEPTION.softwareInterrupt, 0xe1a00000, true);

        const system = new GameBoyAdvanceSystem({ bootROM, rom: new Uint8Array(0x100) });

        system.cpu.registers.cpsr = ARM_MODE.system;
        system.cpu.registers.write(0, 17);
        system.cpu.registers.write(1, 5);
        system.step();

        assert.equal(system.cpu.registers.mode, ARM_MODE.supervisor);
        assert.equal(system.cpu.instructionAddress, ARM_EXCEPTION.softwareInterrupt);
        assert.equal(system.cpu.registers.read(0), 17);
    });

    it('vectors unsupported BIOS-free SWIs through the hardware exception path', () => {

        const system = createSystem([0xef1f0000]);

        system.cpu.registers.cpsr = ARM_MODE.system;
        system.step();

        assert.equal(system.cpu.registers.mode, ARM_MODE.supervisor);
        assert.equal(system.cpu.instructionAddress, ARM_EXCEPTION.softwareInterrupt);
    });
});
