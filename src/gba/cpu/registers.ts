export const ARM_MODE = {
    user: 0x10,
    fiq: 0x11,
    irq: 0x12,
    supervisor: 0x13,
    abort: 0x17,
    undefined: 0x1b,
    system: 0x1f,
} as const;

export type ARMMode = typeof ARM_MODE[keyof typeof ARM_MODE];

export const ARM_STATUS = {
    negative: 0x80000000,
    zero: 0x40000000,
    carry: 0x20000000,
    overflow: 0x10000000,
    irqDisable: 0x00000080,
    fiqDisable: 0x00000040,
    thumb: 0x00000020,
    mode: 0x0000001f,
} as const;

export const ARM_STATUS_MASK = 0xf00000ff;

const validModes = new Set<number>(Object.values(ARM_MODE));

function modeBank(mode: ARMMode): number {

    switch (mode) {
        case ARM_MODE.fiq:
            return 1;
        case ARM_MODE.irq:
            return 2;
        case ARM_MODE.supervisor:
            return 3;
        case ARM_MODE.abort:
            return 4;
        case ARM_MODE.undefined:
            return 5;
        case ARM_MODE.user:
        case ARM_MODE.system:
            return 0;
    }
}

export class ARM7TDMIRegisters {

    private readonly shared = new Uint32Array(16);
    private readonly userHigh = new Uint32Array(7);
    private readonly fiqHigh = new Uint32Array(7);
    private readonly bankedStackLink = new Uint32Array(12);
    private readonly savedStatus = new Uint32Array(6);
    private currentStatus = ARM_MODE.supervisor
        | ARM_STATUS.irqDisable
        | ARM_STATUS.fiqDisable;

    get cpsr(): number {

        return this.currentStatus >>> 0;
    }

    set cpsr(value: number) {

        const mode = value & ARM_STATUS.mode;

        if (!validModes.has(mode)) {
            throw new RangeError(`Invalid ARM processor mode 0x${mode.toString(16)}.`);
        }

        this.currentStatus = (value & ARM_STATUS_MASK) >>> 0;
    }

    get mode(): ARMMode {

        return (this.currentStatus & ARM_STATUS.mode) as ARMMode;
    }

    get thumb(): boolean {

        return (this.currentStatus & ARM_STATUS.thumb) !== 0;
    }

    get hasSPSR(): boolean {

        return this.mode !== ARM_MODE.user && this.mode !== ARM_MODE.system;
    }

    read(index: number): number {

        this.validateIndex(index);

        if (index <= 7 || index === 15) {
            return this.shared[index] ?? 0;
        }

        if (index <= 12) {
            const high = this.mode === ARM_MODE.fiq ? this.fiqHigh : this.userHigh;

            return high[index - 8] ?? 0;
        }

        const bank = modeBank(this.mode);

        if (bank === 0) {
            return this.userHigh[index - 8] ?? 0;
        }

        return this.bankedStackLink[(bank - 1) * 2 + index - 13] ?? 0;
    }

    write(index: number, value: number): void {

        this.validateIndex(index);

        const normalizedValue = value >>> 0;

        if (index <= 7 || index === 15) {
            this.shared[index] = normalizedValue;
            return;
        }

        if (index <= 12) {
            const high = this.mode === ARM_MODE.fiq ? this.fiqHigh : this.userHigh;

            high[index - 8] = normalizedValue;
            return;
        }

        const bank = modeBank(this.mode);

        if (bank === 0) {
            this.userHigh[index - 8] = normalizedValue;
        } else {
            this.bankedStackLink[(bank - 1) * 2 + index - 13] = normalizedValue;
        }
    }

    readUser(index: number): number {

        this.validateIndex(index);

        if (index <= 7 || index === 15) {
            return this.shared[index] ?? 0;
        }

        return this.userHigh[index - 8] ?? 0;
    }

    writeUser(index: number, value: number): void {

        this.validateIndex(index);

        if (index <= 7 || index === 15) {
            this.shared[index] = value >>> 0;
        } else {
            this.userHigh[index - 8] = value >>> 0;
        }
    }

    get spsr(): number {

        if (!this.hasSPSR) {
            throw new Error('User and System modes do not have an SPSR.');
        }

        return this.savedStatus[modeBank(this.mode)] ?? 0;
    }

    set spsr(value: number) {

        if (!this.hasSPSR) {
            throw new Error('User and System modes do not have an SPSR.');
        }

        this.savedStatus[modeBank(this.mode)] = (value & ARM_STATUS_MASK) >>> 0;
    }

    setMode(mode: ARMMode): void {

        this.cpsr = (this.currentStatus & ~ARM_STATUS.mode) | mode;
    }

    setStatusBits(mask: number, enabled: boolean): void {

        this.currentStatus = enabled
            ? (this.currentStatus | mask) >>> 0
            : (this.currentStatus & ~mask) >>> 0;
        this.currentStatus &= ARM_STATUS_MASK;
    }

    reset(): void {

        this.shared.fill(0);
        this.userHigh.fill(0);
        this.fiqHigh.fill(0);
        this.bankedStackLink.fill(0);
        this.savedStatus.fill(0);
        this.currentStatus = ARM_MODE.supervisor
            | ARM_STATUS.irqDisable
            | ARM_STATUS.fiqDisable;
    }

    private validateIndex(index: number): void {

        if (!Number.isInteger(index) || index < 0 || index > 15) {
            throw new RangeError(`Invalid ARM register r${index}.`);
        }
    }
}
