import {
    ARM7TDMIRegisters,
    ARM_MODE,
    ARM_STATUS,
    type ARMMode,
} from './registers.js';

export type ARM7TDMIAccess = 'nonsequential' | 'sequential';

export interface ARM7TDMIBus {
    read8(address: number, access?: ARM7TDMIAccess): number;
    read16(address: number, access?: ARM7TDMIAccess): number;
    read32(address: number, access?: ARM7TDMIAccess): number;
    fetch16?(address: number, access?: ARM7TDMIAccess): number;
    fetch32?(address: number, access?: ARM7TDMIAccess): number;
    write8(address: number, value: number, access?: ARM7TDMIAccess): void;
    write16(address: number, value: number, access?: ARM7TDMIAccess): void;
    write32(address: number, value: number, access?: ARM7TDMIAccess): void;
    beginTiming?(): void;
    endTiming?(coreCycles?: number): number;
}

export type ARMSoftwareInterruptHandler = (
    number: number,
    registers: ARM7TDMIRegisters,
) => number | undefined;

export const ARM_EXCEPTION = {
    reset: 0x00,
    undefined: 0x04,
    softwareInterrupt: 0x08,
    prefetchAbort: 0x0c,
    dataAbort: 0x10,
    irq: 0x18,
    fiq: 0x1c,
} as const;

export type ARMException = typeof ARM_EXCEPTION[keyof typeof ARM_EXCEPTION];

export class UnsupportedARMInstructionError extends Error {

    readonly instruction: number;
    readonly address: number;
    readonly thumb: boolean;

    constructor(instruction: number, address: number, thumb: boolean) {

        const digits = thumb ? 4 : 8;
        const formattedInstruction = instruction.toString(16).padStart(digits, '0');
        const formattedAddress = address.toString(16).padStart(8, '0');

        super(`Unsupported ARM7TDMI ${thumb ? 'Thumb' : 'ARM'} instruction 0x${formattedInstruction} at 0x${formattedAddress}.`);
        this.name = 'UnsupportedARMInstructionError';
        this.instruction = instruction >>> 0;
        this.address = address >>> 0;
        this.thumb = thumb;
    }
}

interface ExceptionConfiguration {
    readonly mode: ARMMode;
    readonly vector: ARMException;
    readonly returnOffset: number;
    readonly returnAddress?: number;
    readonly disableFIQ?: boolean;
}

interface ShiftResult {
    readonly value: number;
    readonly carry: boolean;
}

export class ARM7TDMI {

    readonly registers = new ARM7TDMIRegisters();
    private readonly bus: ARM7TDMIBus;
    private readonly softwareInterruptHandler: ARMSoftwareInterruptHandler | undefined;
    private readonly pipeline = new Uint32Array(2);
    private pipelineAddress = 0;
    private nextFetchAddress = 0;
    private elapsedCycles = 0;
    private pipelineValid = false;
    private pipelineBranched = false;
    private pendingIRQ = false;
    private pendingFIQ = false;

    constructor(bus: ARM7TDMIBus, softwareInterruptHandler?: ARMSoftwareInterruptHandler) {

        this.bus = bus;
        this.softwareInterruptHandler = softwareInterruptHandler;
    }

    get cycles(): number {

        return this.elapsedCycles;
    }

    get instructionAddress(): number {

        return this.pipelineAddress;
    }

    get thumb(): boolean {

        return this.registers.thumb;
    }

    reset(startAddress: number = ARM_EXCEPTION.reset): void {

        this.registers.reset();
        this.elapsedCycles = 0;
        this.pipelineValid = false;
        this.pipelineBranched = false;
        this.pendingIRQ = false;
        this.pendingFIQ = false;
        this.refillPipeline(startAddress, false);
    }

    setIRQPending(pending: boolean): void {

        this.pendingIRQ = pending;
    }

    setFIQPending(pending: boolean): void {

        this.pendingFIQ = pending;
    }

    stall(cycles: number): void {

        if (!Number.isSafeInteger(cycles) || cycles < 0) {
            throw new RangeError('ARM7TDMI stall cycles must be a non-negative safe integer.');
        }

        if (!Number.isSafeInteger(this.elapsedCycles + cycles)) {
            throw new RangeError('ARM7TDMI elapsed cycles exceed the safe integer range.');
        }

        this.elapsedCycles += cycles;
    }

    raisePrefetchAbort(address = this.pipelineAddress): number {

        const cycles = this.enterException({
            mode: ARM_MODE.abort,
            vector: ARM_EXCEPTION.prefetchAbort,
            returnAddress: (address + 4) >>> 0,
            returnOffset: 0,
        });

        this.elapsedCycles += cycles;

        return cycles;
    }

    raiseDataAbort(address = this.pipelineAddress): number {

        const cycles = this.enterException({
            mode: ARM_MODE.abort,
            vector: ARM_EXCEPTION.dataAbort,
            returnAddress: (address + 8) >>> 0,
            returnOffset: 0,
        });

        this.elapsedCycles += cycles;

        return cycles;
    }

    step(): number {

        this.bus.beginTiming?.();

        if (!this.pipelineValid) {
            this.refillPipeline(this.registers.read(15), this.registers.thumb);
        }

        if (this.pendingFIQ && (this.registers.cpsr & ARM_STATUS.fiqDisable) === 0) {
            return this.finishStep(this.enterException({
                mode: ARM_MODE.fiq,
                vector: ARM_EXCEPTION.fiq,
                returnOffset: 4,
                disableFIQ: true,
            }));
        }

        if (this.pendingIRQ && (this.registers.cpsr & ARM_STATUS.irqDisable) === 0) {
            return this.finishStep(this.enterException({
                mode: ARM_MODE.irq,
                vector: ARM_EXCEPTION.irq,
                returnOffset: 4,
            }));
        }

        const thumb = this.registers.thumb;
        const width = thumb ? 2 : 4;
        const instruction = this.pipeline[0] ?? 0;
        const address = this.pipelineAddress;

        this.pipeline[0] = this.pipeline[1] ?? 0;
        this.pipeline[1] = this.fetch(this.nextFetchAddress, thumb, 'sequential');
        this.nextFetchAddress = (this.nextFetchAddress + width) >>> 0;
        this.pipelineAddress = (this.pipelineAddress + width) >>> 0;
        this.registers.write(15, (address + (thumb ? 4 : 8)) >>> 0);
        this.pipelineBranched = false;

        const cycles = thumb
            ? this.executeThumb(instruction & 0xffff, address)
            : this.executeARM(instruction, address);

        if (!this.pipelineBranched) {
            this.registers.write(15, (this.pipelineAddress + (thumb ? 4 : 8)) >>> 0);
        }

        return this.finishStep(cycles);
    }

    branch(address: number, thumb = this.registers.thumb): void {

        this.registers.setStatusBits(ARM_STATUS.thumb, thumb);
        this.refillPipeline(address, thumb);
        this.pipelineBranched = true;
    }

    private executeARM(instruction: number, address: number): number {

        const condition = instruction >>> 28;

        if (!this.conditionPassed(condition)) {
            return 1;
        }

        if ((instruction & 0x0ffffff0) === 0x012fff10) {
            const target = this.registers.read(instruction & 0x0f);

            this.branch(target, (target & 1) !== 0);
            return 3;
        }

        if ((instruction & 0x0fbf0fff) === 0x010f0000) {
            return this.executeARMStatusRead(instruction);
        }

        if ((instruction & 0x0db0f000) === 0x0120f000) {
            return this.executeARMStatusWrite(instruction);
        }

        if ((instruction & 0x0f8000f0) === 0x00800090) {
            return this.executeARMLongMultiply(instruction);
        }

        if ((instruction & 0x0fc000f0) === 0x00000090) {
            return this.executeARMMultiply(instruction);
        }

        if ((instruction & 0x0fb00ff0) === 0x01000090) {
            return this.executeARMSwap(instruction);
        }

        if ((instruction & 0x0e000090) === 0x00000090) {
            return this.executeARMHalfwordTransfer(instruction);
        }

        if ((instruction & 0x0c000000) === 0x00000000) {
            return this.executeARMDataProcessing(instruction);
        }

        if ((instruction & 0x0c000000) === 0x04000000) {
            return this.executeARMSingleTransfer(instruction);
        }

        if ((instruction & 0x0e000000) === 0x08000000) {
            return this.executeARMBlockTransfer(instruction);
        }

        if ((instruction & 0x0e000000) === 0x0a000000) {
            const link = (instruction & 0x01000000) !== 0;
            let offset = instruction & 0x00ffffff;

            if ((offset & 0x00800000) !== 0) {
                offset |= 0xff000000;
            }

            if (link) {
                this.registers.write(14, (address + 4) >>> 0);
            }

            this.branch((address + 8 + (offset << 2)) >>> 0, false);
            return 3;
        }

        if ((instruction & 0x0f000000) === 0x0f000000) {
            return this.executeSoftwareInterrupt((instruction >>> 16) & 0xff);
        }

        return this.enterException({
            mode: ARM_MODE.undefined,
            vector: ARM_EXCEPTION.undefined,
            returnOffset: 0,
        });
    }

    private executeARMStatusRead(instruction: number): number {

        const saved = (instruction & 0x00400000) !== 0;
        const destination = (instruction >> 12) & 0x0f;
        const value = saved && this.registers.hasSPSR
            ? this.registers.spsr
            : this.registers.cpsr;

        this.writeResult(destination, value, false);

        return destination === 15 ? 3 : 1;
    }

    private executeARMStatusWrite(instruction: number): number {

        const immediate = (instruction & 0x02000000) !== 0;
        const saved = (instruction & 0x00400000) !== 0;
        const fields = (instruction >> 16) & 0x0f;
        let operand: number;

        if (immediate) {
            const rotate = ((instruction >> 8) & 0x0f) * 2;

            operand = this.rotateRight(instruction & 0xff, rotate);
        } else {
            operand = this.registers.read(instruction & 0x0f);
        }

        let mask = 0;

        for (let field = 0; field < 4; field++) {
            if ((fields & (1 << field)) !== 0) {
                mask |= 0xff << (field * 8);
            }
        }

        if (saved) {
            if (this.registers.hasSPSR) {
                this.registers.spsr = (this.registers.spsr & ~mask) | (operand & mask);
            }
        } else {
            if (this.registers.mode === ARM_MODE.user) {
                mask &= 0xff000000;
            }

            this.registers.cpsr = (this.registers.cpsr & ~mask) | (operand & mask);
        }

        return 1;
    }

    private executeARMMultiply(instruction: number): number {

        const accumulate = (instruction & 0x00200000) !== 0;
        const setFlags = (instruction & 0x00100000) !== 0;
        const destination = (instruction >> 16) & 0x0f;
        const addend = (instruction >> 12) & 0x0f;
        const multiplier = this.registers.read((instruction >> 8) & 0x0f);
        const multiplicand = this.registers.read(instruction & 0x0f);
        let result = Math.imul(multiplicand, multiplier) >>> 0;

        if (accumulate) {
            result = (result + this.registers.read(addend)) >>> 0;
        }

        this.registers.write(destination, result);

        if (setFlags) {
            this.setLogicalFlags(result, undefined);
        }

        return this.multiplyCycles(multiplier) + (accumulate ? 2 : 1);
    }

    private executeARMLongMultiply(instruction: number): number {

        const signed = (instruction & 0x00400000) !== 0;
        const accumulate = (instruction & 0x00200000) !== 0;
        const setFlags = (instruction & 0x00100000) !== 0;
        const highRegister = (instruction >> 16) & 0x0f;
        const lowRegister = (instruction >> 12) & 0x0f;
        const multiplier = this.registers.read((instruction >> 8) & 0x0f);
        const multiplicand = this.registers.read(instruction & 0x0f);
        let result = signed
            ? BigInt(multiplicand | 0) * BigInt(multiplier | 0)
            : BigInt(multiplicand) * BigInt(multiplier);

        if (accumulate) {
            const accumulator = (BigInt(this.registers.read(highRegister)) << 32n)
                | BigInt(this.registers.read(lowRegister));

            result += accumulator;
        }

        result = BigInt.asUintN(64, result);

        const low = Number(result & 0xffffffffn) >>> 0;
        const high = Number((result >> 32n) & 0xffffffffn) >>> 0;

        this.registers.write(lowRegister, low);
        this.registers.write(highRegister, high);

        if (setFlags) {
            this.setNegativeZero64(high, low);
        }

        return this.multiplyCycles(multiplier) + (accumulate ? 3 : 2);
    }

    private executeARMSwap(instruction: number): number {

        const byte = (instruction & 0x00400000) !== 0;
        const base = this.registers.read((instruction >> 16) & 0x0f);
        const destination = (instruction >> 12) & 0x0f;
        const source = this.registers.read(instruction & 0x0f);
        const value = byte
            ? this.bus.read8(base, 'nonsequential')
            : this.readWordRotated(base, 'nonsequential');

        if (byte) {
            this.bus.write8(base, source, 'nonsequential');
        } else {
            this.bus.write32(base, source, 'nonsequential');
        }

        this.registers.write(destination, value);

        return 4;
    }

    private executeARMHalfwordTransfer(instruction: number): number {

        const preIndex = (instruction & 0x01000000) !== 0;
        const addOffset = (instruction & 0x00800000) !== 0;
        const immediate = (instruction & 0x00400000) !== 0;
        const writeBack = (instruction & 0x00200000) !== 0;
        const load = (instruction & 0x00100000) !== 0;
        const baseRegister = (instruction >> 16) & 0x0f;
        const dataRegister = (instruction >> 12) & 0x0f;
        const operation = (instruction >> 5) & 0x03;
        const base = this.registers.read(baseRegister);
        const offset = immediate
            ? ((instruction >> 4) & 0xf0) | (instruction & 0x0f)
            : this.registers.read(instruction & 0x0f);
        const adjusted = addOffset ? (base + offset) >>> 0 : (base - offset) >>> 0;
        const address = preIndex ? adjusted : base;

        if (!load) {
            if (operation !== 1) {
                return this.enterException({
                    mode: ARM_MODE.undefined,
                    vector: ARM_EXCEPTION.undefined,
                    returnOffset: 0,
                });
            }

            this.bus.write16(address, this.storeRegister(dataRegister), 'nonsequential');
        } else {
            let value: number;

            switch (operation) {
                case 1: {
                    const halfword = this.bus.read16(address, 'nonsequential');

                    value = (address & 1) !== 0
                        ? this.rotateRight(halfword, 8)
                        : halfword;
                    break;
                }
                case 2:
                    value = this.signExtend(this.bus.read8(address, 'nonsequential'), 8);
                    break;
                case 3:
                    value = (address & 1) !== 0
                        ? this.signExtend(this.bus.read8(address, 'nonsequential'), 8)
                        : this.signExtend(this.bus.read16(address, 'nonsequential'), 16);
                    break;
                default:
                    return this.enterException({
                        mode: ARM_MODE.undefined,
                        vector: ARM_EXCEPTION.undefined,
                        returnOffset: 0,
                    });
            }

            this.writeResult(dataRegister, value, false);
        }

        if (!preIndex || writeBack) {
            this.registers.write(baseRegister, adjusted);
        }

        return load ? (dataRegister === 15 ? 5 : 3) : 2;
    }

    private executeARMDataProcessing(instruction: number): number {

        const opcode = (instruction >> 21) & 0x0f;
        const setFlags = (instruction & 0x00100000) !== 0;
        const first = this.registers.read((instruction >> 16) & 0x0f);
        const destination = (instruction >> 12) & 0x0f;
        const shifted = this.decodeARMOperand2(instruction);
        const carryIn = (this.registers.cpsr & ARM_STATUS.carry) !== 0 ? 1 : 0;
        let result = 0;
        let carry: boolean | undefined;
        let overflow: boolean | undefined;
        let write = true;
        let arithmetic = false;

        switch (opcode) {
            case 0x0:
                result = first & shifted.value;
                carry = shifted.carry;
                break;
            case 0x1:
                result = first ^ shifted.value;
                carry = shifted.carry;
                break;
            case 0x2:
                ({ result, carry, overflow } = this.subtract(first, shifted.value, 1));
                arithmetic = true;
                break;
            case 0x3:
                ({ result, carry, overflow } = this.subtract(shifted.value, first, 1));
                arithmetic = true;
                break;
            case 0x4:
                ({ result, carry, overflow } = this.add(first, shifted.value, 0));
                arithmetic = true;
                break;
            case 0x5:
                ({ result, carry, overflow } = this.add(first, shifted.value, carryIn));
                arithmetic = true;
                break;
            case 0x6:
                ({ result, carry, overflow } = this.subtract(first, shifted.value, carryIn));
                arithmetic = true;
                break;
            case 0x7:
                ({ result, carry, overflow } = this.subtract(shifted.value, first, carryIn));
                arithmetic = true;
                break;
            case 0x8:
                result = first & shifted.value;
                carry = shifted.carry;
                write = false;
                break;
            case 0x9:
                result = first ^ shifted.value;
                carry = shifted.carry;
                write = false;
                break;
            case 0xa:
                ({ result, carry, overflow } = this.subtract(first, shifted.value, 1));
                arithmetic = true;
                write = false;
                break;
            case 0xb:
                ({ result, carry, overflow } = this.add(first, shifted.value, 0));
                arithmetic = true;
                write = false;
                break;
            case 0xc:
                result = first | shifted.value;
                carry = shifted.carry;
                break;
            case 0xd:
                result = shifted.value;
                carry = shifted.carry;
                break;
            case 0xe:
                result = first & ~shifted.value;
                carry = shifted.carry;
                break;
            case 0xf:
                result = ~shifted.value;
                carry = shifted.carry;
                break;
        }

        result >>>= 0;

        if (write) {
            if (destination === 15 && setFlags && this.registers.hasSPSR) {
                this.registers.cpsr = this.registers.spsr;
                this.branch(result, this.registers.thumb);
            } else {
                this.writeResult(destination, result, false);
            }
        }

        if ((setFlags || !write) && destination !== 15) {
            if (arithmetic) {
                this.setArithmeticFlags(result, carry ?? false, overflow ?? false);
            } else {
                this.setLogicalFlags(result, carry);
            }
        }

        const registerShift = (instruction & 0x02000000) === 0
            && (instruction & 0x10) !== 0;
        const cycles = registerShift ? 2 : 1;

        return destination === 15 && write ? cycles + 2 : cycles;
    }

    private executeARMSingleTransfer(instruction: number): number {

        const registerOffset = (instruction & 0x02000000) !== 0;
        const preIndex = (instruction & 0x01000000) !== 0;
        const addOffset = (instruction & 0x00800000) !== 0;
        const byte = (instruction & 0x00400000) !== 0;
        const writeBack = (instruction & 0x00200000) !== 0;
        const load = (instruction & 0x00100000) !== 0;
        const baseRegister = (instruction >> 16) & 0x0f;
        const dataRegister = (instruction >> 12) & 0x0f;

        if (registerOffset && (instruction & 0x10) !== 0) {
            return this.enterException({
                mode: ARM_MODE.undefined,
                vector: ARM_EXCEPTION.undefined,
                returnOffset: 0,
            });
        }

        const base = this.registers.read(baseRegister);
        const offset = registerOffset
            ? this.shiftImmediate(
                this.registers.read(instruction & 0x0f),
                (instruction >> 5) & 0x03,
                (instruction >> 7) & 0x1f,
                (this.registers.cpsr & ARM_STATUS.carry) !== 0,
            ).value
            : instruction & 0x0fff;
        const adjusted = addOffset ? (base + offset) >>> 0 : (base - offset) >>> 0;
        const address = preIndex ? adjusted : base;

        if (load) {
            const value = byte
                ? this.bus.read8(address, 'nonsequential')
                : this.readWordRotated(address, 'nonsequential');

            this.writeResult(dataRegister, value, false);
        } else if (byte) {
            this.bus.write8(address, this.storeRegister(dataRegister), 'nonsequential');
        } else {
            this.bus.write32(address, this.storeRegister(dataRegister), 'nonsequential');
        }

        if ((!preIndex || writeBack) && !(load && baseRegister === dataRegister)) {
            this.registers.write(baseRegister, adjusted);
        }

        return load ? (dataRegister === 15 ? 5 : 3) : 2;
    }

    private executeARMBlockTransfer(instruction: number): number {

        const preIndex = (instruction & 0x01000000) !== 0;
        const addOffset = (instruction & 0x00800000) !== 0;
        const userBank = (instruction & 0x00400000) !== 0;
        const writeBack = (instruction & 0x00200000) !== 0;
        const load = (instruction & 0x00100000) !== 0;
        const baseRegister = (instruction >> 16) & 0x0f;
        let registerList = instruction & 0xffff;
        const emptyList = registerList === 0;

        if (emptyList) {
            registerList = 1 << 15;
        }

        const count = emptyList ? 16 : this.populationCount(registerList);
        const base = this.registers.read(baseRegister);
        const finalBase = addOffset
            ? (base + count * 4) >>> 0
            : (base - count * 4) >>> 0;
        let address = addOffset
            ? (base + (preIndex ? 4 : 0)) >>> 0
            : (base - count * 4 + (preIndex ? 0 : 4)) >>> 0;
        const restoreStatus = load && userBank && (registerList & (1 << 15)) !== 0;
        const transferUser = userBank && !restoreStatus;
        let firstTransfer = true;

        for (let register = 0; register < 16; register++) {
            if ((registerList & (1 << register)) === 0) {
                continue;
            }

            const access: ARM7TDMIAccess = firstTransfer ? 'nonsequential' : 'sequential';

            if (load) {
                const value = this.bus.read32(address, access);

                if (transferUser) {
                    this.registers.writeUser(register, value);
                } else if (register === 15) {
                    if (restoreStatus && this.registers.hasSPSR) {
                        this.registers.cpsr = this.registers.spsr;
                    }

                    this.branch(value, this.registers.thumb);
                } else {
                    this.registers.write(register, value);
                }
            } else {
                let value = transferUser
                    ? this.registers.readUser(register)
                    : this.storeRegister(register);

                if (writeBack && register === baseRegister && !firstTransfer) {
                    value = finalBase;
                }

                this.bus.write32(address, value, access);
            }

            address = (address + 4) >>> 0;
            firstTransfer = false;
        }

        if (writeBack && !(load && (registerList & (1 << baseRegister)) !== 0)) {
            this.registers.write(baseRegister, finalBase);
        }

        return count + (load ? 2 : 1) + ((registerList & (1 << 15)) !== 0 && load ? 2 : 0);
    }

    private executeThumb(instruction: number, address: number): number {

        if ((instruction & 0xf800) === 0x1800) {
            return this.executeThumbAddSubtract(instruction);
        }

        if ((instruction & 0xe000) === 0x0000) {
            const operation = (instruction >> 11) & 0x03;
            const amount = (instruction >> 6) & 0x1f;
            const source = this.registers.read((instruction >> 3) & 0x07);
            const destination = instruction & 0x07;
            const shifted = this.shiftImmediate(
                source,
                operation,
                amount,
                (this.registers.cpsr & ARM_STATUS.carry) !== 0,
            );

            this.registers.write(destination, shifted.value);
            this.setLogicalFlags(shifted.value, shifted.carry);
            return 1;
        }

        if ((instruction & 0xe000) === 0x2000) {
            return this.executeThumbImmediate(instruction);
        }

        if ((instruction & 0xfc00) === 0x4000) {
            return this.executeThumbALU(instruction);
        }

        if ((instruction & 0xff87) === 0x4700) {
            const register = (instruction >> 3) & 0x0f;
            const target = this.registers.read(register);

            this.branch(target, (target & 1) !== 0);
            return 3;
        }

        if ((instruction & 0xfc00) === 0x4400) {
            return this.executeThumbHighRegister(instruction);
        }

        if ((instruction & 0xf800) === 0x4800) {
            const destination = (instruction >> 8) & 0x07;
            const base = this.registers.read(15) & 0xfffffffc;
            const value = this.readWordRotated(
                (base + ((instruction & 0xff) << 2)) >>> 0,
                'nonsequential',
            );

            this.registers.write(destination, value);
            return 3;
        }

        if ((instruction & 0xf000) === 0x5000) {
            return this.executeThumbRegisterTransfer(instruction);
        }

        if ((instruction & 0xe000) === 0x6000) {
            return this.executeThumbImmediateTransfer(instruction);
        }

        if ((instruction & 0xf000) === 0x8000) {
            const load = (instruction & 0x0800) !== 0;
            const offset = ((instruction >> 6) & 0x1f) << 1;
            const base = this.registers.read((instruction >> 3) & 0x07);
            const destination = instruction & 0x07;
            const transferAddress = (base + offset) >>> 0;

            if (load) {
                const value = this.bus.read16(transferAddress, 'nonsequential');

                this.registers.write(destination, (transferAddress & 1) !== 0
                    ? this.rotateRight(value, 8)
                    : value);
            } else {
                this.bus.write16(
                    transferAddress,
                    this.registers.read(destination),
                    'nonsequential',
                );
            }

            return load ? 3 : 2;
        }

        if ((instruction & 0xf000) === 0x9000) {
            const load = (instruction & 0x0800) !== 0;
            const destination = (instruction >> 8) & 0x07;
            const transferAddress = (
                this.registers.read(13)
                + ((instruction & 0xff) << 2)
            ) >>> 0;

            if (load) {
                this.registers.write(
                    destination,
                    this.readWordRotated(transferAddress, 'nonsequential'),
                );
            } else {
                this.bus.write32(
                    transferAddress,
                    this.registers.read(destination),
                    'nonsequential',
                );
            }

            return load ? 3 : 2;
        }

        if ((instruction & 0xf000) === 0xa000) {
            const useStack = (instruction & 0x0800) !== 0;
            const destination = (instruction >> 8) & 0x07;
            const base = useStack
                ? this.registers.read(13)
                : this.registers.read(15) & 0xfffffffc;

            this.registers.write(destination, (base + ((instruction & 0xff) << 2)) >>> 0);
            return 1;
        }

        if ((instruction & 0xff00) === 0xb000) {
            const offset = (instruction & 0x7f) << 2;
            const stack = this.registers.read(13);

            this.registers.write(13, (instruction & 0x80) !== 0
                ? (stack - offset) >>> 0
                : (stack + offset) >>> 0);
            return 1;
        }

        if ((instruction & 0xf600) === 0xb400) {
            return this.executeThumbPushPop(instruction);
        }

        if ((instruction & 0xf000) === 0xc000) {
            return this.executeThumbMultipleTransfer(instruction);
        }

        if ((instruction & 0xff00) === 0xdf00) {
            return this.executeSoftwareInterrupt(instruction & 0xff);
        }

        if ((instruction & 0xf000) === 0xd000) {
            const condition = (instruction >> 8) & 0x0f;

            if (condition === 0x0e) {
                return this.enterException({
                    mode: ARM_MODE.undefined,
                    vector: ARM_EXCEPTION.undefined,
                    returnOffset: 0,
                });
            }

            if (!this.conditionPassed(condition)) {
                return 1;
            }

            const offset = this.signExtend(instruction & 0xff, 8) << 1;

            this.branch((address + 4 + offset) >>> 0, true);
            return 3;
        }

        if ((instruction & 0xf800) === 0xe000) {
            let offset = instruction & 0x07ff;

            if ((offset & 0x0400) !== 0) {
                offset |= 0xfffff800;
            }

            this.branch((address + 4 + (offset << 1)) >>> 0, true);
            return 3;
        }

        if ((instruction & 0xf800) === 0xf000) {
            const offset = this.signExtend(instruction & 0x07ff, 11) << 12;

            this.registers.write(14, (address + 4 + offset) >>> 0);
            return 1;
        }

        if ((instruction & 0xf800) === 0xf800) {
            const target = (
                this.registers.read(14)
                + ((instruction & 0x07ff) << 1)
            ) >>> 0;

            this.registers.write(14, ((address + 2) | 1) >>> 0);
            this.branch(target, true);
            return 3;
        }

        return this.enterException({
            mode: ARM_MODE.undefined,
            vector: ARM_EXCEPTION.undefined,
            returnOffset: 0,
        });
    }

    private executeThumbAddSubtract(instruction: number): number {

        const immediate = (instruction & 0x0400) !== 0;
        const subtract = (instruction & 0x0200) !== 0;
        const operand = immediate
            ? (instruction >> 6) & 0x07
            : this.registers.read((instruction >> 6) & 0x07);
        const source = this.registers.read((instruction >> 3) & 0x07);
        const destination = instruction & 0x07;
        const arithmetic = subtract
            ? this.subtract(source, operand, 1)
            : this.add(source, operand, 0);

        this.registers.write(destination, arithmetic.result);
        this.setArithmeticFlags(arithmetic.result, arithmetic.carry, arithmetic.overflow);

        return 1;
    }

    private executeThumbImmediate(instruction: number): number {

        const operation = (instruction >> 11) & 0x03;
        const destination = (instruction >> 8) & 0x07;
        const immediate = instruction & 0xff;

        if (operation === 0) {
            this.registers.write(destination, immediate);
            this.setLogicalFlags(immediate, undefined);
            return 1;
        }

        const first = this.registers.read(destination);
        const arithmetic = operation === 2
            ? this.add(first, immediate, 0)
            : this.subtract(first, immediate, 1);

        if (operation !== 1) {
            this.registers.write(destination, arithmetic.result);
        }

        this.setArithmeticFlags(arithmetic.result, arithmetic.carry, arithmetic.overflow);

        return 1;
    }

    private executeThumbALU(instruction: number): number {

        const operation = (instruction >> 6) & 0x0f;
        const source = this.registers.read((instruction >> 3) & 0x07);
        const destination = instruction & 0x07;
        const first = this.registers.read(destination);
        const carryIn = (this.registers.cpsr & ARM_STATUS.carry) !== 0 ? 1 : 0;
        let result = 0;
        let carry: boolean | undefined;
        let overflow: boolean | undefined;
        let write = true;
        let arithmetic = false;
        let cycles = 1;

        switch (operation) {
            case 0x0:
                result = first & source;
                break;
            case 0x1:
                result = first ^ source;
                break;
            case 0x2: {
                const shifted = this.shiftRegister(first, 0, source & 0xff, carryIn !== 0);

                result = shifted.value;
                carry = shifted.carry;
                cycles = 2;
                break;
            }
            case 0x3: {
                const shifted = this.shiftRegister(first, 1, source & 0xff, carryIn !== 0);

                result = shifted.value;
                carry = shifted.carry;
                cycles = 2;
                break;
            }
            case 0x4: {
                const shifted = this.shiftRegister(first, 2, source & 0xff, carryIn !== 0);

                result = shifted.value;
                carry = shifted.carry;
                cycles = 2;
                break;
            }
            case 0x5:
                ({ result, carry, overflow } = this.add(first, source, carryIn));
                arithmetic = true;
                break;
            case 0x6:
                ({ result, carry, overflow } = this.subtract(first, source, carryIn));
                arithmetic = true;
                break;
            case 0x7: {
                const shifted = this.shiftRegister(first, 3, source & 0xff, carryIn !== 0);

                result = shifted.value;
                carry = shifted.carry;
                cycles = 2;
                break;
            }
            case 0x8:
                result = first & source;
                write = false;
                break;
            case 0x9:
                ({ result, carry, overflow } = this.subtract(0, source, 1));
                arithmetic = true;
                break;
            case 0xa:
                ({ result, carry, overflow } = this.subtract(first, source, 1));
                arithmetic = true;
                write = false;
                break;
            case 0xb:
                ({ result, carry, overflow } = this.add(first, source, 0));
                arithmetic = true;
                write = false;
                break;
            case 0xc:
                result = first | source;
                break;
            case 0xd:
                result = Math.imul(first, source) >>> 0;
                cycles = this.multiplyCycles(source) + 1;
                break;
            case 0xe:
                result = first & ~source;
                break;
            case 0xf:
                result = ~source;
                break;
        }

        result >>>= 0;

        if (write) {
            this.registers.write(destination, result);
        }

        if (arithmetic) {
            this.setArithmeticFlags(result, carry ?? false, overflow ?? false);
        } else {
            this.setLogicalFlags(result, carry);
        }

        return cycles;
    }

    private executeThumbHighRegister(instruction: number): number {

        const operation = (instruction >> 8) & 0x03;
        const sourceRegister = (instruction >> 3) & 0x0f;
        const destination = (instruction & 0x07) | ((instruction >> 4) & 0x08);
        const source = this.registers.read(sourceRegister);
        const first = this.registers.read(destination);

        if (operation === 0) {
            const result = (first + source) >>> 0;

            this.writeResult(destination, result, true);
            return destination === 15 ? 3 : 1;
        }

        if (operation === 1) {
            const arithmetic = this.subtract(first, source, 1);

            this.setArithmeticFlags(arithmetic.result, arithmetic.carry, arithmetic.overflow);
            return 1;
        }

        if (operation === 2) {
            this.writeResult(destination, source, true);
            return destination === 15 ? 3 : 1;
        }

        if ((instruction & 0x0080) !== 0) {
            return this.enterException({
                mode: ARM_MODE.undefined,
                vector: ARM_EXCEPTION.undefined,
                returnOffset: 0,
            });
        }

        this.branch(source, (source & 1) !== 0);
        return 3;
    }

    private executeThumbRegisterTransfer(instruction: number): number {

        const operation = (instruction >> 9) & 0x07;
        const offset = this.registers.read((instruction >> 6) & 0x07);
        const base = this.registers.read((instruction >> 3) & 0x07);
        const destination = instruction & 0x07;
        const transferAddress = (base + offset) >>> 0;
        let load = false;

        switch (operation) {
            case 0:
                this.bus.write32(
                    transferAddress,
                    this.registers.read(destination),
                    'nonsequential',
                );
                break;
            case 1:
                this.bus.write16(
                    transferAddress,
                    this.registers.read(destination),
                    'nonsequential',
                );
                break;
            case 2:
                this.bus.write8(
                    transferAddress,
                    this.registers.read(destination),
                    'nonsequential',
                );
                break;
            case 3:
                this.registers.write(
                    destination,
                    this.signExtend(this.bus.read8(transferAddress, 'nonsequential'), 8),
                );
                load = true;
                break;
            case 4:
                this.registers.write(
                    destination,
                    this.readWordRotated(transferAddress, 'nonsequential'),
                );
                load = true;
                break;
            case 5: {
                const halfword = this.bus.read16(transferAddress, 'nonsequential');

                this.registers.write(destination, (transferAddress & 1) !== 0
                    ? this.rotateRight(halfword, 8)
                    : halfword);
                load = true;
                break;
            }
            case 6:
                this.registers.write(
                    destination,
                    this.bus.read8(transferAddress, 'nonsequential'),
                );
                load = true;
                break;
            case 7:
                this.registers.write(destination, (transferAddress & 1) !== 0
                    ? this.signExtend(this.bus.read8(transferAddress, 'nonsequential'), 8)
                    : this.signExtend(this.bus.read16(transferAddress, 'nonsequential'), 16));
                load = true;
                break;
        }

        return load ? 3 : 2;
    }

    private executeThumbImmediateTransfer(instruction: number): number {

        const operation = (instruction >> 11) & 0x03;
        const immediate = (instruction >> 6) & 0x1f;
        const base = this.registers.read((instruction >> 3) & 0x07);
        const destination = instruction & 0x07;
        const byte = operation >= 2;
        const load = (operation & 1) !== 0;
        const transferAddress = (
            base
            + (byte ? immediate : immediate << 2)
        ) >>> 0;

        if (load) {
            this.registers.write(destination, byte
                ? this.bus.read8(transferAddress, 'nonsequential')
                : this.readWordRotated(transferAddress, 'nonsequential'));
        } else if (byte) {
            this.bus.write8(
                transferAddress,
                this.registers.read(destination),
                'nonsequential',
            );
        } else {
            this.bus.write32(
                transferAddress,
                this.registers.read(destination),
                'nonsequential',
            );
        }

        return load ? 3 : 2;
    }

    private executeThumbPushPop(instruction: number): number {

        const load = (instruction & 0x0800) !== 0;
        const extra = (instruction & 0x0100) !== 0;
        let registerList = instruction & 0xff;

        if (extra) {
            registerList |= 1 << (load ? 15 : 14);
        }

        const emptyList = registerList === 0;

        if (emptyList) {
            registerList = 1 << 15;
        }

        const count = emptyList ? 16 : this.populationCount(registerList);
        const stack = this.registers.read(13);
        let address = load ? stack : (stack - count * 4) >>> 0;
        let firstTransfer = true;

        for (let register = 0; register < 16; register++) {
            if ((registerList & (1 << register)) === 0) {
                continue;
            }

            const access: ARM7TDMIAccess = firstTransfer ? 'nonsequential' : 'sequential';

            if (load) {
                const value = this.bus.read32(address, access);

                if (register === 15) {
                    this.branch(value, true);
                } else {
                    this.registers.write(register, value);
                }
            } else {
                this.bus.write32(address, this.storeRegister(register), access);
            }

            address = (address + 4) >>> 0;
            firstTransfer = false;
        }

        this.registers.write(13, load ? (stack + count * 4) >>> 0 : (stack - count * 4) >>> 0);

        return count + (load ? 2 : 1) + (load && (extra || emptyList) ? 2 : 0);
    }

    private executeThumbMultipleTransfer(instruction: number): number {

        const load = (instruction & 0x0800) !== 0;
        const baseRegister = (instruction >> 8) & 0x07;
        let registerList = instruction & 0xff;
        const emptyList = registerList === 0;

        if (emptyList) {
            registerList = 1 << 15;
        }

        const count = emptyList ? 16 : this.populationCount(registerList);
        const base = this.registers.read(baseRegister);
        const finalBase = (base + count * 4) >>> 0;
        let address = base;
        let firstTransfer = true;

        for (let register = 0; register < 16; register++) {
            if ((registerList & (1 << register)) === 0) {
                continue;
            }

            const access: ARM7TDMIAccess = firstTransfer ? 'nonsequential' : 'sequential';

            if (load) {
                const value = this.bus.read32(address, access);

                if (register === 15) {
                    this.branch(value, true);
                } else {
                    this.registers.write(register, value);
                }
            } else {
                const value = register === baseRegister && !firstTransfer
                    ? finalBase
                    : this.registers.read(register);

                this.bus.write32(address, value, access);
            }

            address = (address + 4) >>> 0;
            firstTransfer = false;
        }

        if (!(load && (registerList & (1 << baseRegister)) !== 0)) {
            this.registers.write(baseRegister, finalBase);
        }

        return count + (load ? 2 : 1) + (emptyList && load ? 2 : 0);
    }

    private decodeARMOperand2(instruction: number): ShiftResult {

        const oldCarry = (this.registers.cpsr & ARM_STATUS.carry) !== 0;

        if ((instruction & 0x02000000) !== 0) {
            const rotate = ((instruction >> 8) & 0x0f) * 2;
            const value = this.rotateRight(instruction & 0xff, rotate);

            return {
                value,
                carry: rotate === 0 ? oldCarry : (value & 0x80000000) !== 0,
            };
        }

        const register = instruction & 0x0f;
        const type = (instruction >> 5) & 0x03;

        if ((instruction & 0x10) === 0) {
            return this.shiftImmediate(
                this.registers.read(register),
                type,
                (instruction >> 7) & 0x1f,
                oldCarry,
            );
        }

        const amount = this.registers.read((instruction >> 8) & 0x0f) & 0xff;
        const value = register === 15
            ? (this.registers.read(15) + 4) >>> 0
            : this.registers.read(register);

        return this.shiftRegister(value, type, amount, oldCarry);
    }

    private shiftImmediate(value: number, type: number, amount: number, oldCarry: boolean): ShiftResult {

        switch (type) {
            case 0:
                if (amount === 0) {
                    return { value: value >>> 0, carry: oldCarry };
                }

                return {
                    value: (value << amount) >>> 0,
                    carry: ((value >>> (32 - amount)) & 1) !== 0,
                };
            case 1: {
                const shift = amount === 0 ? 32 : amount;

                return {
                    value: shift === 32 ? 0 : value >>> shift,
                    carry: ((value >>> (shift - 1)) & 1) !== 0,
                };
            }
            case 2: {
                const shift = amount === 0 ? 32 : amount;

                return {
                    value: shift === 32
                        ? ((value & 0x80000000) !== 0 ? 0xffffffff : 0)
                        : (value >> shift) >>> 0,
                    carry: ((value >>> (shift - 1)) & 1) !== 0,
                };
            }
            case 3:
                if (amount === 0) {
                    return {
                        value: ((oldCarry ? 0x80000000 : 0) | (value >>> 1)) >>> 0,
                        carry: (value & 1) !== 0,
                    };
                }

                return {
                    value: this.rotateRight(value, amount),
                    carry: ((value >>> (amount - 1)) & 1) !== 0,
                };
            default:
                return { value: value >>> 0, carry: oldCarry };
        }
    }

    private shiftRegister(value: number, type: number, amount: number, oldCarry: boolean): ShiftResult {

        if (amount === 0) {
            return { value: value >>> 0, carry: oldCarry };
        }

        switch (type) {
            case 0:
                return {
                    value: amount < 32 ? (value << amount) >>> 0 : 0,
                    carry: amount <= 32 && ((value >>> (32 - amount)) & 1) !== 0,
                };
            case 1:
                return {
                    value: amount < 32 ? value >>> amount : 0,
                    carry: amount <= 32 && ((value >>> (amount - 1)) & 1) !== 0,
                };
            case 2:
                return {
                    value: amount < 32
                        ? (value >> amount) >>> 0
                        : ((value & 0x80000000) !== 0 ? 0xffffffff : 0),
                    carry: amount < 32
                        ? ((value >>> (amount - 1)) & 1) !== 0
                        : (value & 0x80000000) !== 0,
                };
            case 3: {
                const rotate = amount & 0x1f;

                return {
                    value: rotate === 0 ? value >>> 0 : this.rotateRight(value, rotate),
                    carry: rotate === 0
                        ? (value & 0x80000000) !== 0
                        : ((value >>> (rotate - 1)) & 1) !== 0,
                };
            }
            default:
                return { value: value >>> 0, carry: oldCarry };
        }
    }

    private add(first: number, second: number, carryIn: number): {
        result: number;
        carry: boolean;
        overflow: boolean;
    } {

        const unsigned = (first >>> 0) + (second >>> 0) + carryIn;
        const result = unsigned >>> 0;
        const overflow = ((~(first ^ second) & (first ^ result)) & 0x80000000) !== 0;

        return { result, carry: unsigned > 0xffffffff, overflow };
    }

    private subtract(first: number, second: number, carryIn: number): {
        result: number;
        carry: boolean;
        overflow: boolean;
    } {

        const borrow = 1 - carryIn;
        const subtrahend = (second >>> 0) + borrow;
        const result = ((first >>> 0) - subtrahend) >>> 0;
        const overflow = (((first ^ second) & (first ^ result)) & 0x80000000) !== 0;

        return { result, carry: (first >>> 0) >= subtrahend, overflow };
    }

    private setLogicalFlags(result: number, carry: boolean | undefined): void {

        let status = this.registers.cpsr & ~(ARM_STATUS.negative | ARM_STATUS.zero);

        if ((result & 0x80000000) !== 0) {
            status |= ARM_STATUS.negative;
        }

        if ((result >>> 0) === 0) {
            status |= ARM_STATUS.zero;
        }

        if (carry !== undefined) {
            status = carry
                ? status | ARM_STATUS.carry
                : status & ~ARM_STATUS.carry;
        }

        this.registers.cpsr = status;
    }

    private setArithmeticFlags(result: number, carry: boolean, overflow: boolean): void {

        let status = this.registers.cpsr & ~(
            ARM_STATUS.negative
            | ARM_STATUS.zero
            | ARM_STATUS.carry
            | ARM_STATUS.overflow
        );

        if ((result & 0x80000000) !== 0) {
            status |= ARM_STATUS.negative;
        }

        if ((result >>> 0) === 0) {
            status |= ARM_STATUS.zero;
        }

        if (carry) {
            status |= ARM_STATUS.carry;
        }

        if (overflow) {
            status |= ARM_STATUS.overflow;
        }

        this.registers.cpsr = status;
    }

    private setNegativeZero64(high: number, low: number): void {

        let status = this.registers.cpsr & ~(ARM_STATUS.negative | ARM_STATUS.zero);

        if ((high & 0x80000000) !== 0) {
            status |= ARM_STATUS.negative;
        }

        if ((high | low) === 0) {
            status |= ARM_STATUS.zero;
        }

        this.registers.cpsr = status;
    }

    private writeResult(register: number, value: number, thumb: boolean): void {

        if (register === 15) {
            this.branch(value, thumb);
        } else {
            this.registers.write(register, value);
        }
    }

    private storeRegister(register: number): number {

        if (register !== 15) {
            return this.registers.read(register);
        }

        return (this.registers.read(15) + (this.registers.thumb ? 0 : 4)) >>> 0;
    }

    private readWordRotated(address: number, access: ARM7TDMIAccess): number {

        const value = this.bus.read32(address & 0xfffffffc, access);

        return this.rotateRight(value, (address & 0x03) * 8);
    }

    private finishStep(coreCycles: number): number {

        const cycles = coreCycles + (this.bus.endTiming?.(coreCycles) ?? 0);

        this.elapsedCycles += cycles;

        return cycles;
    }

    private rotateRight(value: number, amount: number): number {

        const rotate = amount & 0x1f;

        if (rotate === 0) {
            return value >>> 0;
        }

        return ((value >>> rotate) | (value << (32 - rotate))) >>> 0;
    }

    private signExtend(value: number, bits: number): number {

        const shift = 32 - bits;

        return ((value << shift) >> shift) >>> 0;
    }

    private multiplyCycles(multiplier: number): number {

        const value = multiplier >>> 0;

        if ((value & 0xffffff00) === 0 || (value & 0xffffff00) === 0xffffff00) {
            return 1;
        }

        if ((value & 0xffff0000) === 0 || (value & 0xffff0000) === 0xffff0000) {
            return 2;
        }

        if ((value & 0xff000000) === 0 || (value & 0xff000000) === 0xff000000) {
            return 3;
        }

        return 4;
    }

    private populationCount(value: number): number {

        let remaining = value >>> 0;
        let count = 0;

        while (remaining !== 0) {
            remaining &= remaining - 1;
            count++;
        }

        return count;
    }

    private enterException(configuration: ExceptionConfiguration): number {

        const oldStatus = this.registers.cpsr;
        const returnAddress = configuration.returnAddress
            ?? (this.pipelineAddress + configuration.returnOffset) >>> 0;
        let newStatus = (oldStatus & ~ARM_STATUS.mode) | configuration.mode;

        newStatus &= ~ARM_STATUS.thumb;
        newStatus |= ARM_STATUS.irqDisable;

        if (configuration.disableFIQ) {
            newStatus |= ARM_STATUS.fiqDisable;
        }

        this.registers.cpsr = newStatus;
        this.registers.spsr = oldStatus;
        this.registers.write(14, returnAddress);
        this.refillPipeline(configuration.vector, false);
        this.pipelineBranched = true;

        return 3;
    }

    private executeSoftwareInterrupt(number: number): number {

        const cycles = this.softwareInterruptHandler?.(number, this.registers);

        if (cycles !== undefined) {
            return cycles;
        }

        return this.enterException({
            mode: ARM_MODE.supervisor,
            vector: ARM_EXCEPTION.softwareInterrupt,
            returnOffset: 0,
        });
    }

    private conditionPassed(condition: number): boolean {

        const status = this.registers.cpsr;
        const negative = (status & ARM_STATUS.negative) !== 0;
        const zero = (status & ARM_STATUS.zero) !== 0;
        const carry = (status & ARM_STATUS.carry) !== 0;
        const overflow = (status & ARM_STATUS.overflow) !== 0;

        switch (condition) {
            case 0x0:
                return zero;
            case 0x1:
                return !zero;
            case 0x2:
                return carry;
            case 0x3:
                return !carry;
            case 0x4:
                return negative;
            case 0x5:
                return !negative;
            case 0x6:
                return overflow;
            case 0x7:
                return !overflow;
            case 0x8:
                return carry && !zero;
            case 0x9:
                return !carry || zero;
            case 0xa:
                return negative === overflow;
            case 0xb:
                return negative !== overflow;
            case 0xc:
                return !zero && negative === overflow;
            case 0xd:
                return zero || negative !== overflow;
            case 0xe:
                return true;
            case 0xf:
                return false;
            default:
                return false;
        }
    }

    private refillPipeline(address: number, thumb: boolean): void {

        const width = thumb ? 2 : 4;
        const alignedAddress = (address & (thumb ? 0xfffffffe : 0xfffffffc)) >>> 0;

        this.pipelineAddress = alignedAddress;
        this.pipeline[0] = this.fetch(alignedAddress, thumb, 'nonsequential');
        this.pipeline[1] = this.fetch(alignedAddress + width, thumb, 'sequential');
        this.nextFetchAddress = (alignedAddress + width * 2) >>> 0;
        this.registers.write(15, (alignedAddress + (thumb ? 4 : 8)) >>> 0);
        this.pipelineValid = true;
    }

    private fetch(address: number, thumb: boolean, access: ARM7TDMIAccess): number {

        if (thumb) {
            return this.bus.fetch16?.(address, access)
                ?? this.bus.read16(address, access);
        }

        return this.bus.fetch32?.(address, access)
            ?? this.bus.read32(address, access);
    }
}
