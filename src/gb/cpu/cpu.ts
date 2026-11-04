export const SM83_FLAG = {
    zero: 0x80,
    subtract: 0x40,
    halfCarry: 0x20,
    carry: 0x10,
} as const;

export const SM83_INVALID_OPCODES: readonly number[] = [
    0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd,
];

const invalidOpcodeSet = new Set<number>(SM83_INVALID_OPCODES);

export interface SM83Bus {
    read(address: number): number;
    write(address: number, value: number): void;
    tick?(cycles: number): void;
    stop?(): boolean;
    consumeCPUStallCycles?(): number;
    setCPUPaused?(paused: boolean): void;
}

export class SM83Registers {

    a = 0;
    b = 0;
    c = 0;
    d = 0;
    e = 0;
    h = 0;
    l = 0;
    sp = 0;
    pc = 0;
    private flags = 0;

    get f(): number {

        return this.flags;
    }

    set f(value: number) {

        this.flags = value & 0xf0;
    }

    get af(): number {

        return (this.a << 8) | this.flags;
    }

    set af(value: number) {

        this.a = (value >> 8) & 0xff;
        this.flags = value & 0xf0;
    }

    get bc(): number {

        return (this.b << 8) | this.c;
    }

    set bc(value: number) {

        this.b = (value >> 8) & 0xff;
        this.c = value & 0xff;
    }

    get de(): number {

        return (this.d << 8) | this.e;
    }

    set de(value: number) {

        this.d = (value >> 8) & 0xff;
        this.e = value & 0xff;
    }

    get hl(): number {

        return (this.h << 8) | this.l;
    }

    set hl(value: number) {

        this.h = (value >> 8) & 0xff;
        this.l = value & 0xff;
    }

    reset(): void {

        this.a = 0;
        this.f = 0;
        this.b = 0;
        this.c = 0;
        this.d = 0;
        this.e = 0;
        this.h = 0;
        this.l = 0;
        this.sp = 0;
        this.pc = 0;
    }
}

export class UnsupportedSM83OpcodeError extends Error {

    readonly opcode: number;
    readonly address: number;
    readonly prefixed: boolean;

    constructor(opcode: number, address: number, prefixed = false) {

        const formattedOpcode = opcode.toString(16).padStart(2, '0');
        const formattedAddress = address.toString(16).padStart(4, '0');

        super(`Unsupported SM83 ${prefixed ? 'CB-prefixed ' : ''}opcode 0x${formattedOpcode} at 0x${formattedAddress}.`);
        this.name = 'UnsupportedSM83OpcodeError';
        this.opcode = opcode;
        this.address = address;
        this.prefixed = prefixed;
    }
}

export class SM83CPU {

    readonly registers = new SM83Registers();
    private readonly bus: SM83Bus;
    private elapsedCycles = 0;
    private interruptMasterEnable = false;
    private interruptEnableDelay = 0;
    private halted = false;
    private stopped = false;
    private haltBug = false;
    private locked = false;
    private instructionCyclesAdvanced = 0;
    private instructionStallCycles = 0;

    constructor(bus: SM83Bus) {

        this.bus = bus;
    }

    get cycles(): number {

        return this.elapsedCycles;
    }

    get interruptsEnabled(): boolean {

        return this.interruptMasterEnable;
    }

    get isHalted(): boolean {

        return this.halted;
    }

    get isStopped(): boolean {

        return this.stopped;
    }

    get isLocked(): boolean {

        return this.locked;
    }

    reset(): void {

        this.registers.reset();
        this.elapsedCycles = 0;
        this.interruptMasterEnable = false;
        this.interruptEnableDelay = 0;
        this.halted = false;
        this.stopped = false;
        this.haltBug = false;
        this.locked = false;
        this.instructionStallCycles = 0;
        this.bus.setCPUPaused?.(false);
    }

    step(): number {

        this.instructionCyclesAdvanced = 0;
        this.instructionStallCycles = this.consumeBusStallCycles();

        if (this.locked) {
            return this.completeStep(4);
        }

        const pendingInterrupts = this.pendingInterrupts();

        if (this.stopped) {
            if (pendingInterrupts === 0) {
                return this.completeStep(4);
            }

            this.stopped = false;
            this.resumeCPU();
        }

        if (this.halted) {
            if (pendingInterrupts === 0) {
                return this.completeStep(4);
            }

            this.halted = false;
            this.resumeCPU();
        }

        if (this.interruptMasterEnable && pendingInterrupts !== 0) {
            return this.serviceInterrupt(pendingInterrupts);
        }

        const instructionAddress = this.registers.pc;
        const opcode = this.fetchOpcode();
        const patternedCycles = this.executePatterned(opcode);

        if (patternedCycles !== undefined) {
            return this.completeStep(patternedCycles);
        }

        let cycles: number;

        switch (opcode) {
            case 0x00:
                cycles = 4;
                break;
            case 0x02:
                this.bus.write(this.registers.bc, this.registers.a);
                cycles = 8;
                break;
            case 0x07:
                this.rotateAccumulatorLeft();
                cycles = 4;
                break;
            case 0x08: {
                const address = this.fetchWord();

                this.advanceInstruction(12);
                this.bus.write(address, this.registers.sp);
                this.advanceInstruction(4);
                this.bus.write((address + 1) & 0xffff, this.registers.sp >> 8);
                cycles = 20;
                break;
            }
            case 0x0a:
                this.registers.a = this.bus.read(this.registers.bc);
                cycles = 8;
                break;
            case 0x0f:
                this.rotateAccumulatorRight();
                cycles = 4;
                break;
            case 0x10:
                this.fetchByte();
                this.stopped = !this.bus.stop?.();

                if (this.stopped) {
                    this.bus.setCPUPaused?.(true);
                }

                cycles = 4;
                break;
            case 0x12:
                this.bus.write(this.registers.de, this.registers.a);
                cycles = 8;
                break;
            case 0x17:
                this.rotateAccumulatorLeftThroughCarry();
                cycles = 4;
                break;
            case 0x18:
                cycles = this.jumpRelative(true);
                break;
            case 0x1a:
                this.registers.a = this.bus.read(this.registers.de);
                cycles = 8;
                break;
            case 0x1f:
                this.rotateAccumulatorRightThroughCarry();
                cycles = 4;
                break;
            case 0x20:
                cycles = this.jumpRelative(((this.registers.f >> 7) & 1) === 0);
                break;
            case 0x22:
                this.bus.write(this.registers.hl, this.registers.a);
                this.registers.hl = (this.registers.hl + 1) & 0xffff;
                cycles = 8;
                break;
            case 0x28:
                cycles = this.jumpRelative(((this.registers.f >> 7) & 1) !== 0);
                break;
            case 0x2a:
                this.registers.a = this.bus.read(this.registers.hl);
                this.registers.hl = (this.registers.hl + 1) & 0xffff;
                cycles = 8;
                break;
            case 0x27:
                this.decimalAdjustAccumulator();
                cycles = 4;
                break;
            case 0x2f:
                this.registers.a ^= 0xff;
                this.registers.f |= SM83_FLAG.subtract | SM83_FLAG.halfCarry;
                cycles = 4;
                break;
            case 0x30:
                cycles = this.jumpRelative(((this.registers.f >> 4) & 1) === 0);
                break;
            case 0x32:
                this.bus.write(this.registers.hl, this.registers.a);
                this.registers.hl = (this.registers.hl - 1) & 0xffff;
                cycles = 8;
                break;
            case 0x37:
                this.registers.f = (this.registers.f & SM83_FLAG.zero) | SM83_FLAG.carry;
                cycles = 4;
                break;
            case 0x38:
                cycles = this.jumpRelative(((this.registers.f >> 4) & 1) !== 0);
                break;
            case 0x3a:
                this.registers.a = this.bus.read(this.registers.hl);
                this.registers.hl = (this.registers.hl - 1) & 0xffff;
                cycles = 8;
                break;
            case 0x3f:
                this.registers.f = (this.registers.f & SM83_FLAG.zero)
                    | (((this.registers.f >> 4) & 1) === 0 ? SM83_FLAG.carry : 0);
                cycles = 4;
                break;
            case 0xc3:
                this.registers.pc = this.fetchWord();
                cycles = 16;
                break;
            case 0x76:
                if (!this.interruptMasterEnable && this.pendingInterrupts() !== 0) {
                    this.haltBug = true;
                } else {
                    this.halted = true;
                    this.bus.setCPUPaused?.(true);
                }
                cycles = 4;
                break;
            case 0xc9:
                this.registers.pc = this.popWord();
                cycles = 16;
                break;
            case 0xcd: {
                const address = this.fetchWord();

                this.pushWord(this.registers.pc);
                this.registers.pc = address;
                cycles = 24;
                break;
            }
            case 0xd9:
                this.registers.pc = this.popWord();
                this.interruptMasterEnable = true;
                this.interruptEnableDelay = 0;
                cycles = 16;
                break;
            case 0xe0:
                {
                    const address = 0xff00 | this.fetchByte();

                    this.advanceInstruction(8);
                    this.bus.write(address, this.registers.a);
                }
                cycles = 12;
                break;
            case 0xe2:
                this.advanceInstruction(4);
                this.bus.write(0xff00 | this.registers.c, this.registers.a);
                cycles = 8;
                break;
            case 0xe8:
                this.registers.sp = this.addSignedToStackPointer(this.fetchSignedByte());
                cycles = 16;
                break;
            case 0xe9:
                this.registers.pc = this.registers.hl;
                cycles = 4;
                break;
            case 0xea:
                {
                    const address = this.fetchWord();

                    this.advanceInstruction(12);
                    this.bus.write(address, this.registers.a);
                }
                cycles = 16;
                break;
            case 0xf0:
                {
                    const address = 0xff00 | this.fetchByte();

                    this.advanceInstruction(8);
                    this.registers.a = this.bus.read(address);
                }
                cycles = 12;
                break;
            case 0xf2:
                this.advanceInstruction(4);
                this.registers.a = this.bus.read(0xff00 | this.registers.c);
                cycles = 8;
                break;
            case 0xf3:
                this.interruptMasterEnable = false;
                this.interruptEnableDelay = 0;
                cycles = 4;
                break;
            case 0xf8:
                this.registers.hl = this.addSignedToStackPointer(this.fetchSignedByte());
                cycles = 12;
                break;
            case 0xf9:
                this.registers.sp = this.registers.hl;
                cycles = 8;
                break;
            case 0xfa:
                {
                    const address = this.fetchWord();

                    this.advanceInstruction(12);
                    this.registers.a = this.bus.read(address);
                }
                cycles = 16;
                break;
            case 0xfb:
                this.interruptEnableDelay = 2;
                cycles = 4;
                break;
            case 0xcb:
                cycles = this.executePrefixed();
                break;
            default:
                if (invalidOpcodeSet.has(opcode)) {
                    this.locked = true;
                    cycles = 4;
                } else {
                    throw new UnsupportedSM83OpcodeError(opcode, instructionAddress);
                }
        }

        return this.completeStep(cycles);
    }

    private completeStep(cycles: number): number {

        const remainingCycles = cycles - this.instructionCyclesAdvanced;

        if (remainingCycles < 0) {
            throw new RangeError(`SM83 instruction advanced ${this.instructionCyclesAdvanced} of ${cycles} cycles.`);
        }

        const totalCycles = cycles + this.instructionStallCycles;

        this.elapsedCycles += totalCycles;
        this.bus.tick?.(remainingCycles);
        this.instructionCyclesAdvanced = 0;
        this.instructionStallCycles = 0;

        if (this.interruptEnableDelay > 0) {
            this.interruptEnableDelay--;

            if (this.interruptEnableDelay === 0) {
                this.interruptMasterEnable = true;
            }
        }

        return totalCycles;
    }

    private consumeBusStallCycles(): number {

        const cycles = this.bus.consumeCPUStallCycles?.() ?? 0;

        this.bus.tick?.(cycles);

        return cycles;
    }

    private resumeCPU(): void {

        this.bus.setCPUPaused?.(false);
        this.instructionStallCycles += this.consumeBusStallCycles();
    }

    private advanceInstruction(cycles: number): void {

        this.bus.tick?.(cycles);
        this.instructionCyclesAdvanced += cycles;
    }

    private pendingInterrupts(): number {

        return this.bus.read(0xff0f) & this.bus.read(0xffff) & 0x1f;
    }

    private serviceInterrupt(pendingInterrupts: number): number {

        const interrupt = pendingInterrupts & -pendingInterrupts;
        const index = Math.log2(interrupt);

        this.interruptMasterEnable = false;
        this.interruptEnableDelay = 0;
        this.halted = false;
        this.haltBug = false;
        this.bus.write(0xff0f, this.bus.read(0xff0f) & ~interrupt);
        this.pushWord(this.registers.pc);
        this.registers.pc = 0x0040 + index * 8;

        return this.completeStep(20);
    }

    private executePatterned(opcode: number): number | undefined {

        if (opcode >= 0x40 && opcode <= 0x7f && opcode !== 0x76) {
            const source = opcode & 0x07;
            const destination = (opcode >> 3) & 0x07;

            if (source === 6 || destination === 6) {
                this.advanceInstruction(4);
            }

            this.writeByteRegister(destination, this.readByteRegister(source));

            return source === 6 || destination === 6 ? 8 : 4;
        }

        if (opcode >= 0x80 && opcode <= 0xbf) {
            const operation = (opcode >> 3) & 0x07;
            const source = opcode & 0x07;

            this.executeALU(operation, this.readByteRegister(source));

            return source === 6 ? 8 : 4;
        }

        if ((opcode & 0xc7) === 0xc6) {
            this.executeALU((opcode >> 3) & 0x07, this.fetchByte());

            return 8;
        }

        if (opcode <= 0x3f && (opcode & 0xc7) === 0x06) {
            const destination = (opcode >> 3) & 0x07;
            const value = this.fetchByte();

            if (destination === 6) {
                this.advanceInstruction(8);
            }

            this.writeByteRegister(destination, value);

            return destination === 6 ? 12 : 8;
        }

        if (opcode <= 0x3f && (opcode & 0xc7) === 0x04) {
            const register = (opcode >> 3) & 0x07;
            const value = this.readByteRegister(register);
            const result = (value + 1) & 0xff;
            const carry = this.registers.f & SM83_FLAG.carry;
            const halfCarry = (value & 0x0f) === 0x0f ? SM83_FLAG.halfCarry : 0;
            const zero = result === 0 ? SM83_FLAG.zero : 0;

            this.writeByteRegister(register, result);
            this.registers.f = carry | halfCarry | zero;

            return register === 6 ? 12 : 4;
        }

        if (opcode <= 0x3f && (opcode & 0xc7) === 0x05) {
            const register = (opcode >> 3) & 0x07;
            const value = this.readByteRegister(register);
            const result = (value - 1) & 0xff;
            const carry = this.registers.f & SM83_FLAG.carry;
            const halfCarry = (value & 0x0f) === 0 ? SM83_FLAG.halfCarry : 0;
            const zero = result === 0 ? SM83_FLAG.zero : 0;

            this.writeByteRegister(register, result);
            this.registers.f = carry | SM83_FLAG.subtract | halfCarry | zero;

            return register === 6 ? 12 : 4;
        }

        if (opcode <= 0x3f && (opcode & 0xcf) === 0x01) {
            this.writeRegisterPair((opcode >> 4) & 0x03, this.fetchWord());

            return 12;
        }

        if (opcode <= 0x3f && (opcode & 0xcf) === 0x03) {
            const pair = (opcode >> 4) & 0x03;

            this.writeRegisterPair(pair, (this.readRegisterPair(pair) + 1) & 0xffff);

            return 8;
        }

        if (opcode <= 0x3f && (opcode & 0xcf) === 0x0b) {
            const pair = (opcode >> 4) & 0x03;

            this.writeRegisterPair(pair, (this.readRegisterPair(pair) - 1) & 0xffff);

            return 8;
        }

        if (opcode <= 0x3f && (opcode & 0xcf) === 0x09) {
            this.addToHL(this.readRegisterPair((opcode >> 4) & 0x03));

            return 8;
        }

        if ((opcode & 0xe7) === 0xc0) {
            if (!this.testCondition((opcode >> 3) & 0x03)) {
                return 8;
            }

            this.registers.pc = this.popWord();

            return 20;
        }

        if ((opcode & 0xe7) === 0xc2) {
            const address = this.fetchWord();

            if (!this.testCondition((opcode >> 3) & 0x03)) {
                return 12;
            }

            this.registers.pc = address;

            return 16;
        }

        if ((opcode & 0xe7) === 0xc4) {
            const address = this.fetchWord();

            if (!this.testCondition((opcode >> 3) & 0x03)) {
                return 12;
            }

            this.pushWord(this.registers.pc);
            this.registers.pc = address;

            return 24;
        }

        if ((opcode & 0xc7) === 0xc7) {
            this.pushWord(this.registers.pc);
            this.registers.pc = opcode & 0x38;

            return 16;
        }

        if ((opcode & 0xcf) === 0xc1) {
            this.writeStackPair((opcode >> 4) & 0x03, this.popWord());

            return 12;
        }

        if ((opcode & 0xcf) === 0xc5) {
            this.pushWord(this.readStackPair((opcode >> 4) & 0x03));

            return 16;
        }

        return undefined;
    }

    private testCondition(condition: number): boolean {

        switch (condition) {
            case 0:
                return ((this.registers.f >> 7) & 1) === 0;
            case 1:
                return ((this.registers.f >> 7) & 1) !== 0;
            case 2:
                return ((this.registers.f >> 4) & 1) === 0;
            case 3:
                return ((this.registers.f >> 4) & 1) !== 0;
            default:
                throw new RangeError(`Invalid SM83 condition ${condition}.`);
        }
    }

    private addToHL(value: number): void {

        const current = this.registers.hl;
        const result = current + value;
        const zero = this.registers.f & SM83_FLAG.zero;
        const halfCarry = (current & 0x0fff) + (value & 0x0fff) > 0x0fff
            ? SM83_FLAG.halfCarry
            : 0;
        const carry = result > 0xffff ? SM83_FLAG.carry : 0;

        this.registers.hl = result & 0xffff;
        this.registers.f = zero | halfCarry | carry;
    }

    private addSignedToStackPointer(offset: number): number {

        const unsignedOffset = offset & 0xff;
        const halfCarry = (this.registers.sp & 0x0f) + (unsignedOffset & 0x0f) > 0x0f
            ? SM83_FLAG.halfCarry
            : 0;
        const carry = (this.registers.sp & 0xff) + unsignedOffset > 0xff
            ? SM83_FLAG.carry
            : 0;

        this.registers.f = halfCarry | carry;

        return (this.registers.sp + offset) & 0xffff;
    }

    private executePrefixed(): number {

        const opcode = this.fetchByte();
        const group = opcode >> 6;
        const operation = (opcode >> 3) & 0x07;
        const register = opcode & 0x07;
        const value = this.readByteRegister(register);

        if (group === 0) {
            let result: number;
            let carry = 0;

            switch (operation) {
                case 0:
                    result = ((value << 1) | (value >> 7)) & 0xff;
                    carry = value >> 7;
                    break;
                case 1:
                    result = (value >> 1) | ((value & 0x01) << 7);
                    carry = value & 0x01;
                    break;
                case 2: {
                    const carryIn = ((this.registers.f >> 4) & 1) !== 0 ? 1 : 0;

                    result = ((value << 1) | carryIn) & 0xff;
                    carry = value >> 7;
                    break;
                }
                case 3: {
                    const carryIn = ((this.registers.f >> 4) & 1) !== 0 ? 0x80 : 0;

                    result = (value >> 1) | carryIn;
                    carry = value & 0x01;
                    break;
                }
                case 4:
                    result = (value << 1) & 0xff;
                    carry = value >> 7;
                    break;
                case 5:
                    result = (value >> 1) | (value & 0x80);
                    carry = value & 0x01;
                    break;
                case 6:
                    result = ((value << 4) | (value >> 4)) & 0xff;
                    break;
                case 7:
                    result = value >> 1;
                    carry = value & 0x01;
                    break;
                default:
                    throw new RangeError(`Invalid SM83 CB operation ${operation}.`);
            }

            this.writeByteRegister(register, result);
            this.registers.f = (result === 0 ? SM83_FLAG.zero : 0)
                | (carry !== 0 ? SM83_FLAG.carry : 0);

            return register === 6 ? 16 : 8;
        }

        if (group === 1) {
            const carry = this.registers.f & SM83_FLAG.carry;
            const zero = ((value >> operation) & 1) === 0 ? SM83_FLAG.zero : 0;

            this.registers.f = carry | SM83_FLAG.halfCarry | zero;

            return register === 6 ? 12 : 8;
        }

        if (group === 2) {
            this.writeByteRegister(register, value & ~(1 << operation));
        } else {
            this.writeByteRegister(register, value | (1 << operation));
        }

        return register === 6 ? 16 : 8;
    }

    private readByteRegister(register: number): number {

        switch (register) {
            case 0:
                return this.registers.b;
            case 1:
                return this.registers.c;
            case 2:
                return this.registers.d;
            case 3:
                return this.registers.e;
            case 4:
                return this.registers.h;
            case 5:
                return this.registers.l;
            case 6:
                return this.bus.read(this.registers.hl);
            case 7:
                return this.registers.a;
            default:
                throw new RangeError(`Invalid SM83 byte register ${register}.`);
        }
    }

    private writeByteRegister(register: number, value: number): void {

        const normalizedValue = value & 0xff;

        switch (register) {
            case 0:
                this.registers.b = normalizedValue;
                break;
            case 1:
                this.registers.c = normalizedValue;
                break;
            case 2:
                this.registers.d = normalizedValue;
                break;
            case 3:
                this.registers.e = normalizedValue;
                break;
            case 4:
                this.registers.h = normalizedValue;
                break;
            case 5:
                this.registers.l = normalizedValue;
                break;
            case 6:
                this.bus.write(this.registers.hl, normalizedValue);
                break;
            case 7:
                this.registers.a = normalizedValue;
                break;
            default:
                throw new RangeError(`Invalid SM83 byte register ${register}.`);
        }
    }

    private readRegisterPair(pair: number): number {

        switch (pair) {
            case 0:
                return this.registers.bc;
            case 1:
                return this.registers.de;
            case 2:
                return this.registers.hl;
            case 3:
                return this.registers.sp;
            default:
                throw new RangeError(`Invalid SM83 register pair ${pair}.`);
        }
    }

    private writeRegisterPair(pair: number, value: number): void {

        const normalizedValue = value & 0xffff;

        switch (pair) {
            case 0:
                this.registers.bc = normalizedValue;
                break;
            case 1:
                this.registers.de = normalizedValue;
                break;
            case 2:
                this.registers.hl = normalizedValue;
                break;
            case 3:
                this.registers.sp = normalizedValue;
                break;
            default:
                throw new RangeError(`Invalid SM83 register pair ${pair}.`);
        }
    }

    private readStackPair(pair: number): number {

        return pair === 3 ? this.registers.af : this.readRegisterPair(pair);
    }

    private writeStackPair(pair: number, value: number): void {

        if (pair === 3) {
            this.registers.af = value;
        } else {
            this.writeRegisterPair(pair, value);
        }
    }

    private jumpRelative(condition: boolean): number {

        const offset = this.fetchSignedByte();

        if (!condition) {
            return 8;
        }

        this.registers.pc = (this.registers.pc + offset) & 0xffff;

        return 12;
    }

    private executeALU(operation: number, value: number): void {

        const accumulator = this.registers.a;
        const carryIn = ((this.registers.f >> 4) & 1) !== 0 ? 1 : 0;
        let result: number;
        let halfCarry: boolean;
        let carry: boolean;

        switch (operation) {
            case 0:
                result = accumulator + value;
                halfCarry = (accumulator & 0x0f) + (value & 0x0f) > 0x0f;
                carry = result > 0xff;
                this.registers.a = result & 0xff;
                this.setArithmeticFlags(result, false, halfCarry, carry);
                break;
            case 1:
                result = accumulator + value + carryIn;
                halfCarry = (accumulator & 0x0f) + (value & 0x0f) + carryIn > 0x0f;
                carry = result > 0xff;
                this.registers.a = result & 0xff;
                this.setArithmeticFlags(result, false, halfCarry, carry);
                break;
            case 2:
                result = accumulator - value;
                halfCarry = (accumulator & 0x0f) < (value & 0x0f);
                carry = accumulator < value;
                this.registers.a = result & 0xff;
                this.setArithmeticFlags(result, true, halfCarry, carry);
                break;
            case 3:
                result = accumulator - value - carryIn;
                halfCarry = (accumulator & 0x0f) < (value & 0x0f) + carryIn;
                carry = accumulator < value + carryIn;
                this.registers.a = result & 0xff;
                this.setArithmeticFlags(result, true, halfCarry, carry);
                break;
            case 4:
                this.registers.a = accumulator & value;
                this.registers.f = (this.registers.a === 0 ? SM83_FLAG.zero : 0) | SM83_FLAG.halfCarry;
                break;
            case 5:
                this.registers.a = accumulator ^ value;
                this.registers.f = this.registers.a === 0 ? SM83_FLAG.zero : 0;
                break;
            case 6:
                this.registers.a = accumulator | value;
                this.registers.f = this.registers.a === 0 ? SM83_FLAG.zero : 0;
                break;
            case 7:
                result = accumulator - value;
                halfCarry = (accumulator & 0x0f) < (value & 0x0f);
                carry = accumulator < value;
                this.setArithmeticFlags(result, true, halfCarry, carry);
                break;
            default:
                throw new RangeError(`Invalid SM83 ALU operation ${operation}.`);
        }
    }

    private setArithmeticFlags(result: number, subtract: boolean, halfCarry: boolean, carry: boolean): void {

        const zeroFlag = (result & 0xff) === 0 ? SM83_FLAG.zero : 0;
        const subtractFlag = subtract ? SM83_FLAG.subtract : 0;
        const halfCarryFlag = halfCarry ? SM83_FLAG.halfCarry : 0;
        const carryFlag = carry ? SM83_FLAG.carry : 0;

        this.registers.f = zeroFlag | subtractFlag | halfCarryFlag | carryFlag;
    }

    private rotateAccumulatorLeftThroughCarry(): void {

        const carryIn = ((this.registers.f >> 4) & 1) !== 0 ? 1 : 0;
        const carryOut = ((this.registers.a >> 7) & 1) !== 0 ? SM83_FLAG.carry : 0;

        this.registers.a = ((this.registers.a << 1) | carryIn) & 0xff;
        this.registers.f = carryOut;
    }

    private rotateAccumulatorLeft(): void {

        const carry = this.registers.a >> 7;

        this.registers.a = ((this.registers.a << 1) | carry) & 0xff;
        this.registers.f = carry !== 0 ? SM83_FLAG.carry : 0;
    }

    private rotateAccumulatorRight(): void {

        const carry = this.registers.a & 0x01;

        this.registers.a = (this.registers.a >> 1) | (carry << 7);
        this.registers.f = carry !== 0 ? SM83_FLAG.carry : 0;
    }

    private rotateAccumulatorRightThroughCarry(): void {

        const carryIn = ((this.registers.f >> 4) & 1) !== 0 ? 0x80 : 0;
        const carryOut = this.registers.a & 0x01;

        this.registers.a = (this.registers.a >> 1) | carryIn;
        this.registers.f = carryOut !== 0 ? SM83_FLAG.carry : 0;
    }

    private decimalAdjustAccumulator(): void {

        const subtract = ((this.registers.f >> 6) & 1) !== 0;
        let correction = 0;
        let carry = this.registers.f & SM83_FLAG.carry;

        if (((this.registers.f >> 5) & 1) !== 0 || (!subtract && (this.registers.a & 0x0f) > 9)) {
            correction |= 0x06;
        }

        if (carry !== 0 || (!subtract && this.registers.a > 0x99)) {
            correction |= 0x60;
            carry = SM83_FLAG.carry;
        }

        this.registers.a = subtract
            ? (this.registers.a - correction) & 0xff
            : (this.registers.a + correction) & 0xff;
        this.registers.f = (this.registers.a === 0 ? SM83_FLAG.zero : 0)
            | (subtract ? SM83_FLAG.subtract : 0)
            | carry;
    }

    private pushWord(value: number): void {

        this.registers.sp = (this.registers.sp - 1) & 0xffff;
        this.bus.write(this.registers.sp, value >> 8);
        this.registers.sp = (this.registers.sp - 1) & 0xffff;
        this.bus.write(this.registers.sp, value);
    }

    private popWord(): number {

        const low = this.bus.read(this.registers.sp);

        this.registers.sp = (this.registers.sp + 1) & 0xffff;

        const high = this.bus.read(this.registers.sp);

        this.registers.sp = (this.registers.sp + 1) & 0xffff;

        return low | (high << 8);
    }

    private fetchByte(): number {

        const value = this.bus.read(this.registers.pc);

        this.registers.pc = (this.registers.pc + 1) & 0xffff;

        return value;
    }

    private fetchOpcode(): number {

        if (!this.haltBug) {
            return this.fetchByte();
        }

        this.haltBug = false;

        return this.bus.read(this.registers.pc);
    }

    private fetchSignedByte(): number {

        const value = this.fetchByte();

        return value < 0x80 ? value : value - 0x100;
    }

    private fetchWord(): number {

        const low = this.fetchByte();
        const high = this.fetchByte();

        return low | (high << 8);
    }
}
