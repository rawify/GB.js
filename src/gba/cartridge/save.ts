export const GBA_SRAM_SIZE = 0x8000;
export const GBA_FLASH512_SIZE = 0x10000;
export const GBA_FLASH1M_SIZE = 0x20000;

export type GBASaveType = 'sram' | 'flash512' | 'flash1m';

export interface GBACartridgeSave {
    readonly data: Uint8Array;
    readonly byteLength: number;
    readonly type: GBASaveType;
    read(address: number): number;
    write(address: number, value: number): void;
    load(data: Uint8Array): void;
    dump(): Uint8Array;
    resetProtocol(): void;
}

export class GBASRAM implements GBACartridgeSave {

    readonly data = new Uint8Array(GBA_SRAM_SIZE).fill(0xff);
    readonly byteLength = GBA_SRAM_SIZE;
    readonly type = 'sram' as const;
    private readonly onWrite: ((data: Uint8Array) => void) | undefined;

    constructor(onWrite?: (data: Uint8Array) => void) {

        this.onWrite = onWrite;
    }

    read(address: number): number {

        return this.data[address & (GBA_SRAM_SIZE - 1)] ?? 0xff;
    }

    write(address: number, value: number): void {

        this.data[address & (GBA_SRAM_SIZE - 1)] = value & 0xff;
        this.onWrite?.(this.dump());
    }

    load(data: Uint8Array): void {

        if (data.length !== GBA_SRAM_SIZE) {
            throw new RangeError('GBA SRAM data must be exactly 32768 bytes.');
        }

        this.data.set(data);
    }

    dump(): Uint8Array {

        return this.data.slice();
    }

    resetProtocol(): void {}
}

export class GBAFlash implements GBACartridgeSave {

    readonly data: Uint8Array;
    readonly byteLength: number;
    readonly type: 'flash512' | 'flash1m';
    private bank = 0;
    private erasePending = false;
    private idMode = false;
    private pendingCommand: 'none' | 'program' | 'bank' = 'none';
    private unlockStep = 0;
    private readonly onWrite: ((data: Uint8Array) => void) | undefined;

    constructor(type: 'flash512' | 'flash1m', onWrite?: (data: Uint8Array) => void) {

        this.type = type;
        this.byteLength = type === 'flash1m' ? GBA_FLASH1M_SIZE : GBA_FLASH512_SIZE;
        this.data = new Uint8Array(this.byteLength).fill(0xff);
        this.onWrite = onWrite;
    }

    read(address: number): number {

        const offset = address & 0xffff;

        if (this.idMode && offset < 2) {
            const id = this.type === 'flash1m' ? 0x1362 : 0x1b32;

            return (id >>> (offset * 8)) & 0xff;
        }

        return this.data[this.bank * GBA_FLASH512_SIZE + offset] ?? 0xff;
    }

    write(address: number, value: number): void {

        const offset = address & 0xffff;
        const byte = value & 0xff;

        if (this.pendingCommand === 'program') {
            const dataOffset = this.bank * GBA_FLASH512_SIZE + offset;

            this.data[dataOffset] = (this.data[dataOffset] ?? 0xff) & byte;
            this.pendingCommand = 'none';
            this.notifyWrite();
            return;
        }

        if (byte === 0xf0) {
            this.resetCommand();
            this.idMode = false;
            return;
        }

        if (this.pendingCommand === 'bank') {
            if (this.type === 'flash1m' && offset === 0) {
                this.bank = byte & 1;
            }

            this.pendingCommand = 'none';
            return;
        }

        if (this.unlockStep === 0) {
            if (offset === 0x5555 && byte === 0xaa) {
                this.unlockStep = 1;
            }
            return;
        }

        if (this.unlockStep === 1) {
            this.unlockStep = offset === 0x2aaa && byte === 0x55 ? 2 : 0;
            return;
        }

        this.unlockStep = 0;

        if (this.erasePending) {
            this.erasePending = false;

            if (offset === 0x5555 && byte === 0x10) {
                this.data.fill(0xff);
                this.notifyWrite();
            } else if (byte === 0x30) {
                const start = this.bank * GBA_FLASH512_SIZE + (offset & 0xf000);

                this.data.fill(0xff, start, start + 0x1000);
                this.notifyWrite();
            }
            return;
        }

        if (offset !== 0x5555) {
            return;
        }

        switch (byte) {
            case 0x80:
                this.erasePending = true;
                break;
            case 0x90:
                this.idMode = true;
                break;
            case 0xa0:
                this.pendingCommand = 'program';
                break;
            case 0xb0:
                if (this.type === 'flash1m') {
                    this.pendingCommand = 'bank';
                }
                break;
        }
    }

    load(data: Uint8Array): void {

        if (data.length !== this.byteLength) {
            throw new RangeError(`GBA ${this.type} data must be exactly ${this.byteLength} bytes.`);
        }

        this.data.set(data);
    }

    dump(): Uint8Array {

        return this.data.slice();
    }

    resetProtocol(): void {

        this.bank = 0;
        this.idMode = false;
        this.resetCommand();
    }

    private notifyWrite(): void {

        this.onWrite?.(this.dump());
    }

    private resetCommand(): void {

        this.erasePending = false;
        this.pendingCommand = 'none';
        this.unlockStep = 0;
    }
}

export function detectGBASaveType(rom: Uint8Array): GBASaveType | undefined {

    let detected: GBASaveType | undefined;

    for (let offset = 0; offset < rom.length; offset++) {
        if (rom[offset] === 0x46) {
            if (matchesSignature(rom, offset, 'FLASH1M_V')) {
                return 'flash1m';
            }

            if (matchesSignature(rom, offset, 'FLASH512_V')
                || matchesSignature(rom, offset, 'FLASH_V')) {
                detected = 'flash512';
            }
        } else if (rom[offset] === 0x53 && detected === undefined) {
            if (matchesSignature(rom, offset, 'SRAM_F_V')
                || matchesSignature(rom, offset, 'SRAM_V')) {
                detected = 'sram';
            }
        }
    }

    return detected;
}

function matchesSignature(rom: Uint8Array, offset: number, signature: string): boolean {

    for (let index = 0; index < signature.length; index++) {
        if (rom[offset + index] !== signature.charCodeAt(index)) {
            return false;
        }
    }

    return true;
}
