import { GBAAPU } from '../peripherals/apu.js';
import { GBA_DMA_REGISTER_STRIDE, GBADMA } from '../peripherals/dma.js';
import { GBA_INTERRUPT, GBAInterruptController } from '../peripherals/interrupts.js';
import { GBAKeypad } from '../peripherals/keypad.js';
import { GBAPPU } from '../peripherals/ppu.js';
import { GBASerial, type GBASerialEndpoint } from '../peripherals/serial.js';
import { GBATimers } from '../peripherals/timers.js';
import { GBAEEPROM, hasGBAEEPROM } from '../cartridge/eeprom.js';
import {
    GBACartridgeGPIO,
    hasGBARTC,
    type GBARTCOptions,
} from '../cartridge/gpio.js';
import {
    detectGBASaveType,
    GBAFlash,
    GBASRAM,
    type GBACartridgeSave,
} from '../cartridge/save.js';
import type { Button } from '../../types.js';

export const GBA_BIOS_SIZE = 0x00004000;
export const GBA_EWRAM_SIZE = 0x00040000;
export const GBA_IWRAM_SIZE = 0x00008000;
export const GBA_IO_SIZE = 0x00000400;
export const GBA_PALETTE_RAM_SIZE = 0x00000400;
export const GBA_VRAM_SIZE = 0x00018000;
export const GBA_OAM_SIZE = 0x00000400;
export const GBA_MAX_ROM_SIZE = 0x02000000;
export const GBA_WAITCNT_ADDRESS = 0x04000204;
export const GBA_WAITCNT_WRITABLE_MASK = 0x5fff;
export const GBA_DISPLAY_CONTROL_ADDRESS = 0x04000000;
export const GBA_DISPLAY_STATUS_ADDRESS = 0x04000004;
export const GBA_VERTICAL_COUNT_ADDRESS = 0x04000006;
export const GBA_BACKGROUND0_CONTROL_ADDRESS = 0x04000008;
export const GBA_BACKGROUND0_OFFSET_ADDRESS = 0x04000010;
export const GBA_BACKGROUND2_CONTROL_ADDRESS = 0x0400000c;
export const GBA_BACKGROUND2_AFFINE_ADDRESS = 0x04000020;
export const GBA_BACKGROUND3_AFFINE_ADDRESS = 0x04000030;
export const GBA_WINDOW0_HORIZONTAL_ADDRESS = 0x04000040;
export const GBA_WINDOW_CONTROL_ADDRESS = 0x04000048;
export const GBA_MOSAIC_ADDRESS = 0x0400004c;
export const GBA_BLEND_CONTROL_ADDRESS = 0x04000050;
export const GBA_SOUND1_CONTROL_LOW_ADDRESS = 0x04000060;
export const GBA_SOUND1_CONTROL_HIGH_ADDRESS = 0x04000062;
export const GBA_SOUND1_CONTROL_X_ADDRESS = 0x04000064;
export const GBA_SOUND2_CONTROL_LOW_ADDRESS = 0x04000068;
export const GBA_SOUND2_CONTROL_HIGH_ADDRESS = 0x0400006c;
export const GBA_SOUND3_CONTROL_LOW_ADDRESS = 0x04000070;
export const GBA_SOUND3_CONTROL_HIGH_ADDRESS = 0x04000072;
export const GBA_SOUND3_CONTROL_X_ADDRESS = 0x04000074;
export const GBA_SOUND4_CONTROL_LOW_ADDRESS = 0x04000078;
export const GBA_SOUND4_CONTROL_HIGH_ADDRESS = 0x0400007c;
export const GBA_SOUND_CONTROL_LOW_ADDRESS = 0x04000080;
export const GBA_SOUND_CONTROL_HIGH_ADDRESS = 0x04000082;
export const GBA_SOUND_CONTROL_X_ADDRESS = 0x04000084;
export const GBA_SOUND_BIAS_ADDRESS = 0x04000088;
export const GBA_WAVE_RAM_ADDRESS = 0x04000090;
export const GBA_FIFO_A_ADDRESS = 0x040000a0;
export const GBA_FIFO_B_ADDRESS = 0x040000a4;
export const GBA_INTERRUPT_ENABLE_ADDRESS = 0x04000200;
export const GBA_INTERRUPT_FLAGS_ADDRESS = 0x04000202;
export const GBA_INTERRUPT_MASTER_ENABLE_ADDRESS = 0x04000208;
export const GBA_KEY_INPUT_ADDRESS = 0x04000130;
export const GBA_KEY_CONTROL_ADDRESS = 0x04000132;
export const GBA_POST_BOOT_FLAG_ADDRESS = 0x04000300;
export const GBA_HALT_CONTROL_ADDRESS = 0x04000301;
export const GBA_TIMER_BASE_ADDRESS = 0x04000100;
export const GBA_TIMER_REGISTER_STRIDE = 4;
export const GBA_DMA_BASE_ADDRESS = 0x040000b0;

export type GBABusAccess = 'nonsequential' | 'sequential';
export type GBABusWidth = 8 | 16 | 32;

const GAME_PAK_FIRST_ACCESS = [4, 3, 2, 8] as const;
const GAME_PAK_SECOND_ACCESS = [
    [2, 1],
    [4, 1],
    [8, 1],
] as const;

export type GBABusRegion
    = | 'bios'
    | 'ewram'
    | 'iwram'
    | 'io'
    | 'palette'
    | 'vram'
    | 'oam'
    | 'game-pak-0'
    | 'game-pak-1'
    | 'game-pak-2'
    | 'eeprom'
    | 'save'
    | 'unmapped';

export interface GBABusOptions {
    readonly rom: Uint8Array;
    readonly bootROM?: Uint8Array;
    readonly audioSampleRate?: number;
    readonly audioBufferCapacity?: number;
    readonly saveData?: Uint8Array;
    readonly onSaveWrite?: (data: Uint8Array) => void;
    readonly rtc?: boolean | GBARTCOptions;
    readonly serialEndpoint?: GBASerialEndpoint;
}

export type GBALowPowerMode = 'halt' | 'stop';

export class GBABus {

    readonly rom: Uint8Array;
    readonly bootROM: Uint8Array | undefined;
    readonly ewram = new Uint8Array(GBA_EWRAM_SIZE);
    readonly iwram = new Uint8Array(GBA_IWRAM_SIZE);
    readonly io = new Uint8Array(GBA_IO_SIZE);
    readonly paletteRAM = new Uint8Array(GBA_PALETTE_RAM_SIZE);
    readonly vram = new Uint8Array(GBA_VRAM_SIZE);
    readonly oam = new Uint8Array(GBA_OAM_SIZE);
    readonly interrupts = new GBAInterruptController();
    readonly keypad = new GBAKeypad(this.interrupts);
    readonly serial: GBASerial;
    readonly dma = new GBADMA(this, this.interrupts);
    readonly apu: GBAAPU;
    readonly timers: GBATimers;
    readonly eeprom: GBAEEPROM | undefined;
    readonly save: GBACartridgeSave | undefined;
    readonly gpio: GBACartridgeGPIO | undefined;
    readonly ppu = new GBAPPU(this.interrupts, this.dma, {
        oam: this.oam,
        paletteRAM: this.paletteRAM,
        vram: this.vram,
    });
    readonly frame = this.ppu.frame;
    private openBusValue = 0;
    private accessPenalty = 0;
    private instructionBusCycles = 0;
    private gamePakBusyCycles = 0;
    private timingActive = false;
    private lowPowerRequest: GBALowPowerMode | undefined;
    private prefetchAddress: number | undefined;
    private prefetchCount = 0;
    private prefetchProgress = 0;

    constructor(options: GBABusOptions) {

        if (options.rom.length > GBA_MAX_ROM_SIZE) {
            throw new RangeError('A GBA ROM cannot exceed 32 MiB.');
        }

        if (options.bootROM !== undefined && options.bootROM.length !== GBA_BIOS_SIZE) {
            throw new RangeError('A GBA BIOS must be exactly 16384 bytes.');
        }

        this.rom = options.rom;
        this.bootROM = options.bootROM;
        this.serial = new GBASerial(this.interrupts, options.serialEndpoint);

        const rtcOptions = typeof options.rtc === 'object' ? options.rtc : undefined;
        const rtcEnabled = options.rtc !== false
            && (options.rtc !== undefined || hasGBARTC(options.rom));

        this.gpio = rtcEnabled
            ? new GBACartridgeGPIO({
                ...(rtcOptions === undefined ? {} : { rtc: rtcOptions }),
                requestInterrupt: () => this.interrupts.request(GBA_INTERRUPT.gamePak),
            })
            : undefined;
        this.eeprom = hasGBAEEPROM(options.rom)
            ? new GBAEEPROM(options.onSaveWrite)
            : undefined;

        const saveType = detectGBASaveType(options.rom);

        this.save = saveType === 'sram'
            ? new GBASRAM(options.onSaveWrite)
            : saveType === 'flash512' || saveType === 'flash1m'
                ? new GBAFlash(saveType, options.onSaveWrite)
                : undefined;

        if (options.saveData !== undefined) {
            const saveDevice = this.eeprom ?? this.save;

            if (saveDevice === undefined) {
                throw new RangeError('Save data was provided for a GBA ROM without supported save hardware.');
            }

            saveDevice.load(options.saveData);
        }

        this.apu = new GBAAPU(this.dma, {
            ...(options.audioSampleRate === undefined
                ? {}
                : { sampleRate: options.audioSampleRate }),
            ...(options.audioBufferCapacity === undefined
                ? {}
                : { bufferCapacity: options.audioBufferCapacity }),
        });
        this.timers = new GBATimers(
            this.interrupts,
            (timer, overflows) => this.apu.onTimerOverflow(timer, overflows),
        );
    }

    get openBus(): number {

        return this.openBusValue;
    }

    get waitControl(): number {

        return (this.io[0x204] ?? 0) | ((this.io[0x205] ?? 0) << 8);
    }

    get prefetchEnabled(): boolean {

        return (this.waitControl & 0x4000) !== 0;
    }

    setOpenBus(value: number): void {

        this.openBusValue = value >>> 0;
    }

    setButton(button: Button, pressed: boolean): void {

        this.keypad.setButton(button, pressed);
    }

    beginTiming(): void {

        this.accessPenalty = 0;
        this.instructionBusCycles = 0;
        this.gamePakBusyCycles = 0;
        this.timingActive = true;
    }

    endTiming(coreCycles = 0): number {

        const penalty = this.accessPenalty;
        const elapsedCycles = coreCycles + penalty;

        this.fillPrefetch(Math.max(0, elapsedCycles - this.gamePakBusyCycles));

        this.accessPenalty = 0;
        this.instructionBusCycles = 0;
        this.gamePakBusyCycles = 0;
        this.timingActive = false;

        return penalty;
    }

    idle(cycles: number): void {

        if (!Number.isSafeInteger(cycles) || cycles < 0) {
            throw new RangeError('GBA bus idle cycles must be a non-negative safe integer.');
        }

        this.fillPrefetch(cycles);
    }

    consumeLowPowerRequest(): GBALowPowerMode | undefined {

        const request = this.lowPowerRequest;

        this.lowPowerRequest = undefined;

        return request;
    }

    regionAt(address: number): GBABusRegion {

        const normalizedAddress = address >>> 0;
        const region = normalizedAddress >>> 24;

        if (region === 0x00) {
            return normalizedAddress < GBA_BIOS_SIZE ? 'bios' : 'unmapped';
        }

        if (region === 0x02) {
            return 'ewram';
        }

        if (region === 0x03) {
            return 'iwram';
        }

        if (region === 0x04) {
            return (normalizedAddress & 0x00ffffff) < GBA_IO_SIZE ? 'io' : 'unmapped';
        }

        if (region === 0x05) {
            return 'palette';
        }

        if (region === 0x06) {
            return 'vram';
        }

        if (region === 0x07) {
            return 'oam';
        }

        if (region === 0x08 || region === 0x09) {
            return 'game-pak-0';
        }

        if (region === 0x0a || region === 0x0b) {
            return 'game-pak-1';
        }

        if (region === 0x0c) {
            return 'game-pak-2';
        }

        if (region === 0x0d) {
            const eepromWindow = this.rom.length <= 0x01000000
                || (normalizedAddress & 0x00ffffff) >= 0x00ffff00;

            return this.eeprom !== undefined && eepromWindow ? 'eeprom' : 'game-pak-2';
        }

        if (region === 0x0e) {
            return 'save';
        }

        return 'unmapped';
    }

    accessCycles(
        address: number,
        width: GBABusWidth,
        access: GBABusAccess = 'nonsequential',
    ): number {

        const region = this.regionAt(address);

        switch (region) {
            case 'ewram':
                return width === 32 ? 6 : 3;
            case 'palette':
            case 'vram':
                return width === 32 ? 2 : 1;
            case 'game-pak-0':
                return this.gamePakCycles(0, width, access);
            case 'game-pak-1':
                return this.gamePakCycles(1, width, access);
            case 'game-pak-2':
                return this.gamePakCycles(2, width, access);
            case 'eeprom':
                return this.gamePakCycles(2, width, access);
            case 'save': {
                const byteCycles = GAME_PAK_FIRST_ACCESS[this.waitControl & 0x03] ?? 4;

                return byteCycles * (width / 8);
            }
            case 'bios':
            case 'iwram':
            case 'io':
            case 'oam':
            case 'unmapped':
                return 1;
        }
    }

    dmaAccessCycles(
        address: number,
        width: 16 | 32,
        access: GBABusAccess,
        cycleOffset: number,
    ): number {

        return this.videoAccessCycles(address, width, cycleOffset)
            ?? this.accessCycles(address, width, access);
    }

    beginDMATransfer(source: number, destination: number, _width: 16 | 32, count: number): void {

        if (this.regionAt(destination) === 'eeprom') {
            this.eeprom?.beginTransfer(count);
        } else if (this.regionAt(source) === 'eeprom') {
            this.eeprom?.beginTransfer(count);
        }
    }

    read8(address: number, access: GBABusAccess = 'nonsequential'): number {

        const normalizedAddress = address >>> 0;

        this.recordAccess(normalizedAddress, 8, access);

        if (this.regionAt(normalizedAddress) === 'eeprom') {
            return this.eeprom?.readBit() ?? 1;
        }

        if (this.regionAt(normalizedAddress) === 'save') {
            return this.save?.read(normalizedAddress) ?? this.readOpenBusByte(normalizedAddress);
        }

        return this.readMappedByte(normalizedAddress)
            ?? this.readOpenBusByte(normalizedAddress);
    }

    read16(address: number, access: GBABusAccess = 'nonsequential'): number {

        const alignedAddress = (address & 0xfffffffe) >>> 0;

        this.recordAccess(alignedAddress, 16, access);

        if (this.regionAt(alignedAddress) === 'eeprom') {
            return this.eeprom?.readBit() ?? 1;
        }

        if (this.regionAt(alignedAddress) === 'save') {
            const value = this.save?.read(alignedAddress) ?? this.readOpenBusByte(alignedAddress);

            return value | (value << 8);
        }

        return this.readRawByte(alignedAddress)
            | (this.readRawByte(alignedAddress + 1) << 8);
    }

    read32(address: number, access: GBABusAccess = 'nonsequential'): number {

        const alignedAddress = (address & 0xfffffffc) >>> 0;

        this.recordAccess(alignedAddress, 32, access);

        if (this.regionAt(alignedAddress) === 'save') {
            const value = this.save?.read(alignedAddress) ?? this.readOpenBusByte(alignedAddress);

            return (value * 0x01010101) >>> 0;
        }

        return (
            this.readRawByte(alignedAddress)
            | (this.readRawByte(alignedAddress + 1) << 8)
            | (this.readRawByte(alignedAddress + 2) << 16)
            | (this.readRawByte(alignedAddress + 3) << 24)
        ) >>> 0;
    }

    fetch16(address: number, access: GBABusAccess = 'nonsequential'): number {

        const alignedAddress = (address & 0xfffffffe) >>> 0;
        const gamePakROM = this.isGamePakROM(alignedAddress);

        this.recordCodeAccess(alignedAddress, 16, access, gamePakROM);

        if (gamePakROM && this.gpio === undefined) {
            const offset = alignedAddress & (GBA_MAX_ROM_SIZE - 1);

            return (this.rom[offset] ?? this.readOpenBusByte(alignedAddress))
                | ((this.rom[offset + 1] ?? this.readOpenBusByte(alignedAddress + 1)) << 8);
        }

        return this.readRawByte(alignedAddress)
            | (this.readRawByte(alignedAddress + 1) << 8);
    }

    fetch32(address: number, access: GBABusAccess = 'nonsequential'): number {

        const alignedAddress = (address & 0xfffffffc) >>> 0;

        this.recordCodeAccess(alignedAddress, 32, access, this.isGamePakROM(alignedAddress));

        return (
            this.readRawByte(alignedAddress)
            | (this.readRawByte(alignedAddress + 1) << 8)
            | (this.readRawByte(alignedAddress + 2) << 16)
            | (this.readRawByte(alignedAddress + 3) << 24)
        ) >>> 0;
    }

    write8(address: number, value: number, access: GBABusAccess = 'nonsequential'): void {

        const normalizedAddress = address >>> 0;
        const normalizedValue = value & 0xff;
        const region = this.regionAt(normalizedAddress);

        this.recordAccess(normalizedAddress, 8, access);

        if (region === 'eeprom') {
            this.eeprom?.writeBit(normalizedValue);
            return;
        }

        if (region === 'save') {
            this.save?.write(normalizedAddress, normalizedValue);
            return;
        }

        if (region === 'vram' && this.isObjectVRAM(normalizedAddress)) {
            return;
        }

        if (region === 'palette' || region === 'vram') {
            const alignedAddress = (normalizedAddress & 0xfffffffe) >>> 0;

            this.writeMappedByte(alignedAddress, normalizedValue);
            this.writeMappedByte(alignedAddress + 1, normalizedValue);
            return;
        }

        if (region !== 'oam') {
            this.writeMappedByte(normalizedAddress, normalizedValue);
        }
    }

    write16(address: number, value: number, access: GBABusAccess = 'nonsequential'): void {

        const alignedAddress = (address & 0xfffffffe) >>> 0;

        this.recordAccess(alignedAddress, 16, access);

        if (this.gpio?.write16(alignedAddress, value)) {
            return;
        }

        if (this.regionAt(alignedAddress) === 'eeprom') {
            this.eeprom?.writeBit(value);
            return;
        }

        if (this.regionAt(alignedAddress) === 'save') {
            this.save?.write(alignedAddress, value);
            return;
        }

        this.writeMappedByte(alignedAddress, value & 0xff);
        this.writeMappedByte(alignedAddress + 1, (value >>> 8) & 0xff);
    }

    write32(address: number, value: number, access: GBABusAccess = 'nonsequential'): void {

        const alignedAddress = (address & 0xfffffffc) >>> 0;

        this.recordAccess(alignedAddress, 32, access);

        const gpioLow = this.gpio?.write16(alignedAddress, value) ?? false;
        const gpioHigh = this.gpio?.write16(alignedAddress + 2, value >>> 16) ?? false;

        if (gpioLow || gpioHigh) {
            return;
        }

        if (this.regionAt(alignedAddress) === 'save') {
            this.save?.write(alignedAddress, value);
            return;
        }

        this.writeMappedByte(alignedAddress, value & 0xff);
        this.writeMappedByte(alignedAddress + 1, (value >>> 8) & 0xff);
        this.writeMappedByte(alignedAddress + 2, (value >>> 16) & 0xff);
        this.writeMappedByte(alignedAddress + 3, (value >>> 24) & 0xff);
    }

    reset(): void {

        this.ewram.fill(0);
        this.iwram.fill(0);
        this.io.fill(0);
        this.paletteRAM.fill(0);
        this.vram.fill(0);
        this.oam.fill(0);
        this.dma.reset();
        this.apu.reset();
        this.keypad.reset();
        this.serial.reset();
        this.ppu.reset();
        this.timers.reset();
        this.interrupts.reset();
        this.openBusValue = 0;
        this.accessPenalty = 0;
        this.instructionBusCycles = 0;
        this.gamePakBusyCycles = 0;
        this.timingActive = false;
        this.lowPowerRequest = undefined;
        this.eeprom?.resetProtocol();
        this.save?.resetProtocol();
        this.gpio?.reset();
        this.resetPrefetch();
    }

    private readMappedByte(address: number): number | undefined {

        const region = this.regionAt(address);

        switch (region) {
            case 'bios':
                return this.bootROM?.[address];
            case 'ewram':
                return this.ewram[address & (GBA_EWRAM_SIZE - 1)];
            case 'iwram':
                return this.iwram[address & (GBA_IWRAM_SIZE - 1)];
            case 'io':
                return this.readIOByte(address & (GBA_IO_SIZE - 1));
            case 'palette':
                return this.paletteRAM[address & (GBA_PALETTE_RAM_SIZE - 1)];
            case 'vram':
                return this.vram[this.vramOffset(address)];
            case 'oam':
                return this.ppu.canAccessOAM()
                    ? this.oam[address & (GBA_OAM_SIZE - 1)]
                    : undefined;
            case 'game-pak-0':
            case 'game-pak-1':
            case 'game-pak-2': {
                const gpioValue = this.gpio?.readByte(address);

                return gpioValue ?? this.rom[address & (GBA_MAX_ROM_SIZE - 1)];
            }
            case 'eeprom':
                return undefined;
            case 'save':
            case 'unmapped':
                return undefined;
        }
    }

    private writeMappedByte(address: number, value: number): void {

        const region = this.regionAt(address);

        switch (region) {
            case 'ewram':
                this.ewram[address & (GBA_EWRAM_SIZE - 1)] = value;
                break;
            case 'iwram':
                this.iwram[address & (GBA_IWRAM_SIZE - 1)] = value;
                break;
            case 'io':
                this.writeIOByte(address & (GBA_IO_SIZE - 1), value);
                break;
            case 'palette':
                this.paletteRAM[address & (GBA_PALETTE_RAM_SIZE - 1)] = value;
                break;
            case 'vram':
                this.vram[this.vramOffset(address)] = value;
                break;
            case 'oam':
                if (this.ppu.canAccessOAM()) {
                    this.oam[address & (GBA_OAM_SIZE - 1)] = value;
                }
                break;
            case 'bios':
            case 'game-pak-0':
            case 'game-pak-1':
            case 'game-pak-2':
            case 'eeprom':
            case 'save':
            case 'unmapped':
                break;
        }
    }

    private readOpenBusByte(address: number): number {

        return (this.openBusValue >>> ((address & 0x03) * 8)) & 0xff;
    }

    private readIOByte(offset: number): number | undefined {

        if (offset < 0x002) {
            return (this.ppu.readDisplayControl() >>> (offset * 8)) & 0xff;
        }

        if (offset >= 0x004 && offset < 0x006) {
            return (this.ppu.readDisplayStatus() >>> ((offset - 0x004) * 8)) & 0xff;
        }

        if (offset >= 0x006 && offset < 0x008) {
            return offset === 0x006 ? this.ppu.verticalCount : 0;
        }

        if (offset >= 0x008 && offset < 0x010) {
            const background = (offset - 0x008) >> 1;
            const value = this.ppu.readBackgroundControl(background);

            return (value >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x010 && offset < 0x020) {
            return 0;
        }

        if (offset >= 0x020 && offset < 0x040) {
            const background = 2 + ((offset - 0x020) >> 4);
            const register = (offset - 0x020) & 0x0f;

            if (register < 8) {
                const parameter = register >> 1;
                const value = this.ppu.readBackgroundAffineParameter(background, parameter);

                return (value >>> ((offset & 1) * 8)) & 0xff;
            }

            return 0;
        }

        if (offset >= 0x040 && offset < 0x048) {
            const register = (offset - 0x040) >> 1;
            const window = register & 1;
            const value = this.ppu.readWindowBounds(window, register >= 2);

            return (value >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x048 && offset < 0x04c) {
            return this.ppu.readWindowControl(offset - 0x048);
        }

        if (offset >= 0x04c && offset < 0x04e) {
            return (this.ppu.readMosaic() >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x050 && offset < 0x056) {
            const register = (offset - 0x050) >> 1;
            const value = this.ppu.readBlendRegister(register);

            return (value >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x060 && offset < 0x082) {
            return this.apu.readPSGByte(offset);
        }

        if (offset >= 0x082 && offset < 0x084) {
            return (this.apu.readControlHigh() >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x084 && offset < 0x086) {
            return (this.apu.readControlX() >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x088 && offset < 0x08a) {
            return (this.apu.readBias() >>> ((offset & 1) * 8)) & 0xff;
        }

        if (offset >= 0x090 && offset < 0x0a0) {
            return this.apu.readPSGByte(offset);
        }

        if (offset >= 0x0a0 && offset < 0x0a8) {
            return undefined;
        }

        if (offset >= 0x0b0 && offset < 0x0e0) {
            const channel = Math.floor((offset - 0x0b0) / GBA_DMA_REGISTER_STRIDE);
            const register = (offset - 0x0b0) % GBA_DMA_REGISTER_STRIDE;

            return this.dma.readByte(channel, register);
        }

        if (offset >= 0x100 && offset < 0x110) {
            const timer = (offset - 0x100) >> 2;
            const register = offset & 0x03;
            const value = register < 2
                ? this.timers.readCounter(timer)
                : this.timers.readControl(timer);

            return register === 0 || register === 2 ? value & 0xff : value >>> 8;
        }

        if ((offset >= 0x120 && offset < 0x12c)
            || (offset >= 0x134 && offset < 0x138)
            || (offset >= 0x140 && offset < 0x144)
            || (offset >= 0x150 && offset < 0x15c)) {
            return this.serial.readByte(offset);
        }

        if (offset >= 0x130 && offset < 0x134) {
            const value = offset < 0x132
                ? this.keypad.readInput()
                : this.keypad.readControl();

            return (value >>> ((offset & 1) * 8)) & 0xff;
        }

        switch (offset) {
            case 0x200:
                return this.interrupts.enabled & 0xff;
            case 0x201:
                return this.interrupts.enabled >>> 8;
            case 0x202:
                return this.interrupts.requested & 0xff;
            case 0x203:
                return this.interrupts.requested >>> 8;
            case 0x208:
                return this.interrupts.masterEnabled ? 1 : 0;
            case 0x209:
                return 0;
            case 0x300:
                return (this.io[offset] ?? 0) & 0x01;
            case 0x301:
                return 0;
            default:
                return this.io[offset] ?? 0;
        }
    }

    private readRawByte(address: number): number {

        return this.readMappedByte(address) ?? this.readOpenBusByte(address);
    }

    private recordAccess(address: number, width: GBABusWidth, access: GBABusAccess): void {

        const gamePakAccess = this.isGamePakAccess(address);

        if (gamePakAccess) {
            this.resetPrefetch();
        }

        if (!this.timingActive) {
            return;
        }

        const baseCycles = this.accessCycles(address, width, access);
        const cycles = this.videoAccessCycles(address, width, this.instructionBusCycles)
            ?? baseCycles;

        this.accessPenalty += cycles - 1;
        this.instructionBusCycles += cycles;

        if (gamePakAccess) {
            this.gamePakBusyCycles += cycles;
        }
    }

    private videoAccessCycles(
        address: number,
        width: GBABusWidth,
        cycleOffset: number,
    ): number | undefined {

        const region = this.regionAt(address);

        if (region === 'palette' || region === 'oam') {
            return this.ppu.cpuVideoAccessCycles(region, width, cycleOffset);
        }

        if (region === 'vram') {
            const videoBus = this.isObjectVRAM(address) ? 'object-vram' : 'background-vram';

            return this.ppu.cpuVideoAccessCycles(videoBus, width, cycleOffset);
        }

        return undefined;
    }

    private recordCodeAccess(
        address: number,
        width: 16 | 32,
        access: GBABusAccess,
        gamePakROM: boolean,
    ): void {

        if (!gamePakROM) {
            this.recordAccess(address, width, access);
            this.resetPrefetch();
            return;
        }

        const halfwords = width / 16;
        const prefetchHit = this.prefetchEnabled
            && access === 'sequential'
            && this.prefetchAddress === address
            && this.prefetchCount >= halfwords;

        if (prefetchHit) {
            this.prefetchAddress = (address + width / 8) >>> 0;
            this.prefetchCount -= halfwords;
        } else {
            this.prefetchAddress = (address + width / 8) >>> 0;
            this.prefetchCount = 0;
            this.prefetchProgress = 0;
        }

        if (!this.timingActive) {
            return;
        }

        const region = address >>> 24;
        const window = region < 0x0a ? 0 : region < 0x0c ? 1 : 2;
        const cycles = prefetchHit ? 1 : this.gamePakCycles(window, width, access);

        this.accessPenalty += cycles - 1;
        this.instructionBusCycles += cycles;

        if (!prefetchHit) {
            this.gamePakBusyCycles += cycles;
        }
    }

    private fillPrefetch(cycles: number): void {

        if (!this.prefetchEnabled || this.prefetchAddress === undefined) {
            return;
        }

        const region = this.regionAt(this.prefetchAddress);

        if (region !== 'game-pak-0'
            && region !== 'game-pak-1'
            && region !== 'game-pak-2') {
            this.resetPrefetch();
            return;
        }

        const window = region === 'game-pak-0' ? 0 : region === 'game-pak-1' ? 1 : 2;
        const firstShift = 2 + window * 3;
        const secondIndex = (this.waitControl >> (firstShift + 2)) & 0x01;
        const secondCycles = GAME_PAK_SECOND_ACCESS[window]?.[secondIndex] ?? 1;
        let remainingCycles = cycles;

        while (remainingCycles > 0 && this.prefetchCount < 8) {
            const requiredCycles = secondCycles - this.prefetchProgress;

            if (remainingCycles < requiredCycles) {
                this.prefetchProgress += remainingCycles;
                return;
            }

            remainingCycles -= requiredCycles;
            this.prefetchProgress = 0;
            this.prefetchCount++;
        }
    }

    private isGamePakROM(address: number): boolean {

        const normalizedAddress = address >>> 0;
        const region = normalizedAddress >>> 24;

        if (region >= 0x08 && region <= 0x0c) {
            return true;
        }

        if (region !== 0x0d) {
            return false;
        }

        const eepromWindow = this.rom.length <= 0x01000000
            || (normalizedAddress & 0x00ffffff) >= 0x00ffff00;

        return this.eeprom === undefined || !eepromWindow;
    }

    private isGamePakAccess(address: number): boolean {

        const region = this.regionAt(address);

        return this.isGamePakROM(address) || region === 'eeprom' || region === 'save';
    }

    private resetPrefetch(): void {

        this.prefetchAddress = undefined;
        this.prefetchCount = 0;
        this.prefetchProgress = 0;
    }

    private gamePakCycles(window: number, width: GBABusWidth, access: GBABusAccess): number {

        const firstShift = 2 + window * 3;
        const firstIndex = (this.waitControl >> firstShift) & 0x03;
        const secondIndex = (this.waitControl >> (firstShift + 2)) & 0x01;
        const firstCycles = GAME_PAK_FIRST_ACCESS[firstIndex] ?? 4;
        const secondCycles = GAME_PAK_SECOND_ACCESS[window]?.[secondIndex] ?? 1;
        const initialCycles = access === 'sequential' ? secondCycles : firstCycles;

        return width === 32 ? initialCycles + secondCycles : initialCycles;
    }

    private writeIOByte(offset: number, value: number): void {

        if (offset < 0x002) {
            const control = this.ppu.readDisplayControl();

            this.ppu.writeDisplayControl(offset === 0
                ? (control & 0xff00) | value
                : (control & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x004 && offset < 0x006) {
            const status = this.ppu.readDisplayStatus();

            this.ppu.writeDisplayStatus(offset === 0x004
                ? (status & 0xff00) | value
                : (status & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x006 && offset < 0x008) {
            return;
        }

        if (offset >= 0x008 && offset < 0x010) {
            const background = (offset - 0x008) >> 1;
            const control = this.ppu.readBackgroundControl(background);

            this.ppu.writeBackgroundControl(background, (offset & 1) === 0
                ? (control & 0xff00) | value
                : (control & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x010 && offset < 0x020) {
            const background = (offset - 0x010) >> 2;
            const vertical = (offset & 0x02) !== 0;
            const oldValue = this.ppu.readBackgroundOffset(background, vertical);

            this.ppu.writeBackgroundOffset(background, vertical, (offset & 1) === 0
                ? (oldValue & 0xff00) | value
                : (oldValue & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x020 && offset < 0x040) {
            const background = 2 + ((offset - 0x020) >> 4);
            const register = (offset - 0x020) & 0x0f;

            if (register < 8) {
                const parameter = register >> 1;
                const oldValue = this.ppu.readBackgroundAffineParameter(background, parameter);

                this.ppu.writeBackgroundAffineParameter(background, parameter, (offset & 1) === 0
                    ? (oldValue & 0xff00) | value
                    : (oldValue & 0x00ff) | (value << 8));
            } else {
                const reference = (register - 8) >> 2;
                const byte = register & 0x03;
                const oldValue = this.ppu.readBackgroundAffineReference(background, reference);
                const newValue = (oldValue & ~(0xff << (byte * 8))) | (value << (byte * 8));

                this.ppu.writeBackgroundAffineReference(background, reference, newValue, byte === 3);
            }
            return;
        }

        if (offset >= 0x040 && offset < 0x048) {
            const register = (offset - 0x040) >> 1;
            const window = register & 1;
            const vertical = register >= 2;
            const oldValue = this.ppu.readWindowBounds(window, vertical);

            this.ppu.writeWindowBounds(window, vertical, (offset & 1) === 0
                ? (oldValue & 0xff00) | value
                : (oldValue & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x048 && offset < 0x04c) {
            this.ppu.writeWindowControl(offset - 0x048, value);
            return;
        }

        if (offset >= 0x04c && offset < 0x04e) {
            const oldValue = this.ppu.readMosaic();

            this.ppu.writeMosaic((offset & 1) === 0
                ? (oldValue & 0xff00) | value
                : (oldValue & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x050 && offset < 0x056) {
            const register = (offset - 0x050) >> 1;
            const oldValue = this.ppu.readBlendRegister(register);

            this.ppu.writeBlendRegister(register, (offset & 1) === 0
                ? (oldValue & 0xff00) | value
                : (oldValue & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x060 && offset < 0x082) {
            this.apu.writePSGByte(offset, value);
            return;
        }

        if (offset >= 0x082 && offset < 0x084) {
            const control = this.apu.readControlHigh();

            this.apu.writeControlHigh((offset & 1) === 0
                ? (control & 0xff00) | value
                : (control & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x084 && offset < 0x086) {
            const control = this.apu.readControlX();

            this.apu.writeControlX((offset & 1) === 0
                ? (control & 0xff00) | value
                : (control & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x088 && offset < 0x08a) {
            const bias = this.apu.readBias();

            this.apu.writeBias((offset & 1) === 0
                ? (bias & 0xff00) | value
                : (bias & 0x00ff) | (value << 8));
            return;
        }

        if (offset >= 0x090 && offset < 0x0a0) {
            this.apu.writePSGByte(offset, value);
            return;
        }

        if (offset >= 0x0a0 && offset < 0x0a8) {
            this.apu.writeFIFO(offset < 0x0a4 ? 0 : 1, value);
            return;
        }

        if (offset >= 0x0b0 && offset < 0x0e0) {
            const channel = Math.floor((offset - 0x0b0) / GBA_DMA_REGISTER_STRIDE);
            const register = (offset - 0x0b0) % GBA_DMA_REGISTER_STRIDE;

            this.dma.writeByte(channel, register, value);
            return;
        }

        if (offset >= 0x100 && offset < 0x110) {
            const timer = (offset - 0x100) >> 2;
            const register = offset & 0x03;

            if (register < 2) {
                const reload = this.timers.readReload(timer);

                this.timers.writeReload(timer, register === 0
                    ? (reload & 0xff00) | value
                    : (reload & 0x00ff) | (value << 8));
            } else if (register === 2) {
                this.timers.writeControl(timer, value);
            }

            return;
        }

        if ((offset >= 0x120 && offset < 0x12c)
            || (offset >= 0x134 && offset < 0x138)
            || (offset >= 0x140 && offset < 0x144)
            || (offset >= 0x150 && offset < 0x15c)) {
            this.serial.writeByte(offset, value);
            return;
        }

        if (offset >= 0x130 && offset < 0x132) {
            return;
        }

        if (offset >= 0x132 && offset < 0x134) {
            const control = this.keypad.readControl();

            this.keypad.writeControl((offset & 1) === 0
                ? (control & 0xff00) | value
                : (control & 0x00ff) | (value << 8));
            return;
        }

        switch (offset) {
            case 0x200:
                this.interrupts.enabled = (this.interrupts.enabled & 0xff00) | value;
                return;
            case 0x201:
                this.interrupts.enabled = (this.interrupts.enabled & 0x00ff) | (value << 8);
                return;
            case 0x202:
                this.interrupts.acknowledge(value);
                return;
            case 0x203:
                this.interrupts.acknowledge(value << 8);
                return;
            case 0x208:
                this.interrupts.masterEnabled = (value & 1) !== 0;
                return;
            case 0x209:
                return;
            case 0x300:
                this.io[offset] = value & 0x01;
                return;
            case 0x301:
                this.lowPowerRequest = (value & 0x80) === 0 ? 'halt' : 'stop';
                return;
        }

        if (offset === 0x205) {
            const maskedValue = value & (GBA_WAITCNT_WRITABLE_MASK >>> 8);

            if (this.io[offset] !== maskedValue) {
                this.resetPrefetch();
            }

            this.io[offset] = maskedValue;
            return;
        }

        if (offset === 0x204 && this.io[offset] !== value) {
            this.resetPrefetch();
        }

        this.io[offset] = value;
    }

    private isObjectVRAM(address: number): boolean {

        const displayMode = this.ppu.displayMode;
        const objectBase = displayMode <= 2 ? 0x00010000 : 0x00014000;

        return this.vramOffset(address) >= objectBase;
    }

    private vramOffset(address: number): number {

        const offset = address & 0x0001ffff;

        return offset < GBA_VRAM_SIZE ? offset : offset - 0x00008000;
    }
}
