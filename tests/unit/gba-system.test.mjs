import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_HALT_CONTROL_ADDRESS,
    GBA_INTERRUPT,
    GBA_KEY_CONTROL_ADDRESS,
    GBA_POST_BOOT_FLAG_ADDRESS,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

describe('GBA system foundation', () => {

    it('owns one monotonic scheduler and bus reset domain', () => {

        const rom = new Uint8Array(0x100);

        rom.set([0x00, 0x00, 0xa0, 0xe1], 0); // mov r0, r0

        const system = new GameBoyAdvanceSystem({
            rom,
        });
        let componentCycles = 0;

        system.scheduler.register({
            tick: (cycles) => {

                componentCycles += cycles;
            },
        });
        system.bus.write32(0x02000000, 0x12345678);

        assert.equal(system.model, 'gba');
        assert.equal(system.cpu.instructionAddress, 0x08000000);
        assert.equal(system.runCycles(17), 20);
        assert.equal(system.cycles, 20);
        assert.equal(componentCycles, 20);
        assert.equal(system.bus.read32(0x02000000), 0x12345678);

        system.reset();

        assert.equal(system.cycles, 0);
        assert.equal(system.cpu.cycles, 0);
        assert.equal(system.cpu.instructionAddress, 0x08000000);
        assert.equal(system.bus.read32(0x02000000), 0);
    });

    it('boots from an injected BIOS and clocks one instruction through the scheduler', () => {

        const bootROM = new Uint8Array(0x4000);

        bootROM.set([0x00, 0x00, 0xa0, 0xe1], 0); // mov r0, r0

        const system = new GameBoyAdvanceSystem({
            bootROM,
            rom: new Uint8Array(0x100),
        });

        assert.equal(system.cpu.instructionAddress, 0);
        assert.equal(system.step(), 1);
        assert.equal(system.cpu.instructionAddress, 4);
        assert.equal(system.cycles, 1);
    });

    it('adds memory wait states to CPU and scheduler cycles', () => {

        const rom = new Uint8Array(0x100);

        rom.set([0x00, 0x00, 0xa0, 0xe1], 0); // mov r0, r0

        const system = new GameBoyAdvanceSystem({ rom });

        assert.equal(system.step(), 4);
        assert.equal(system.cpu.cycles, 4);
        assert.equal(system.cycles, 4);

        system.bus.write16(0x04000204, 0x0010);

        assert.equal(system.step(), 2);
        assert.equal(system.cpu.cycles, 6);
        assert.equal(system.cycles, 6);
    });

    it('halts through HALTCNT and wakes on an enabled interrupt without IME', () => {

        const rom = new Uint8Array(0x100);

        rom.set([0x00, 0x00, 0xa0, 0xe1], 0); // mov r0, r0

        const system = new GameBoyAdvanceSystem({ rom });
        const instructionAddress = system.cpu.instructionAddress;

        system.bus.write8(GBA_POST_BOOT_FLAG_ADDRESS, 1);
        system.bus.write8(GBA_HALT_CONTROL_ADDRESS, 0);

        assert.equal(system.bus.read8(GBA_POST_BOOT_FLAG_ADDRESS), 1);
        assert.equal(system.step(), 40);
        assert.equal(system.isHalted, true);
        assert.equal(system.cpu.instructionAddress, instructionAddress);

        system.bus.interrupts.enabled = GBA_INTERRUPT.vblank;
        system.bus.interrupts.request(GBA_INTERRUPT.vblank);

        assert.equal(system.step(), 4);
        assert.equal(system.isHalted, false);
        assert.equal(system.cpu.instructionAddress, instructionAddress + 4);
    });

    it('stops all clocks and wakes only for an enabled STOP source', () => {

        const rom = new Uint8Array(0x100);

        rom.set([0x00, 0x00, 0xa0, 0xe1], 0); // mov r0, r0

        const system = new GameBoyAdvanceSystem({ rom });
        const instructionAddress = system.cpu.instructionAddress;

        system.bus.interrupts.enabled = GBA_INTERRUPT.vblank | GBA_INTERRUPT.keypad;
        system.bus.write16(GBA_KEY_CONTROL_ADDRESS, 0x4001);
        system.bus.write8(GBA_HALT_CONTROL_ADDRESS, 0x80);

        assert.equal(system.step(), 0);
        assert.equal(system.isStopped, true);
        assert.equal(system.runCycles(1_000), 0);
        assert.equal(system.cycles, 0);
        assert.equal(system.cpu.cycles, 0);

        system.bus.interrupts.request(GBA_INTERRUPT.vblank);

        assert.equal(system.step(), 0);
        assert.equal(system.isStopped, true);
        assert.equal(system.cycles, 0);

        system.setButton('a', true);

        assert.equal(system.step(), 4);
        assert.equal(system.isStopped, false);
        assert.equal(system.cpu.instructionAddress, instructionAddress + 4);
        assert.equal(system.cycles, 4);
    });

    it('fills and consumes the Game Pak prefetch buffer during internal cycles', () => {

        const createPrefetchSystem = (enabled) => {

            const rom = new Uint8Array(0x100);

            rom.set([
                0x90, 0x01, 0x02, 0xe0, // mul r2, r0, r1
                0x00, 0x00, 0xa0, 0xe1, // mov r0, r0
                0x00, 0x00, 0xa0, 0xe1,
                0x00, 0x00, 0xa0, 0xe1,
            ]);

            const system = new GameBoyAdvanceSystem({ rom });

            system.bus.write16(0x04000204, enabled ? 0x4000 : 0);
            system.cpu.registers.write(1, 0x12345678);

            return system;
        };
        const withoutPrefetch = createPrefetchSystem(false);
        const withPrefetch = createPrefetchSystem(true);

        assert.equal(withoutPrefetch.step(), 8);
        assert.equal(withPrefetch.step(), 8);
        assert.equal(withoutPrefetch.step(), 4);
        assert.equal(withPrefetch.step(), 1);
    });
});
