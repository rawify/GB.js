import {
    BaseGameBoyCartridge,
    type GameBoyCartridgeOptions,
} from './base.js';
import {
    GAME_BOY_LOGO,
    type GameBoyCartridgeHeader,
} from './header.js';

export class ROMCartridge extends BaseGameBoyCartridge {

    constructor(
        rom: Uint8Array,
        header: GameBoyCartridgeHeader,
        onRAMWrite?: (ram: Uint8Array) => void,
    ) {

        super(rom, header, header.ramSize, onRAMWrite);
    }

    read(address: number): number {

        address &= 0xffff;

        if (address <= 0x7fff) {
            return this.rom[address] ?? 0xff;
        }

        if (address >= 0xa000 && address <= 0xbfff) {
            return this.readRAM(0, address);
        }

        return 0xff;
    }

    write(address: number, value: number): void {

        address &= 0xffff;

        if (address >= 0xa000 && address <= 0xbfff) {
            this.writeRAM(0, address, value);
        }
    }
}

function hasLogoAtBank(rom: Uint8Array, bank: number): boolean {

    const offset = bank * 0x4000 + 0x0104;

    return GAME_BOY_LOGO.every((value, index) => rom[offset + index] === value);
}

export class MBC1Cartridge extends BaseGameBoyCartridge {

    private readonly bankStride: 4 | 5;
    private ramEnabled = false;
    private lowBank = 0;
    private highBank = 0;
    private mode = 0;

    constructor(
        rom: Uint8Array,
        header: GameBoyCartridgeHeader,
        onRAMWrite?: (ram: Uint8Array) => void,
    ) {

        super(rom, header, header.ramSize, onRAMWrite);
        this.bankStride = rom.length === 1024 * 1024 && hasLogoAtBank(rom, 0x10) ? 4 : 5;
    }

    read(address: number): number {

        address &= 0xffff;

        if (address <= 0x3fff) {
            const bank = this.mode === 0 ? 0 : this.highBank << this.bankStride;

            return this.readROM(bank, address);
        }

        if (address <= 0x7fff) {
            const lowMask = (1 << this.bankStride) - 1;
            let bank = (this.highBank << this.bankStride) | (this.lowBank & lowMask);

            if ((this.lowBank & 0x1f) === 0) {
                bank++;
            }

            return this.readROM(bank, address);
        }

        if (address >= 0xa000 && address <= 0xbfff && this.ramEnabled) {
            return this.readRAM(this.mode === 0 ? 0 : this.highBank, address);
        }

        return 0xff;
    }

    write(address: number, value: number): void {

        address &= 0xffff;
        value &= 0xff;

        if (address <= 0x1fff) {
            this.ramEnabled = (value & 0x0f) === 0x0a;
        } else if (address <= 0x3fff) {
            this.lowBank = value & 0x1f;
        } else if (address <= 0x5fff) {
            this.highBank = value & 0x03;
        } else if (address <= 0x7fff) {
            this.mode = value & 0x01;
        } else if (address >= 0xa000 && address <= 0xbfff && this.ramEnabled) {
            this.writeRAM(this.mode === 0 ? 0 : this.highBank, address, value);
        }
    }

    override reset(): void {

        this.ramEnabled = false;
        this.lowBank = 0;
        this.highBank = 0;
        this.mode = 0;
    }
}

export class MBC2Cartridge extends BaseGameBoyCartridge {

    private ramEnabled = false;
    private romBank = 1;

    constructor(
        rom: Uint8Array,
        header: GameBoyCartridgeHeader,
        onRAMWrite?: (ram: Uint8Array) => void,
    ) {

        super(rom, header, 512, onRAMWrite);
        this.ram.fill(0x0f);
    }

    read(address: number): number {

        address &= 0xffff;

        if (address <= 0x3fff) {
            return this.readROM(0, address);
        }

        if (address <= 0x7fff) {
            return this.readROM(this.romBank, address);
        }

        if (address >= 0xa000 && address <= 0xbfff && this.ramEnabled) {
            return 0xf0 | (this.ram[address & 0x01ff] ?? 0x0f);
        }

        return 0xff;
    }

    write(address: number, value: number): void {

        address &= 0xffff;
        value &= 0xff;

        if (address <= 0x3fff) {
            if (((address >> 8) & 1) === 0) {
                this.ramEnabled = (value & 0x0f) === 0x0a;
            } else {
                this.romBank = value & 0x0f;

                if (this.romBank === 0) {
                    this.romBank = 1;
                }
            }
        } else if (address >= 0xa000 && address <= 0xbfff && this.ramEnabled) {
            this.ram[address & 0x01ff] = value & 0x0f;
            this.onRAMWrite?.(this.ram);
        }
    }

    override reset(): void {

        this.ramEnabled = false;
        this.romBank = 1;
    }
}

export interface MBC3RTCState {
    readonly registers: Uint8Array;
    readonly latchedRegisters: Uint8Array;
    readonly lastUpdated: number;
}

export class MBC3Cartridge extends BaseGameBoyCartridge {

    private readonly now: () => number;
    private readonly rtc = new Uint8Array(5);
    private readonly latchedRTC = new Uint8Array(5);
    private lastUpdated: number;
    private ramAndRTCEnabled = false;
    private romBank = 1;
    private selection = 0;
    private latchValue = 0xff;

    constructor(
        rom: Uint8Array,
        header: GameBoyCartridgeHeader,
        options: GameBoyCartridgeOptions = {},
    ) {

        super(rom, header, header.ramSize, options.onRAMWrite);
        this.now = options.now ?? Date.now;
        this.lastUpdated = this.now();
    }

    read(address: number): number {

        address &= 0xffff;

        if (address <= 0x3fff) {
            return this.readROM(0, address);
        }

        if (address <= 0x7fff) {
            return this.readROM(this.romBank, address);
        }

        if (address < 0xa000 || address > 0xbfff || !this.ramAndRTCEnabled) {
            return 0xff;
        }

        if (this.selection <= 0x07) {
            return this.readRAM(this.selection, address);
        }

        if (
            this.header.cartridgeType.hasTimer
            && this.selection >= 0x08
            && this.selection <= 0x0c
        ) {
            return this.latchedRTC[this.selection - 0x08] ?? 0xff;
        }

        return 0xff;
    }

    write(address: number, value: number): void {

        address &= 0xffff;
        value &= 0xff;

        if (address <= 0x1fff) {
            this.ramAndRTCEnabled = (value & 0x0f) === 0x0a;
        } else if (address <= 0x3fff) {
            const mask = this.header.romSize > 2 * 1024 * 1024 ? 0xff : 0x7f;

            this.romBank = value & mask;

            if (this.romBank === 0) {
                this.romBank = 1;
            }
        } else if (address <= 0x5fff) {
            this.selection = value;
        } else if (address <= 0x7fff) {
            if (this.header.cartridgeType.hasTimer && this.latchValue === 0 && value === 1) {
                this.synchronizeRTC();
                this.latchedRTC.set(this.rtc);
            }

            this.latchValue = value;
        } else if (address >= 0xa000 && address <= 0xbfff && this.ramAndRTCEnabled) {
            if (this.selection <= 0x07) {
                this.writeRAM(this.selection, address, value);
            } else if (
                this.header.cartridgeType.hasTimer
                && this.selection >= 0x08
                && this.selection <= 0x0c
            ) {
                this.writeRTC(this.selection - 0x08, value);
            }
        }
    }

    override reset(): void {

        this.synchronizeRTC();
        this.ramAndRTCEnabled = false;
        this.romBank = 1;
        this.selection = 0;
        this.latchValue = 0xff;
    }

    getRTCState(): MBC3RTCState {

        this.synchronizeRTC();

        return {
            registers: this.rtc.slice(),
            latchedRegisters: this.latchedRTC.slice(),
            lastUpdated: this.lastUpdated,
        };
    }

    loadRTCState(state: MBC3RTCState): void {

        if (state.registers.length !== 5 || state.latchedRegisters.length !== 5) {
            throw new RangeError('MBC3 RTC state must contain five live and five latched registers.');
        }

        this.rtc.set(state.registers);
        this.latchedRTC.set(state.latchedRegisters);
        this.lastUpdated = state.lastUpdated;
        this.synchronizeRTC();
    }

    private synchronizeRTC(): void {

        const now = this.now();

        if ((((this.rtc[4] ?? 0) >> 6) & 1) !== 0) {
            this.lastUpdated = now;

            return;
        }

        const elapsedSeconds = Math.floor((now - this.lastUpdated) / 1000);

        if (elapsedSeconds <= 0) {
            if (elapsedSeconds < 0) {
                this.lastUpdated = now;
            }

            return;
        }

        this.lastUpdated += elapsedSeconds * 1000;

        const currentDays = (this.rtc[3] ?? 0) | (((this.rtc[4] ?? 0) & 0x01) << 8);
        let seconds = (this.rtc[0] ?? 0)
            + (this.rtc[1] ?? 0) * 60
            + (this.rtc[2] ?? 0) * 3600
            + currentDays * 86400
            + elapsedSeconds;
        const days = Math.floor(seconds / 86400);

        seconds %= 86400;
        this.rtc[0] = seconds % 60;
        this.rtc[1] = Math.floor(seconds / 60) % 60;
        this.rtc[2] = Math.floor(seconds / 3600);
        this.rtc[3] = days & 0xff;
        this.rtc[4] = ((this.rtc[4] ?? 0) & 0xc0) | ((days >> 8) & 0x01);

        if (days >= 512) {
            this.rtc[4] |= 0x80;
        }
    }

    private writeRTC(register: number, value: number): void {

        this.synchronizeRTC();

        switch (register) {
            case 0:
            case 1:
                this.rtc[register] = value % 60;
                break;
            case 2:
                this.rtc[register] = value % 24;
                break;
            case 3:
                this.rtc[register] = value;
                break;
            case 4: {
                const wasHalted = (((this.rtc[4] ?? 0) >> 6) & 1) !== 0;

                this.rtc[4] = value & 0xc1;

                if (wasHalted && ((value >> 6) & 1) === 0) {
                    this.lastUpdated = this.now();
                }
                break;
            }
        }
    }
}

export class MBC5Cartridge extends BaseGameBoyCartridge {

    private readonly onRumble: ((enabled: boolean) => void) | undefined;
    private ramEnabled = false;
    private romBank = 1;
    private ramBank = 0;
    private rumbleEnabled = false;

    constructor(
        rom: Uint8Array,
        header: GameBoyCartridgeHeader,
        options: GameBoyCartridgeOptions = {},
    ) {

        super(rom, header, header.ramSize, options.onRAMWrite);
        this.onRumble = options.onRumble;
    }

    read(address: number): number {

        address &= 0xffff;

        if (address <= 0x3fff) {
            return this.readROM(0, address);
        }

        if (address <= 0x7fff) {
            return this.readROM(this.romBank, address);
        }

        if (address >= 0xa000 && address <= 0xbfff && this.ramEnabled) {
            return this.readRAM(this.ramBank, address);
        }

        return 0xff;
    }

    write(address: number, value: number): void {

        address &= 0xffff;
        value &= 0xff;

        if (address <= 0x1fff) {
            this.ramEnabled = (value & 0x0f) === 0x0a;
        } else if (address <= 0x2fff) {
            this.romBank = (this.romBank & 0x0100) | value;
        } else if (address <= 0x3fff) {
            this.romBank = (this.romBank & 0x00ff) | ((value & 0x01) << 8);
        } else if (address <= 0x5fff) {
            if (this.header.cartridgeType.hasRumble) {
                const enabled = ((value >> 3) & 1) !== 0;

                this.ramBank = value & 0x07;

                if (enabled !== this.rumbleEnabled) {
                    this.rumbleEnabled = enabled;
                    this.onRumble?.(enabled);
                }
            } else {
                this.ramBank = value & 0x0f;
            }
        } else if (address >= 0xa000 && address <= 0xbfff && this.ramEnabled) {
            this.writeRAM(this.ramBank, address, value);
        }
    }

    override reset(): void {

        this.ramEnabled = false;
        this.romBank = 1;
        this.ramBank = 0;

        if (this.rumbleEnabled) {
            this.rumbleEnabled = false;
            this.onRumble?.(false);
        }
    }
}
