import type { GameBoyCartridgeHeader } from './header.js';

export interface GameBoyCartridgeOptions {
    readonly now?: () => number;
    readonly onRAMWrite?: (ram: Uint8Array) => void;
    readonly onRumble?: (enabled: boolean) => void;
    readonly strictHeader?: boolean;
}

export interface GameBoyCartridge {
    readonly header: GameBoyCartridgeHeader;
    readonly ram: Uint8Array;
    read(address: number): number;
    write(address: number, value: number): void;
    reset(): void;
    loadRAM(data: Uint8Array): void;
    dumpRAM(): Uint8Array;
}

export abstract class BaseGameBoyCartridge implements GameBoyCartridge {

    readonly header: GameBoyCartridgeHeader;
    readonly ram: Uint8Array;
    protected readonly rom: Uint8Array;
    protected readonly onRAMWrite: ((ram: Uint8Array) => void) | undefined;

    constructor(
        rom: Uint8Array,
        header: GameBoyCartridgeHeader,
        ramSize = header.ramSize,
        onRAMWrite?: (ram: Uint8Array) => void,
    ) {

        this.rom = rom;
        this.header = header;
        this.ram = new Uint8Array(ramSize);
        this.ram.fill(0xff);
        this.onRAMWrite = onRAMWrite;
    }

    abstract read(address: number): number;
    abstract write(address: number, value: number): void;

    reset(): void {}

    loadRAM(data: Uint8Array): void {

        if (data.length !== this.ram.length) {
            throw new RangeError(`Expected ${this.ram.length} bytes of cartridge RAM, received ${data.length}.`);
        }

        this.ram.set(data);
    }

    dumpRAM(): Uint8Array {

        return this.ram.slice();
    }

    protected readROM(bank: number, address: number): number {

        const bankCount = Math.max(1, Math.ceil(this.rom.length / 0x4000));
        const normalizedBank = ((bank % bankCount) + bankCount) % bankCount;
        const offset = normalizedBank * 0x4000 + (address & 0x3fff);

        return this.rom[offset] ?? 0xff;
    }

    protected readRAM(bank: number, address: number): number {

        if (this.ram.length === 0) {
            return 0xff;
        }

        const offset = (bank * 0x2000 + (address & 0x1fff)) % this.ram.length;

        return this.ram[offset] ?? 0xff;
    }

    protected writeRAM(bank: number, address: number, value: number): void {

        if (this.ram.length === 0) {
            return;
        }

        const offset = (bank * 0x2000 + (address & 0x1fff)) % this.ram.length;

        this.ram[offset] = value & 0xff;
        this.onRAMWrite?.(this.ram);
    }
}
