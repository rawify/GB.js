import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DMGBus,
    GAME_BOY_LOGO,
    SM83CPU,
    SM83_FLAG,
    SM83_INVALID_OPCODES,
    calculateGameBoyHeaderChecksum,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

function createROM() {

    const rom = new Uint8Array(0x8000);

    rom.set(GAME_BOY_LOGO, 0x0104);
    rom.set([0x43, 0x50, 0x55], 0x0134);
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    return rom;
}

function createCPU(program) {

    const bootROM = new Uint8Array(0x0100);

    bootROM.set(program);

    const bus = new DMGBus({
        bootROM,
        cartridge: createGameBoyCartridge(createROM()),
    });

    return { bus, cpu: new SM83CPU(bus) };
}

describe('SM83 CPU', () => {

    it('executes the opening DMG boot ROM clear loop', () => {

        const { bus, cpu } = createCPU([
            0x31, 0xfe, 0xff,
            0xaf,
            0x21, 0xff, 0x9f,
            0x32,
            0xcb, 0x7c,
            0x20, 0xfb,
        ]);

        bus.vram.fill(0xff);

        assert.equal(cpu.step(), 12);
        assert.equal(cpu.registers.sp, 0xfffe);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.a, 0);
        assert.equal(cpu.registers.f, SM83_FLAG.zero);
        assert.equal(cpu.step(), 12);
        assert.equal(cpu.registers.hl, 0x9fff);
        assert.equal(cpu.step(), 8);
        assert.equal(bus.read(0x9fff), 0);
        assert.equal(cpu.registers.hl, 0x9ffe);
        assert.equal(cpu.step(), 8);
        assert.equal(cpu.registers.f, SM83_FLAG.halfCarry);
        assert.equal(cpu.step(), 12);
        assert.equal(cpu.registers.pc, 0x0007);
        assert.equal(cpu.cycles, 56);
    });

    it('does not take JR NZ when the zero flag is set', () => {

        const { cpu } = createCPU([0x20, 0x7f]);

        cpu.registers.f = SM83_FLAG.zero | 0x0f;

        assert.equal(cpu.step(), 8);
        assert.equal(cpu.registers.pc, 2);
        assert.equal(cpu.registers.f, SM83_FLAG.zero);
    });

    it('executes register, memory and increment instruction families', () => {

        const { bus, cpu } = createCPU([
            0x21, 0x00, 0x80,
            0x06, 0x0f,
            0x04,
            0x78,
            0x77,
            0x35,
        ]);

        cpu.registers.f = SM83_FLAG.carry;

        assert.equal(cpu.step(), 12);
        assert.equal(cpu.step(), 8);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.b, 0x10);
        assert.equal(cpu.registers.f, SM83_FLAG.halfCarry | SM83_FLAG.carry);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.step(), 8);
        assert.equal(cpu.step(), 12);
        assert.equal(bus.read(0x8000), 0x0f);
        assert.equal(
            cpu.registers.f,
            SM83_FLAG.subtract | SM83_FLAG.halfCarry | SM83_FLAG.carry,
        );
    });

    it('writes LD [HL], imm8 during its third machine cycle', () => {

        const memory = new Uint8Array(0x10000);
        const writes = [];
        let elapsedCycles = 0;

        memory.set([0x36, 0x42]);

        const cpu = new SM83CPU({
            read: (address) => memory[address],
            write: (address, value) => {

                writes.push([address, value, elapsedCycles]);
                memory[address] = value;
            },
            tick: (cycles) => {

                elapsedCycles += cycles;
            },
        });

        cpu.registers.hl = 0xc000;

        assert.equal(cpu.step(), 12);
        assert.deepEqual(writes, [[0xc000, 0x42, 8]]);
        assert.equal(elapsedCycles, 12);
    });

    it('calls and returns through the stack', () => {

        const { bus, cpu } = createCPU([
            0x31, 0xfe, 0xff,
            0xcd, 0x09, 0x00,
            0x3e, 0x42,
            0x00,
            0x06, 0x12,
            0xc9,
        ]);

        cpu.step();
        assert.equal(cpu.step(), 24);
        assert.equal(cpu.registers.pc, 0x0009);
        assert.equal(cpu.registers.sp, 0xfffc);
        assert.equal(bus.read(0xfffc), 0x06);
        assert.equal(bus.read(0xfffd), 0x00);
        cpu.step();
        assert.equal(cpu.step(), 16);
        assert.equal(cpu.registers.pc, 0x0006);
        assert.equal(cpu.registers.sp, 0xfffe);
        cpu.step();
        assert.equal(cpu.registers.a, 0x42);
    });

    it('loads high I/O and compares before a conditional jump', () => {

        const { bus, cpu } = createCPU([
            0x3e, 0x90,
            0xe0, 0x42,
            0xf0, 0x42,
            0xfe, 0x90,
            0x28, 0x02,
            0x3e, 0x00,
            0x3e, 0x42,
        ]);

        cpu.step();
        assert.equal(cpu.step(), 12);
        assert.equal(bus.read(0xff42), 0x90);
        assert.equal(cpu.step(), 12);
        assert.equal(cpu.registers.a, 0x90);
        assert.equal(cpu.step(), 8);
        assert.equal(cpu.registers.f, SM83_FLAG.zero | SM83_FLAG.subtract);
        assert.equal(cpu.step(), 12);
        assert.equal(cpu.registers.pc, 0x000c);
        cpu.step();
        assert.equal(cpu.registers.a, 0x42);
    });

    it('rotates through carry with prefixed and accumulator semantics', () => {

        const { cpu } = createCPU([0xcb, 0x11, 0x17]);

        cpu.registers.c = 0x80;
        cpu.registers.a = 0x00;
        cpu.registers.f = SM83_FLAG.carry;

        assert.equal(cpu.step(), 8);
        assert.equal(cpu.registers.c, 0x01);
        assert.equal(cpu.registers.f, SM83_FLAG.carry);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.a, 0x01);
        assert.equal(cpu.registers.f, 0);
    });

    it('decodes all 256 CB-prefixed opcodes with correct register cycles', () => {

        for (let opcode = 0; opcode <= 0xff; opcode++) {
            const { cpu } = createCPU([0xcb, opcode]);
            const register = opcode & 0x07;
            const group = opcode >> 6;
            const expectedCycles = register === 6
                ? (group === 1 ? 12 : 16)
                : 8;

            cpu.registers.hl = 0x8000;

            assert.equal(cpu.step(), expectedCycles, `CB ${opcode.toString(16).padStart(2, '0')}`);
        }
    });

    it('implements every CB rotation and shift operation', () => {

        const cases = [
            [0x01, 0x81, 0, 0x03, SM83_FLAG.carry],
            [0x09, 0x81, 0, 0xc0, SM83_FLAG.carry],
            [0x11, 0x80, SM83_FLAG.carry, 0x01, SM83_FLAG.carry],
            [0x19, 0x01, SM83_FLAG.carry, 0x80, SM83_FLAG.carry],
            [0x21, 0x81, 0, 0x02, SM83_FLAG.carry],
            [0x29, 0x81, 0, 0xc0, SM83_FLAG.carry],
            [0x31, 0xf0, 0, 0x0f, 0],
            [0x39, 0x01, 0, 0x00, SM83_FLAG.zero | SM83_FLAG.carry],
        ];

        for (const [opcode, initial, flags, expected, expectedFlags] of cases) {
            const { cpu } = createCPU([0xcb, opcode]);

            cpu.registers.c = initial;
            cpu.registers.f = flags;
            cpu.step();

            assert.equal(cpu.registers.c, expected, `CB ${opcode.toString(16)}`);
            assert.equal(cpu.registers.f, expectedFlags, `CB ${opcode.toString(16)} flags`);
        }
    });

    it('implements CB BIT, RES and SET against memory', () => {

        const bit = createCPU([0xcb, 0x46]);

        bit.cpu.registers.hl = 0x8000;
        bit.cpu.registers.f = SM83_FLAG.carry;
        bit.bus.write(0x8000, 0xaa);
        assert.equal(bit.cpu.step(), 12);
        assert.equal(bit.bus.read(0x8000), 0xaa);
        assert.equal(bit.cpu.registers.f, SM83_FLAG.zero | SM83_FLAG.halfCarry | SM83_FLAG.carry);

        const reset = createCPU([0xcb, 0x8e]);

        reset.cpu.registers.hl = 0x8000;
        reset.cpu.registers.f = SM83_FLAG.subtract;
        reset.bus.write(0x8000, 0xaa);
        assert.equal(reset.cpu.step(), 16);
        assert.equal(reset.bus.read(0x8000), 0xa8);
        assert.equal(reset.cpu.registers.f, SM83_FLAG.subtract);

        const set = createCPU([0xcb, 0xc6]);

        set.cpu.registers.hl = 0x8000;
        set.bus.write(0x8000, 0xa8);
        assert.equal(set.cpu.step(), 16);
        assert.equal(set.bus.read(0x8000), 0xa9);
    });

    it('executes register and immediate ALU families with SM83 flags', () => {

        const { cpu } = createCPU([
            0x3e, 0x0f,
            0x06, 0x01,
            0x80,
            0x88,
            0x90,
            0xd6, 0x11,
            0xe6, 0x0f,
            0xee, 0x00,
            0xf6, 0x80,
            0xfe, 0x80,
        ]);

        cpu.step();
        cpu.step();
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.a, 0x10);
        assert.equal(cpu.registers.f, SM83_FLAG.halfCarry);
        cpu.registers.f |= SM83_FLAG.carry;
        cpu.step();
        assert.equal(cpu.registers.a, 0x12);
        assert.equal(cpu.registers.f, 0);
        cpu.step();
        assert.equal(cpu.registers.a, 0x11);
        assert.equal(cpu.registers.f, SM83_FLAG.subtract);
        cpu.step();
        assert.equal(cpu.registers.a, 0);
        assert.equal(cpu.registers.f, SM83_FLAG.zero | SM83_FLAG.subtract);
        cpu.step();
        assert.equal(cpu.registers.f, SM83_FLAG.zero | SM83_FLAG.halfCarry);
        cpu.step();
        assert.equal(cpu.registers.f, SM83_FLAG.zero);
        cpu.step();
        assert.equal(cpu.registers.a, 0x80);
        cpu.step();
        assert.equal(cpu.registers.a, 0x80);
        assert.equal(cpu.registers.f, SM83_FLAG.zero | SM83_FLAG.subtract);
    });

    it('enables interrupts after the instruction following EI', () => {

        const { bus, cpu } = createCPU([0xfb, 0x00, 0x00]);

        cpu.registers.sp = 0xfffe;
        bus.write(0xffff, 0x01);
        bus.write(0xff0f, 0x01);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.interruptsEnabled, false);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.interruptsEnabled, true);
        assert.equal(cpu.registers.pc, 2);
        assert.equal(cpu.step(), 20);
        assert.equal(cpu.interruptsEnabled, false);
        assert.equal(cpu.registers.pc, 0x0040);
        assert.equal(cpu.registers.sp, 0xfffc);
        assert.equal(bus.read(0xfffc), 0x02);
        assert.equal(bus.interruptFlags, 0);
    });

    it('cancels a pending EI when DI executes next', () => {

        const { cpu } = createCPU([0xfb, 0xf3, 0x00]);

        cpu.step();
        cpu.step();
        cpu.step();

        assert.equal(cpu.interruptsEnabled, false);
    });

    it('idles in HALT and wakes without servicing when IME is clear', () => {

        const { bus, cpu } = createCPU([0x76, 0x00]);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.isHalted, true);
        assert.equal(cpu.registers.pc, 1);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.pc, 1);

        bus.write(0xffff, 0x04);
        bus.write(0xff0f, 0x04);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.isHalted, false);
        assert.equal(cpu.registers.pc, 2);
    });

    it('reuses the opcode byte once during the HALT bug', () => {

        const { bus, cpu } = createCPU([0x76, 0x3e, 0x42]);

        bus.write(0xffff, 0x01);
        bus.write(0xff0f, 0x01);

        cpu.step();
        assert.equal(cpu.isHalted, false);
        assert.equal(cpu.step(), 8);
        assert.equal(cpu.registers.a, 0x3e);
        assert.equal(cpu.registers.pc, 2);
    });

    it('services the highest-priority pending interrupt first', () => {

        const { bus, cpu } = createCPU([0xfb, 0x00]);

        cpu.registers.sp = 0xfffe;
        cpu.step();
        cpu.step();
        bus.write(0xffff, 0x05);
        bus.write(0xff0f, 0x05);

        assert.equal(cpu.step(), 20);
        assert.equal(cpu.registers.pc, 0x0040);
        assert.equal(bus.interruptFlags, 0x04);
    });

    it('decodes every regular base opcode and locks on illegal opcodes', () => {

        for (let opcode = 0; opcode <= 0xff; opcode++) {
            const { cpu } = createCPU([opcode, 0x00, 0x00]);
            const invalid = SM83_INVALID_OPCODES.includes(opcode);

            cpu.registers.sp = 0xfffe;
            cpu.step();

            assert.equal(cpu.isLocked, invalid, `opcode ${opcode.toString(16).padStart(2, '0')}`);
        }
    });

    it('executes conditional jumps, calls, returns and restart vectors', () => {

        const jump = createCPU([0xca, 0x34, 0x12]);

        assert.equal(jump.cpu.step(), 12);
        assert.equal(jump.cpu.registers.pc, 3);

        const call = createCPU([0xcc, 0x09, 0x00]);

        call.cpu.registers.f = SM83_FLAG.zero;
        call.cpu.registers.sp = 0xfffe;
        assert.equal(call.cpu.step(), 24);
        assert.equal(call.cpu.registers.pc, 9);
        assert.equal(call.bus.read(0xfffc), 3);

        const returnCPU = createCPU([0xc8]);

        returnCPU.cpu.registers.f = SM83_FLAG.zero;
        returnCPU.cpu.registers.sp = 0xfffc;
        returnCPU.bus.write(0xfffc, 0x78);
        returnCPU.bus.write(0xfffd, 0x56);
        assert.equal(returnCPU.cpu.step(), 20);
        assert.equal(returnCPU.cpu.registers.pc, 0x5678);

        const restart = createCPU([0xef]);

        restart.cpu.registers.sp = 0xfffe;
        assert.equal(restart.cpu.step(), 16);
        assert.equal(restart.cpu.registers.pc, 0x0028);
        assert.equal(restart.bus.read(0xfffc), 1);
    });

    it('implements 16-bit additions and signed stack offsets', () => {

        const addHL = createCPU([0x19]);

        addHL.cpu.registers.hl = 0x8fff;
        addHL.cpu.registers.de = 0x9001;
        addHL.cpu.registers.f = SM83_FLAG.zero;
        assert.equal(addHL.cpu.step(), 8);
        assert.equal(addHL.cpu.registers.hl, 0x2000);
        assert.equal(addHL.cpu.registers.f, SM83_FLAG.zero | SM83_FLAG.halfCarry | SM83_FLAG.carry);

        const addSP = createCPU([0xe8, 0xff]);

        addSP.cpu.registers.sp = 0x0001;
        assert.equal(addSP.cpu.step(), 16);
        assert.equal(addSP.cpu.registers.sp, 0);
        assert.equal(addSP.cpu.registers.f, SM83_FLAG.halfCarry | SM83_FLAG.carry);

        const loadHL = createCPU([0xf8, 0x01]);

        loadHL.cpu.registers.sp = 0xffff;
        assert.equal(loadHL.cpu.step(), 12);
        assert.equal(loadHL.cpu.registers.hl, 0);
        assert.equal(loadHL.cpu.registers.f, SM83_FLAG.halfCarry | SM83_FLAG.carry);
    });

    it('implements decimal adjust and accumulator flag operations', () => {

        const { cpu } = createCPU([
            0x3e, 0x09,
            0xc6, 0x01,
            0x27,
            0x2f,
            0x37,
            0x3f,
        ]);

        cpu.step();
        cpu.step();
        cpu.step();
        assert.equal(cpu.registers.a, 0x10);
        assert.equal(cpu.registers.f, 0);
        cpu.step();
        assert.equal(cpu.registers.a, 0xef);
        assert.equal(cpu.registers.f, SM83_FLAG.subtract | SM83_FLAG.halfCarry);
        cpu.step();
        assert.equal(cpu.registers.f, SM83_FLAG.carry);
        cpu.step();
        assert.equal(cpu.registers.f, 0);
    });

    it('returns from interrupts with IME enabled and idles after STOP', () => {

        const interruptReturn = createCPU([0xd9]);

        interruptReturn.cpu.registers.sp = 0xfffc;
        interruptReturn.bus.write(0xfffc, 0x34);
        interruptReturn.bus.write(0xfffd, 0x12);
        assert.equal(interruptReturn.cpu.step(), 16);
        assert.equal(interruptReturn.cpu.registers.pc, 0x1234);
        assert.equal(interruptReturn.cpu.interruptsEnabled, true);

        const stop = createCPU([0x10, 0x00, 0x00]);

        assert.equal(stop.cpu.step(), 4);
        assert.equal(stop.cpu.isStopped, true);
        assert.equal(stop.cpu.registers.pc, 2);
        assert.equal(stop.cpu.step(), 4);
        assert.equal(stop.cpu.registers.pc, 2);
    });

    it('locks permanently when an illegal opcode executes', () => {

        const { cpu } = createCPU([0xd3]);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.isLocked, true);
        assert.equal(cpu.registers.pc, 1);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.registers.pc, 1);
    });
});
