import type {
    AudioBuffer,
    Button,
    FrameBuffer,
    GameBoyColorRevision,
    GameBoyModel,
} from '../../types.js';
import { DMGAPU } from '../apu/apu.js';
import type { GameBoyCartridge } from '../cartridge/base.js';

export type DMGFramePalette = readonly [number, number, number, number];
export type DMGFrameCallback = (frame: FrameBuffer, frameNumber: number) => void;

export interface DMGSerialEndpoint {
    exchangeBit(outgoingBit: 0 | 1): 0 | 1;
}

interface LCDPixel {
    readonly color: number;
    readonly palette: number;
    readonly priority: boolean;
}

interface LCDObjectPixel {
    readonly color: number;
    readonly palette: number;
    readonly behindBackground: boolean;
    readonly sprite: number;
    readonly positionX: number;
}

export const DMG_GRAYSCALE_PALETTE: DMGFramePalette = Object.freeze([
    0xffffffff,
    0xffaaaaaa,
    0xff555555,
    0xff000000,
]);

export const GAME_BOY_INTERRUPT = {
    vblank: 0x01,
    lcdStat: 0x02,
    timer: 0x04,
    serial: 0x08,
    joypad: 0x10,
} as const;

export interface DMGBusOptions {
    readonly cartridge: GameBoyCartridge;
    readonly model?: GameBoyModel;
    readonly cgbRevision?: GameBoyColorRevision;
    readonly bootROM?: Uint8Array;
    readonly audioSampleRate?: number;
    readonly audioBufferCapacity?: number;
    readonly framePalette?: DMGFramePalette;
    readonly onFrame?: DMGFrameCallback;
    readonly serialEndpoint?: DMGSerialEndpoint;
}

export class DMGBus {

    readonly model: GameBoyModel;
    readonly cgbRevision: GameBoyColorRevision | undefined;
    readonly cartridge: GameBoyCartridge;
    readonly apu: DMGAPU;
    readonly frame: FrameBuffer = {
        width: 160,
        height: 144,
        pixels: new Uint32Array(160 * 144),
    };
    readonly vram = new Uint8Array(0x4000);
    readonly wram = new Uint8Array(0x8000);
    readonly oam = new Uint8Array(0x00a0);
    private readonly extraOAM = new Uint8Array(0x0060);
    readonly hram = new Uint8Array(0x007f);
    readonly io = new Uint8Array(0x0080);
    private readonly bootROM: Uint8Array | undefined;
    private readonly framePalette: Uint32Array;
    private readonly onFrame: DMGFrameCallback | undefined;
    private readonly serialEndpoint: DMGSerialEndpoint | undefined;
    private readonly cgbBackgroundPalettes = new Uint8Array(0x40);
    private readonly cgbObjectPalettes = new Uint8Array(0x40);
    private bootROMMapped: boolean;
    private cgbMode = false;
    private cgbCompatibilityPalettes = false;
    private vramBank = 0;
    private wramBank = 1;
    private cpuVRAMBus = 0xff;
    private doubleSpeed = false;
    private speedSwitchPrepared = false;
    private systemCycleRemainder = 0;
    private hdmaActive = false;
    private hdmaSource = 0;
    private hdmaDestination = 0;
    private hdmaBlocksRemaining = 0;
    private hdmaCPUStallCycles = 0;
    private cpuPaused = false;
    private hdmaResumeOnCPUWake = false;
    private joypadButtons = 0;
    private serialCycles = 0;
    private serialBits = 0;
    private completedFrameCount = 0;
    private interruptEnable = 0;
    private lcdEnabled = false;
    private lcdStarting = false;
    private lcdLine = 0;
    private lcdLY = 0;
    private lcdLineCycles = 0;
    private lcdMode3End = 252;
    private lcdPixelX = 0;
    private lcdPPUPositionX = -16;
    private lcdOutputX = 0;
    private lcdPixelStartCycle = 92;
    private readonly lcdBackgroundFIFO: LCDPixel[] = [];
    private readonly lcdObjectFIFO: (LCDObjectPixel | undefined)[] = [];
    private lcdFetcherState = 0;
    private lcdFetcherTileX = 0;
    private lcdFetcherWindow = false;
    private lcdFetcherMapAddress = 0;
    private lcdFetcherSourceY = 0;
    private lcdFetcherTile = 0;
    private lcdFetcherAttributes = 0;
    private lcdFetcherTileDataAddress = 0;
    private lcdFetcherDataLow = 0;
    private lcdFetcherDataHigh = 0;
    private lcdFetcherLastTileSet = false;
    private lcdTileSelectGlitchData = 0;
    private lcdTileSelectGlitchCycles = 0;
    private lcdFetcherInitialPixel = 0;
    private lcdPixelsToDiscard = 0;
    private lcdPixelStallCycles = 0;
    private lcdWindowFetcherStall = false;
    private lcdWindowFetchActive = false;
    private lcdInsertBackgroundPixel = false;
    private lcdDisableWindowPixelInsertionGlitch = false;
    private lcdWXJustChangedCycles = 0;
    private lcdCGBWXGlitch = false;
    private lcdCGBWXOldValue = 0;
    private lcdCGBWXOldValueCycles = 0;
    private lcdLineHasFractionalScrolling = false;
    private lcdWX166MatchedThisLine = false;
    private lcdWX166STATGlitchCycles = 0;
    private lcdWX166STATPulse = false;
    private readonly lcdLineSprites: number[] = [];
    private readonly lcdFetchedSprites = new Set<number>();
    private readonly lcdConsideredSpriteTiles = new Set<string>();
    private lcdFetchPenaltyAdjustment = 3;
    private lcdObjectFetchSnapshot: (LCDObjectPixel | undefined)[] | undefined;
    private lcdWindowYTriggered = false;
    private lcdWindowLine = 0;
    private lcdWindowStartedThisLine = false;
    private lcdWindowStartX = 0;
    private lcdWindowSourceX = 0;
    private lcdWindowRenderedThisLine = false;
    private readonly lcdBackgroundColors = new Uint8Array(160);
    private readonly lcdBackgroundPriority = new Uint8Array(160);
    private lcdCoincidence = true;
    private statInterruptLine = false;
    private divider = 0;
    private timerCounter = 0;
    private timerModulo = 0;
    private timerControl = 0;
    private timerReloadDelay = 0;
    private timerReloaded = false;
    private timerReloadedCycles = 0;
    private dmaActive = false;
    private dmaTransferring = false;
    private dmaSource = 0;
    private dmaPendingSource = 0;
    private dmaStartCycles = 0;
    private dmaIndex = 0;
    private dmaCyclesUntilByte = 0;

    constructor(options: DMGBusOptions) {

        const model = options.model ?? 'dmg';
        const bootROMSize = model === 'cgb' ? 0x0900 : 0x0100;

        if (options.bootROM !== undefined && options.bootROM.length !== bootROMSize) {
            throw new RangeError(`Expected a ${bootROMSize}-byte ${model.toUpperCase()} boot ROM, received ${options.bootROM.length}.`);
        }

        if (model !== 'cgb' && options.cgbRevision !== undefined) {
            throw new RangeError('A CGB revision requires the CGB hardware model.');
        }

        if (options.framePalette !== undefined && options.framePalette.length !== 4) {
            throw new RangeError(`Expected four DMG frame colors, received ${options.framePalette.length}.`);
        }

        this.model = model;
        this.cgbRevision = model === 'cgb' ? options.cgbRevision ?? 'c' : undefined;
        this.cartridge = options.cartridge;
        this.apu = new DMGAPU({
            sampleRate: options.audioSampleRate,
            bufferCapacity: options.audioBufferCapacity,
            model,
            cgbRevision: this.cgbRevision,
        });
        this.bootROM = options.bootROM?.slice();
        this.framePalette = new Uint32Array(options.framePalette ?? DMG_GRAYSCALE_PALETTE);
        this.onFrame = options.onFrame;
        this.serialEndpoint = options.serialEndpoint;
        this.bootROMMapped = this.bootROM !== undefined;
        this.cgbMode = model === 'cgb'
            && (this.bootROMMapped || this.cartridge.header.compatibility !== 'dmg');
        this.frame.pixels.fill(this.framePalette[0] ?? 0xffffffff);
        this.io.fill(0xff);
        this.io[0x0f] = 0;
        this.io[0x00] = 0x30;
        this.io[0x01] = 0;
        this.io[0x02] = 0x7e;
        this.io[0x40] = 0;
        this.io[0x41] = 0;
        this.io[0x42] = 0;
        this.io[0x43] = 0;
        this.io[0x45] = 0;
        this.io[0x4a] = 0;
        this.io[0x4b] = 0;
        this.initializeCGBRegisters();

        if (this.model === 'cgb' && !this.cgbMode) {
            this.io[0x4c] = 0x04;
            this.io[0x6c] = 0xff;
        }
    }

    get isBootROMMapped(): boolean {

        return this.bootROMMapped;
    }

    get isCGBMode(): boolean {

        return this.cgbMode;
    }

    get interruptFlags(): number {

        return this.io[0x0f] ?? 0;
    }

    set interruptFlags(value: number) {

        this.io[0x0f] = value & 0x1f;
    }

    get enabledInterrupts(): number {

        return this.interruptEnable & 0x1f;
    }

    set enabledInterrupts(value: number) {

        this.interruptEnable = value & 0xff;
    }

    get isOAMDMAActive(): boolean {

        return this.dmaActive;
    }

    get oamDMABytesTransferred(): number {

        return this.dmaIndex;
    }

    get completedFrames(): number {

        return this.completedFrameCount;
    }

    drainAudio(): AudioBuffer {

        return this.apu.drainAudio();
    }

    requestInterrupt(interrupt: number): void {

        this.interruptFlags |= interrupt;
    }

    clockSerial(inputBit: 0 | 1): 0 | 1 {

        const control = this.io[0x02] ?? 0;
        const outgoingBit = (control & 0x80) === 0
            ? 0
            : (control & 1) !== 0
                ? 1
                : ((this.io[0x01] ?? 0) >> 7) as 0 | 1;

        if ((control & 0x81) === 0x80) {
            this.shiftSerialBit((inputBit & 1) as 0 | 1);
        }

        return outgoingBit;
    }

    setButton(button: Button, pressed: boolean): void {

        const bits: Partial<Record<Button, number>> = {
            right: 0,
            left: 1,
            up: 2,
            down: 3,
            a: 4,
            b: 5,
            select: 6,
            start: 7,
        };
        const bit = bits[button];

        if (bit === undefined) {
            return;
        }

        const previous = this.readJoypad();

        if (pressed) {
            this.joypadButtons |= 1 << bit;
        } else {
            this.joypadButtons &= ~(1 << bit);
        }

        this.requestJoypadFallingEdge(previous, this.readJoypad());
    }

    stop(): boolean {

        this.writeIO(0xff04, 0);

        if (!this.cgbMode || !this.speedSwitchPrepared) {
            return false;
        }

        this.doubleSpeed = !this.doubleSpeed;
        this.speedSwitchPrepared = false;
        this.systemCycleRemainder = 0;
        this.apu.setDoubleSpeed(this.doubleSpeed);

        return true;
    }

    consumeCPUStallCycles(): number {

        const cycles = this.hdmaCPUStallCycles;

        this.hdmaCPUStallCycles = 0;

        return cycles;
    }

    setCPUPaused(paused: boolean): void {

        if (paused === this.cpuPaused) {
            return;
        }

        this.cpuPaused = paused;

        if (paused) {
            this.hdmaResumeOnCPUWake = this.lcdMode() !== 0;

            return;
        }

        if (this.hdmaActive && this.hdmaResumeOnCPUWake && this.lcdMode() === 0) {
            this.transferHDMABlock();
        }

        this.hdmaResumeOnCPUWake = false;
    }

    tick(cycles: number): void {

        if (cycles <= 0) {
            return;
        }

        this.tickTimer(cycles);
        this.tickSerial(cycles);

        const systemCycles = this.doubleSpeed
            ? Math.floor((cycles + this.systemCycleRemainder) / 2)
            : cycles;

        this.systemCycleRemainder = this.doubleSpeed
            ? (cycles + this.systemCycleRemainder) & 1
            : 0;
        this.apu.tick(systemCycles);
        this.tickOAMDMA(systemCycles);
        this.tickLCD(systemCycles);
    }

    read(address: number): number {

        const normalizedAddress = address & 0xffff;

        if (this.dmaTransferring && !this.cpuCanAccessDuringDMA(normalizedAddress)) {
            return 0xff;
        }

        if (!this.cpuCanReadPPUMemory(normalizedAddress)) {
            return 0xff;
        }

        if (normalizedAddress >= 0x8000 && normalizedAddress < 0xa000) {
            return this.readCPUVideoRAM(normalizedAddress);
        }

        return this.readMapped(normalizedAddress);
    }

    private readMapped(normalizedAddress: number): number {

        if (normalizedAddress < 0x8000) {
            const inBootROM = normalizedAddress < 0x0100
                || (this.model === 'cgb' && normalizedAddress >= 0x0200 && normalizedAddress < 0x0900);

            if (this.bootROMMapped && inBootROM) {
                return this.bootROM?.[normalizedAddress] ?? 0xff;
            }

            return this.cartridge.read(normalizedAddress);
        }

        if (normalizedAddress < 0xa000) {
            return this.vram[this.vramBank * 0x2000 + normalizedAddress - 0x8000] ?? 0xff;
        }

        if (normalizedAddress < 0xc000) {
            return this.cartridge.read(normalizedAddress);
        }

        if (normalizedAddress < 0xd000) {
            return this.wram[normalizedAddress - 0xc000] ?? 0xff;
        }

        if (normalizedAddress < 0xe000) {
            return this.wram[this.wramBank * 0x1000 + normalizedAddress - 0xd000] ?? 0xff;
        }

        if (normalizedAddress < 0xfe00) {
            return this.readMapped(normalizedAddress - 0x2000);
        }

        if (normalizedAddress < 0xfea0) {
            return this.oam[normalizedAddress - 0xfe00] ?? 0xff;
        }

        if (normalizedAddress < 0xff00) {
            return this.readUnusableOAM(normalizedAddress);
        }

        if (normalizedAddress < 0xff80) {
            return this.readIO(normalizedAddress);
        }

        if (normalizedAddress < 0xffff) {
            return this.hram[normalizedAddress - 0xff80] ?? 0xff;
        }

        return this.interruptEnable;
    }

    write(address: number, value: number): void {

        const normalizedAddress = address & 0xffff;
        const normalizedValue = value & 0xff;

        if (this.dmaTransferring && !this.cpuCanAccessDuringDMA(normalizedAddress)) {
            return;
        }

        if (!this.cpuCanWritePPUMemory(normalizedAddress)) {
            return;
        }

        if (normalizedAddress < 0x8000) {
            this.cartridge.write(normalizedAddress, normalizedValue);
        } else if (normalizedAddress < 0xa000) {
            this.vram[this.vramBank * 0x2000 + normalizedAddress - 0x8000] = normalizedValue;
        } else if (normalizedAddress < 0xc000) {
            this.cartridge.write(normalizedAddress, normalizedValue);
        } else if (normalizedAddress < 0xd000) {
            this.wram[normalizedAddress - 0xc000] = normalizedValue;
        } else if (normalizedAddress < 0xe000) {
            this.wram[this.wramBank * 0x1000 + normalizedAddress - 0xd000] = normalizedValue;
        } else if (normalizedAddress < 0xfe00) {
            this.writeMappedRAM(normalizedAddress - 0x2000, normalizedValue);
        } else if (normalizedAddress < 0xfea0) {
            this.oam[normalizedAddress - 0xfe00] = normalizedValue;
        } else if (normalizedAddress < 0xff00) {
            this.writeUnusableOAM(normalizedAddress, normalizedValue);
        } else if (normalizedAddress < 0xff80) {
            this.writeIO(normalizedAddress, normalizedValue);
        } else if (normalizedAddress < 0xffff) {
            this.hram[normalizedAddress - 0xff80] = normalizedValue;
        } else {
            this.interruptEnable = normalizedValue;
        }
    }

    reset(): void {

        this.frame.pixels.fill(this.framePalette[0] ?? 0xffffffff);
        this.apu.reset();
        this.vram.fill(0);
        this.wram.fill(0);
        this.oam.fill(0);
        this.extraOAM.fill(0);
        this.hram.fill(0);
        this.io.fill(0xff);
        this.io[0x0f] = 0;
        this.io[0x00] = 0x30;
        this.io[0x01] = 0;
        this.io[0x02] = 0x7e;
        this.io[0x40] = 0;
        this.io[0x41] = 0;
        this.io[0x42] = 0;
        this.io[0x43] = 0;
        this.io[0x45] = 0;
        this.io[0x4a] = 0;
        this.io[0x4b] = 0;
        this.initializeCGBRegisters();
        this.cgbMode = this.model === 'cgb'
            && (this.bootROM !== undefined || this.cartridge.header.compatibility !== 'dmg');
        this.cgbCompatibilityPalettes = false;

        if (this.model === 'cgb' && !this.cgbMode) {
            this.io[0x4c] = 0x04;
            this.io[0x6c] = 0xff;
        }

        this.cgbBackgroundPalettes.fill(0);
        this.cgbObjectPalettes.fill(0);
        this.vramBank = 0;
        this.wramBank = 1;
        this.cpuVRAMBus = 0xff;
        this.doubleSpeed = false;
        this.speedSwitchPrepared = false;
        this.systemCycleRemainder = 0;
        this.hdmaActive = false;
        this.hdmaSource = 0;
        this.hdmaDestination = 0;
        this.hdmaBlocksRemaining = 0;
        this.hdmaCPUStallCycles = 0;
        this.cpuPaused = false;
        this.hdmaResumeOnCPUWake = false;
        this.joypadButtons = 0;
        this.serialCycles = 0;
        this.serialBits = 0;
        this.interruptEnable = 0;
        this.completedFrameCount = 0;
        this.lcdEnabled = false;
        this.lcdStarting = false;
        this.lcdLine = 0;
        this.lcdLY = 0;
        this.lcdLineCycles = 0;
        this.lcdMode3End = 252;
        this.lcdPixelX = 0;
        this.lcdPPUPositionX = -16;
        this.lcdOutputX = 0;
        this.lcdPixelStartCycle = 92;
        this.lcdBackgroundFIFO.length = 0;
        this.lcdObjectFIFO.length = 0;
        this.lcdFetcherState = 0;
        this.lcdFetcherTileX = 0;
        this.lcdFetcherWindow = false;
        this.lcdFetcherMapAddress = 0;
        this.lcdFetcherSourceY = 0;
        this.lcdFetcherTile = 0;
        this.lcdFetcherAttributes = 0;
        this.lcdFetcherTileDataAddress = 0;
        this.lcdFetcherDataLow = 0;
        this.lcdFetcherDataHigh = 0;
        this.lcdFetcherLastTileSet = false;
        this.lcdTileSelectGlitchData = 0;
        this.lcdTileSelectGlitchCycles = 0;
        this.lcdFetcherInitialPixel = 0;
        this.lcdPixelsToDiscard = 0;
        this.lcdPixelStallCycles = 0;
        this.lcdWindowFetcherStall = false;
        this.lcdWindowFetchActive = false;
        this.lcdInsertBackgroundPixel = false;
        this.lcdDisableWindowPixelInsertionGlitch = false;
        this.lcdWXJustChangedCycles = 0;
        this.lcdCGBWXGlitch = false;
        this.lcdCGBWXOldValue = 0;
        this.lcdCGBWXOldValueCycles = 0;
        this.lcdLineHasFractionalScrolling = false;
        this.lcdWX166MatchedThisLine = false;
        this.lcdWX166STATGlitchCycles = 0;
        this.lcdWX166STATPulse = false;
        this.lcdLineSprites.length = 0;
        this.lcdFetchedSprites.clear();
        this.lcdConsideredSpriteTiles.clear();
        this.lcdFetchPenaltyAdjustment = 3;
        this.lcdObjectFetchSnapshot = undefined;
        this.lcdWindowYTriggered = false;
        this.lcdWindowLine = 0;
        this.lcdWindowStartedThisLine = false;
        this.lcdWindowStartX = 0;
        this.lcdWindowSourceX = 0;
        this.lcdWindowRenderedThisLine = false;
        this.lcdCoincidence = true;
        this.statInterruptLine = false;
        this.divider = 0;
        this.timerCounter = 0;
        this.timerModulo = 0;
        this.timerControl = 0;
        this.timerReloadDelay = 0;
        this.timerReloaded = false;
        this.timerReloadedCycles = 0;
        this.dmaActive = false;
        this.dmaTransferring = false;
        this.dmaSource = 0;
        this.dmaPendingSource = 0;
        this.dmaStartCycles = 0;
        this.dmaIndex = 0;
        this.dmaCyclesUntilByte = 0;
        this.bootROMMapped = this.bootROM !== undefined;
        this.cartridge.reset();
    }

    private readIO(address: number): number {

        const offset = address - 0xff00;

        if (this.isUnusedIOAddress(address)) {
            return 0xff;
        }

        if (address === 0xff00) {
            return this.readJoypad();
        }

        if (address === 0xff02) {
            return this.io[offset] ?? 0xff;
        }

        if (address >= 0xff10 && address <= 0xff3f) {
            return this.apu.read(address);
        }

        if (address === 0xff0f) {
            return this.interruptFlags | 0xe0;
        }

        if (address === 0xff04) {
            return this.divider >> 8;
        }

        if (address === 0xff05) {
            return this.timerReloadDelay === 0 ? this.timerCounter : 0;
        }

        if (address === 0xff06) {
            return this.timerModulo;
        }

        if (address === 0xff07) {
            return this.timerControl | 0xf8;
        }

        if (address === 0xff44) {
            return this.lcdLY;
        }

        if (address === 0xff41) {
            const coincidence = this.lcdCoincidence ? 0x04 : 0;

            return 0x80 | ((this.io[offset] ?? 0) & 0x78) | coincidence | this.lcdMode();
        }

        if (address === 0xff4c) {
            return 0xff;
        }

        if (this.model === 'cgb') {
            if (address === 0xff56) {
                if (!this.cgbMode) {
                    return 0xff;
                }

                const revisionMask = this.cgbRevision === 'e' ? 0 : 0x10;

                return ((this.io[offset] ?? 0) & 0xc1) | 0x2e | revisionMask;
            }

            if (address === 0xff4d) {
                if (!this.cgbMode) {
                    return 0xff;
                }

                return 0x7e | (this.doubleSpeed ? 0x80 : 0) | (this.speedSwitchPrepared ? 1 : 0);
            }

            if (address === 0xff4f) {
                return 0xfe | this.vramBank;
            }

            if (address >= 0xff51 && address <= 0xff54) {
                return 0xff;
            }

            if (address === 0xff55) {
                if (!this.cgbMode) {
                    return 0xff;
                }

                return this.hdmaActive
                    ? this.hdmaBlocksRemaining - 1
                    : (this.hdmaBlocksRemaining === 0 ? 0xff : 0x80 | (this.hdmaBlocksRemaining - 1));
            }

            if (address === 0xff68 || address === 0xff6a) {
                return 0x40 | (this.io[offset] ?? 0);
            }

            if (address === 0xff69) {
                if (!this.cgbMode && !this.bootROMMapped) {
                    return 0xff;
                }

                if (this.lcdMode() === 3) {
                    return 0xff;
                }

                return this.cgbBackgroundPalettes[(this.io[0x68] ?? 0) & 0x3f] ?? 0xff;
            }

            if (address === 0xff6b) {
                if (!this.cgbMode && !this.bootROMMapped) {
                    return 0xff;
                }

                if (this.lcdMode() === 3) {
                    return 0xff;
                }

                return this.cgbObjectPalettes[(this.io[0x6a] ?? 0) & 0x3f] ?? 0xff;
            }

            if (address === 0xff6c) {
                return 0xfe | ((this.io[offset] ?? 0) & 1);
            }

            if (address === 0xff70) {
                if (!this.cgbMode) {
                    return 0xff;
                }

                return 0xf8 | this.wramBank;
            }

            if (address === 0xff72 || address === 0xff73) {
                return this.io[offset] ?? 0xff;
            }

            if (address === 0xff74) {
                return this.cgbMode ? (this.io[offset] ?? 0xff) : 0xff;
            }

            if (address === 0xff75) {
                return (this.io[offset] ?? 0) | 0x8f;
            }

            if (address === 0xff76) {
                return this.apu.pcm12;
            }

            if (address === 0xff77) {
                return this.apu.pcm34;
            }
        }

        if (address === 0xff50) {
            return 0xff;
        }

        return this.io[offset] ?? 0xff;
    }

    private writeIO(address: number, value: number): void {

        const offset = address - 0xff00;

        if (this.isUnusedIOAddress(address)) {
            return;
        }

        if (address === 0xff4c) {
            if (this.model === 'cgb' && this.bootROMMapped) {
                this.io[offset] = value;
                this.setCGBMode((value & 0x0c) === 0);
            }

            return;
        }

        if (address === 0xff4b) {
            if (this.model === 'cgb' && this.doubleSpeed) {
                this.lcdCGBWXOldValue = this.io[offset] ?? 0;
                this.lcdCGBWXOldValueCycles = 1;
            } else if (this.model === 'dmg') {
                this.lcdWXJustChangedCycles = 1;
            }

            this.io[offset] = value;

            return;
        }

        if (address === 0xff00) {
            const previous = this.readJoypad();

            this.io[offset] = value & 0x30;
            this.requestJoypadFallingEdge(previous, this.readJoypad());

            return;
        }

        if (address === 0xff01) {
            this.io[offset] = value;

            return;
        }

        if (address === 0xff02) {
            const writable = this.cgbMode ? value & 0x83 : (value & 0x81) | 0x02;

            this.io[offset] = writable | 0x7c;
            this.serialCycles = 0;
            this.serialBits = 0;

            return;
        }

        if (address === 0xff0f) {
            this.interruptFlags = value;

            return;
        }

        if (address === 0xff04) {
            const oldSignal = this.timerSignal();

            this.apu.resetDivider();
            this.divider = 0;

            if (oldSignal && !this.timerSignal()) {
                this.incrementTimer();
            }

            return;
        }

        if (address === 0xff05) {
            if (!this.timerReloaded) {
                this.timerCounter = value;
                this.timerReloadDelay = 0;
            }

            return;
        }

        if (address === 0xff06) {
            this.timerModulo = value;

            if (this.timerReloadDelay !== 0 || this.timerReloaded) {
                this.timerCounter = value;
            }

            return;
        }

        if (address === 0xff07) {
            const oldSignal = this.timerSignal();

            this.timerControl = value & 0x07;

            if (oldSignal && !this.timerSignal()) {
                this.incrementTimer();
            }

            return;
        }

        if (address >= 0xff10 && address <= 0xff3f) {
            this.apu.write(address, value);

            return;
        }

        if (this.model === 'cgb') {
            if (address === 0xff56) {
                this.io[offset] = value;

                return;
            }

            if (address === 0xff4d) {
                if (!this.cgbMode) {
                    return;
                }

                this.speedSwitchPrepared = (value & 1) !== 0;

                return;
            }

            if (address === 0xff4f) {
                if (this.cgbMode) {
                    this.vramBank = value & 1;
                }

                return;
            }

            if (address >= 0xff51 && address <= 0xff54) {
                if (!this.cgbMode) {
                    return;
                }

                const masks = [0xff, 0xf0, 0x1f, 0xf0];

                this.io[offset] = value & (masks[address - 0xff51] ?? 0xff);

                return;
            }

            if (address === 0xff55) {
                if (this.cgbMode) {
                    this.writeHDMAControl(value);
                }

                return;
            }

            if (address === 0xff68 || address === 0xff6a) {
                this.io[offset] = value & 0xbf;

                return;
            }

            if (address === 0xff69 || address === 0xff6b) {
                if (!this.cgbMode && !this.bootROMMapped) {
                    return;
                }

                const indexOffset = address === 0xff69 ? 0x68 : 0x6a;
                const palette = address === 0xff69
                    ? this.cgbBackgroundPalettes
                    : this.cgbObjectPalettes;
                const index = (this.io[indexOffset] ?? 0) & 0x3f;

                if (this.lcdMode() !== 3) {
                    palette[index] = value;
                }

                if (((this.io[indexOffset] ?? 0) >> 7) & 1) {
                    this.io[indexOffset] = ((this.io[indexOffset] ?? 0) & 0x80) | ((index + 1) & 0x3f);
                }

                return;
            }

            if (address === 0xff6c) {
                if (this.bootROMMapped || this.cgbMode || ((this.io[0x4c] ?? 0) & 0x08) !== 0) {
                    this.io[offset] = value & 1;
                }

                return;
            }

            if (address === 0xff70) {
                if (!this.cgbMode && !this.bootROMMapped) {
                    return;
                }

                this.wramBank = value & 0x07;

                if (this.wramBank === 0) {
                    this.wramBank = 1;
                }

                return;
            }

            if (address === 0xff76 || address === 0xff77) {
                return;
            }
        }

        if (address === 0xff40) {
            const enabled = ((value >> 7) & 1) !== 0;
            const previous = this.io[offset] ?? 0;

            if (this.model === 'cgb'
                && ((previous ^ value) & 0x10) !== 0
                && (this.doubleSpeed || ((previous >> 4) & 1) !== 0)) {
                this.lcdTileSelectGlitchCycles = 1;
            }

            if (this.model === 'dmg'
                && ((previous >> 5) & 1) !== 0
                && ((value >> 5) & 1) === 0
                && this.lcdWindowFetchActive) {
                this.lcdDisableWindowPixelInsertionGlitch = true;
            }

            if (this.model === 'dmg'
                && ((previous >> 1) & 1) !== 0
                && ((value >> 1) & 1) === 0
                && this.lcdObjectFetchSnapshot !== undefined) {
                this.abortLCDObjectFetch();
            }

            this.io[offset] = value;

            if (enabled !== this.lcdEnabled) {
                this.lcdEnabled = enabled;
                this.lcdStarting = enabled;
                this.lcdLine = 0;
                this.lcdLY = 0;
                this.lcdLineCycles = 0;
                this.lcdMode3End = 252;
                this.lcdPixelX = 0;
                this.lcdPPUPositionX = -16;
                this.lcdOutputX = 0;
                this.lcdPixelStartCycle = 92;
                this.lcdBackgroundFIFO.length = 0;
                this.lcdObjectFIFO.length = 0;
                this.lcdPixelStallCycles = 0;
                this.lcdTileSelectGlitchCycles = 0;
                this.lcdWindowFetchActive = false;
                this.lcdInsertBackgroundPixel = false;
                this.lcdLineSprites.length = 0;
                this.lcdFetchedSprites.clear();
                this.lcdObjectFetchSnapshot = undefined;
                this.lcdWindowYTriggered = false;
                this.lcdWindowLine = 0;
                this.lcdWindowRenderedThisLine = false;

                if (enabled) {
                    this.updateLCDCoincidence();
                } else {
                    this.frame.pixels.fill(this.framePalette[0] ?? 0xffffffff);
                }

                this.updateSTATInterruptLine();
            }

            return;
        }

        if (address === 0xff41) {
            this.io[offset] = value & 0x78;
            this.updateSTATInterruptLine();

            return;
        }

        if (address === 0xff45) {
            this.io[offset] = value;

            if (this.lcdEnabled) {
                this.updateLCDCoincidence();
                this.updateSTATInterruptLine();
            }

            return;
        }

        if (address === 0xff46) {
            this.io[offset] = value;
            this.dmaActive = true;
            this.dmaPendingSource = value << 8;
            this.dmaStartCycles = 8;

            return;
        }

        if (address === 0xff44) {
            return;
        }

        if (address === 0xff50) {
            if (value !== 0) {
                this.bootROMMapped = false;
            }

            return;
        }

        this.io[offset] = value;
    }

    private tickTimer(cycles: number): void {

        for (let cycle = 0; cycle < cycles; cycle++) {
            if (this.timerReloadedCycles === 0) {
                this.timerReloaded = false;
            } else {
                this.timerReloadedCycles--;

                if (this.timerReloadedCycles === 0) {
                    this.timerReloaded = false;
                }
            }

            if (this.timerReloadDelay > 0) {
                this.timerReloadDelay--;

                if (this.timerReloadDelay === 0) {
                    this.timerCounter = this.timerModulo;
                    this.timerReloaded = true;
                    this.timerReloadedCycles = 4;
                    this.requestInterrupt(GAME_BOY_INTERRUPT.timer);
                }
            }

            const oldSignal = this.timerSignal();

            this.divider = (this.divider + 1) & 0xffff;

            if (oldSignal && !this.timerSignal()) {
                this.incrementTimer();
            }
        }
    }

    private timerSignal(): boolean {

        if (((this.timerControl >> 2) & 1) === 0) {
            return false;
        }

        const dividerBits = [9, 3, 5, 7];
        const bit = dividerBits[this.timerControl & 0x03] ?? 9;

        return ((this.divider >> bit) & 1) !== 0;
    }

    private incrementTimer(): void {

        if (this.timerReloadDelay !== 0) {
            return;
        }

        if (this.timerCounter === 0xff) {
            this.timerCounter = 0;
            this.timerReloadDelay = 4;
        } else {
            this.timerCounter++;
        }
    }

    private readJoypad(): number {

        const selection = (this.io[0x00] ?? 0x30) & 0x30;
        let inputs = 0x0f;

        if (((selection >> 4) & 1) === 0) {
            inputs &= ~(this.joypadButtons & 0x0f);
        }

        if (((selection >> 5) & 1) === 0) {
            inputs &= ~((this.joypadButtons >> 4) & 0x0f);
        }

        return 0xc0 | selection | inputs;
    }

    private requestJoypadFallingEdge(previous: number, current: number): void {

        if (((previous & ~current) & 0x0f) !== 0) {
            this.requestInterrupt(GAME_BOY_INTERRUPT.joypad);
        }
    }

    private tickSerial(cycles: number): void {

        const control = this.io[0x02] ?? 0;

        if ((control & 0x81) !== 0x81) {
            return;
        }

        const clockCycles = this.cgbMode && ((control >> 1) & 1) !== 0 ? 16 : 512;

        this.serialCycles += cycles;

        while (this.serialCycles >= clockCycles && this.serialBits < 8) {
            const outgoingBit = ((this.io[0x01] ?? 0) >> 7) as 0 | 1;
            const inputBit = (this.serialEndpoint?.exchangeBit(outgoingBit) ?? 1) & 1;

            this.serialCycles -= clockCycles;
            this.shiftSerialBit(inputBit as 0 | 1);
        }
    }

    private shiftSerialBit(inputBit: 0 | 1): void {

        this.io[0x01] = (((this.io[0x01] ?? 0) << 1) | inputBit) & 0xff;
        this.serialBits++;

        if (this.serialBits === 8) {
            this.io[0x02] = (this.io[0x02] ?? 0) & ~0x80;
            this.serialBits = 0;
            this.requestInterrupt(GAME_BOY_INTERRUPT.serial);
        }
    }

    private tickLCD(cycles: number): void {

        if (!this.lcdEnabled) {
            return;
        }

        for (let cycle = 0; cycle < cycles; cycle++) {
            if (this.lcdWX166STATPulse) {
                this.lcdWX166STATPulse = false;
                this.updateSTATInterruptLine();
            }

            this.lcdLineCycles++;

            if (this.model === 'cgb' && this.lcdLine === 153) {
                this.tickCGBLine153();
            }

            const lineCycles = this.lcdStarting ? 452 : 456;
            const mode3Start = this.lcdStarting ? 76 : 80;

            if (this.lcdLine < 144 && this.lcdLineCycles === (this.lcdStarting ? 448 : 452)) {
                this.lcdLY = this.lcdLine + 1;
                this.lcdCoincidence = false;
            } else if (this.lcdLineCycles === lineCycles) {
                this.lcdLineCycles = 0;
                this.lcdLine = (this.lcdLine + 1) % 154;
                if (this.model !== 'cgb' || this.lcdLine !== 153) {
                    this.lcdLY = this.lcdLine;
                }
                this.lcdStarting = false;

                if (this.lcdLine === 0) {
                    this.lcdWindowYTriggered = false;
                    this.lcdWindowLine = 0;
                }

                this.updateLCDCoincidence();

                if (this.lcdLine === 144) {
                    this.requestInterrupt(GAME_BOY_INTERRUPT.vblank);
                    this.pulseDMGVBlankMode2STAT();
                }

                this.updateSTATInterruptLine();

                if (this.lcdLine === 144) {
                    this.completedFrameCount++;
                    this.onFrame?.(this.frame, this.completedFrameCount);
                }
            } else if (this.lcdLine < 144 && this.lcdLineCycles === mode3Start) {
                this.updateLCDWindowYTrigger();
                this.lcdMode3End = this.calculateLCDMode3EndCycle();
                this.initializeLCDPixelPipeline();
                this.updateSTATInterruptLine();
            } else if (this.lcdLine < 144 && this.lcdLineCycles === this.lcdMode3End) {
                if (this.hdmaActive && !this.cpuPaused) {
                    this.transferHDMABlock();
                }

                if (this.lcdWindowRenderedThisLine || this.lcdWX166MatchedThisLine) {
                    this.lcdWindowLine = (this.lcdWindowLine + 1) & 0xff;
                }

                this.fillLCDDesyncRemainder();

                this.updateSTATInterruptLine();
            }

            if (this.lcdLine < 144
                && this.lcdLineCycles >= 80
                && this.lcdLineCycles < this.lcdMode3End) {
                this.tickLCDPixelPipeline();
            }

            if (this.lcdWXJustChangedCycles > 0) {
                this.lcdWXJustChangedCycles--;
            }

            if (this.lcdCGBWXOldValueCycles > 0) {
                this.lcdCGBWXOldValueCycles--;
            }

            if (this.lcdTileSelectGlitchCycles > 0) {
                this.lcdTileSelectGlitchCycles--;
            }

            if (this.lcdWX166STATGlitchCycles > 0) {
                this.lcdWX166STATGlitchCycles--;

                if (this.lcdWX166STATGlitchCycles === 0) {
                    const stat = this.io[0x41] ?? 0;

                    if (((stat >> 3) & 1) !== 0) {
                        this.setSTATInterruptLine(true);
                        this.lcdWX166STATPulse = true;
                    }
                }
            }
        }
    }

    private initializeLCDPixelPipeline(): void {

        const lcdControl = this.io[0x40] ?? 0;
        const scroll = (this.io[0x43] ?? 0) & 0x07;
        const spriteHeight = ((lcdControl >> 2) & 1) !== 0 ? 16 : 8;
        const linePosition = this.lcdLine + 16;

        this.lcdPixelX = 0;
        this.lcdPPUPositionX = -16;
        this.lcdOutputX = 0;
        this.lcdPixelStartCycle = (this.lcdStarting ? 88 : 92) + scroll;
        this.lcdBackgroundFIFO.length = 0;
        this.lcdObjectFIFO.length = 0;
        this.lcdFetcherState = 0;
        this.lcdFetcherTileX = (this.io[0x43] ?? 0) >> 3;
        this.lcdFetcherWindow = false;
        this.lcdFetcherInitialPixel = 0;
        this.lcdPixelsToDiscard = scroll;
        this.lcdPixelStallCycles = 0;
        this.lcdWindowFetcherStall = false;
        this.lcdWindowFetchActive = false;
        this.lcdInsertBackgroundPixel = false;
        this.lcdDisableWindowPixelInsertionGlitch = false;
        this.lcdCGBWXGlitch = false;
        this.lcdLineHasFractionalScrolling = scroll !== 0;
        this.lcdWX166MatchedThisLine = false;
        this.lcdWX166STATGlitchCycles = 0;
        this.lcdWX166STATPulse = false;
        this.lcdWindowStartedThisLine = false;
        this.lcdWindowStartX = 0;
        this.lcdWindowSourceX = 0;
        this.lcdWindowRenderedThisLine = false;
        this.lcdLineSprites.length = 0;
        this.lcdFetchedSprites.clear();
        this.lcdConsideredSpriteTiles.clear();
        this.lcdFetchPenaltyAdjustment = 3;
        this.lcdObjectFetchSnapshot = undefined;

        const oamSearchBlocked = this.model === 'cgb'
            && this.cgbRevision !== 'e'
            && this.dmaActive
            && this.cpuPaused;

        for (let index = 0;
            !oamSearchBlocked && index < 40 && this.lcdLineSprites.length < 10;
            index++) {
            const offset = index * 4;
            const positionY = this.oam[offset] ?? 0;

            if (linePosition >= positionY && linePosition < positionY + spriteHeight) {
                this.lcdLineSprites.push(index);
            }
        }

        this.lcdLineSprites.sort((left, right) => {

            const leftX = this.oam[left * 4 + 1] ?? 0;
            const rightX = this.oam[right * 4 + 1] ?? 0;

            return leftX - rightX || left - right;
        });
    }

    private tickLCDPixelPipeline(): void {

        if (this.lcdPixelStallCycles > 0) {
            if (this.lcdWindowFetcherStall) {
                this.tickLCDBackgroundFetcher();
            }

            this.lcdPixelStallCycles--;

            if (this.lcdPixelStallCycles === 0) {
                this.lcdWindowFetcherStall = false;
                this.lcdObjectFetchSnapshot = undefined;
            }

            return;
        }

        if (this.lcdLineCycles >= this.lcdPixelStartCycle && this.lcdPPUPositionX === -16) {
            this.lcdPPUPositionX = -this.lcdPixelsToDiscard;
        }

        this.scheduleLCDBackgroundPixelInsertion();
        this.tickLCDBackgroundFetcher();

        if (this.lcdLineCycles < this.lcdPixelStartCycle) {
            return;
        }

        if (this.startLCDWindowFetch() || this.startLCDSpriteFetch()) {
            return;
        }

        const pixel = this.lcdInsertBackgroundPixel
            ? { color: 0, palette: 0, priority: false }
            : this.lcdBackgroundFIFO.shift();

        if (pixel === undefined) {
            return;
        }

        this.lcdInsertBackgroundPixel = false;
        this.lcdWindowFetchActive = false;

        if (this.lcdPixelsToDiscard > 0) {
            this.lcdPixelsToDiscard--;
            this.lcdPPUPositionX++;

            return;
        }

        if (this.lcdOutputX < this.frame.width) {
            this.renderLCDPixel(this.lcdOutputX, pixel, this.lcdObjectFIFO.shift());
            this.lcdOutputX++;
            this.lcdPixelX++;
            this.lcdPPUPositionX++;
        }
    }

    private tickLCDBackgroundFetcher(): void {

        const lcdControl = this.io[0x40] ?? 0;

        switch (this.lcdFetcherState) {
            case 0: {
                this.updateLCDCGBWXGlitch();

                if (((lcdControl >> 5) & 1) === 0 && this.lcdFetcherWindow) {
                    this.lcdFetcherWindow = false;
                    this.lcdFetcherTileX = (((this.io[0x43] ?? 0) + this.lcdPixelX) >> 3) & 0x1f;
                }

                const mapOffset = this.lcdFetcherWindow
                    ? (((lcdControl >> 6) & 1) !== 0 ? 0x1c00 : 0x1800)
                    : (((lcdControl >> 3) & 1) !== 0 ? 0x1c00 : 0x1800);

                this.lcdFetcherSourceY = this.lcdFetcherWindow
                    ? this.lcdWindowLine
                    : ((this.io[0x42] ?? 0) + this.lcdLine) & 0xff;
                this.lcdFetcherMapAddress = mapOffset
                    + ((this.lcdFetcherSourceY >> 3) & 0x1f) * 32
                    + (this.lcdFetcherTileX & 0x1f);
                this.lcdFetcherState++;
                break;
            }
            case 1:
                if (!this.lcdCGBWXGlitch) {
                    this.lcdFetcherTile = this.vram[this.lcdFetcherMapAddress] ?? 0;
                    this.lcdFetcherAttributes = this.cgbMode
                        ? (this.vram[0x2000 + this.lcdFetcherMapAddress] ?? 0)
                        : 0;
                }

                this.lcdFetcherState++;
                break;
            case 2: {
                this.updateLCDCGBWXGlitch();

                this.lcdFetcherLastTileSet = ((lcdControl >> 4) & 1) !== 0;
                this.lcdFetcherTileDataAddress = this.calculateLCDTileDataAddress(false);
                this.lcdFetcherState++;
                break;
            }
            case 3:
                this.lcdFetcherDataLow = this.lcdCGBWXGlitch
                    ? this.lcdFetcherDataHigh
                    : this.readLCDTileDataWithSelectGlitch(false);
                this.lcdFetcherState++;
                break;
            case 4: {
                this.updateLCDCGBWXGlitch();
                this.lcdFetcherLastTileSet = ((lcdControl >> 4) & 1) !== 0;
                this.lcdFetcherTileDataAddress = this.calculateLCDTileDataAddress(true);
                this.lcdFetcherState++;
                break;
            }
            case 5:
                this.lcdFetcherDataHigh = this.lcdCGBWXGlitch
                    ? this.lcdFetcherDataLow
                    : this.readLCDTileDataWithSelectGlitch(true);
                this.lcdFetcherState++;
                break;
            default:
                if (this.lcdBackgroundFIFO.length === 0) {
                    if (this.insertDisabledLCDWindowPixel()) {
                        break;
                    }

                    this.pushFetchedLCDTile();
                    this.lcdFetcherTileX = (this.lcdFetcherTileX + 1) & 0x1f;
                    this.lcdFetcherState = 0;
                }
                break;
        }
    }

    private calculateLCDTileDataAddress(highByte: boolean): number {

        const lcdControl = this.io[0x40] ?? 0;
        const sourceY = this.model === 'cgb'
            && (this.cgbRevision === 'd' || this.cgbRevision === 'e')
            ? this.lcdFetcherSourceY
            : (this.lcdFetcherWindow
                ? this.lcdWindowLine
                : ((this.io[0x42] ?? 0) + this.lcdLine) & 0xff);
        const signedTile = this.lcdFetcherTile < 0x80
            ? this.lcdFetcherTile
            : this.lcdFetcherTile - 0x100;
        const tileBankOffset = ((this.lcdFetcherAttributes >> 3) & 1) * 0x2000;
        const tileDataOffset = tileBankOffset + (((lcdControl >> 4) & 1) !== 0
            ? this.lcdFetcherTile * 16
            : 0x1000 + signedTile * 16);
        const tileY = ((this.lcdFetcherAttributes >> 6) & 1) !== 0
            ? 7 - (sourceY & 0x07)
            : sourceY & 0x07;

        return tileDataOffset + tileY * 2 + (highByte ? 1 : 0);
    }

    private readLCDTileDataWithSelectGlitch(highByte: boolean): number {

        let address = this.lcdFetcherTileDataAddress;

        if (this.model !== 'cgb' || this.lcdTileSelectGlitchCycles === 0) {
            const value = this.vram[address] ?? 0;

            if (this.model === 'cgb' && highByte) {
                this.lcdTileSelectGlitchData = value;
            }

            return value;
        }

        if (!this.lcdFetcherLastTileSet) {
            return this.lcdTileSelectGlitchData;
        }

        if (this.cgbRevision === 'd') {
            address &= ~0x1000;

            if (highByte) {
                address--;
            }

            const value = this.vram[address] ?? 0;

            this.lcdTileSelectGlitchData = value;

            return value;
        }

        const value = (this.lcdFetcherTile & 0x80) === 0
            ? this.lcdFetcherTile
            : (this.vram[address] ?? 0);

        this.lcdTileSelectGlitchData = this.vram[address] ?? 0;

        return value;
    }

    private updateLCDCGBWXGlitch(): void {

        const lcdControl = this.io[0x40] ?? 0;

        if (this.model !== 'cgb'
            || ((lcdControl >> 5) & 1) === 0
            || !this.lcdWindowYTriggered) {
            this.lcdCGBWXGlitch = false;

            return;
        }

        const windowX = this.lcdCGBWXOldValueCycles > 0
            ? this.lcdCGBWXOldValue
            : (this.io[0x4b] ?? 0);

        if (windowX === 0) {
            this.lcdCGBWXGlitch = (this.lcdPPUPositionX >= -16 && this.lcdPPUPositionX <= -8)
                || (this.lcdPPUPositionX === -7 && this.lcdLineHasFractionalScrolling);

            return;
        }

        this.lcdCGBWXGlitch = ((this.lcdPPUPositionX + 7 + (this.lcdWindowFetchActive ? 1 : 0)) & 0xff) === windowX;
    }

    private insertDisabledLCDWindowPixel(): boolean {

        const lcdControl = this.io[0x40] ?? 0;

        if (this.model !== 'dmg'
            || !this.lcdWindowYTriggered
            || ((lcdControl >> 5) & 1) !== 0
            || this.lcdDisableWindowPixelInsertionGlitch) {
            return false;
        }

        let logicalPosition = this.lcdPixelX + 7;

        if (logicalPosition > 167) {
            logicalPosition = 0;
        }

        if ((this.io[0x4b] ?? 0) !== logicalPosition) {
            return false;
        }

        this.lcdBackgroundFIFO.push({ color: 0, palette: 0, priority: false });

        return true;
    }

    private scheduleLCDBackgroundPixelInsertion(): void {

        const windowX = this.io[0x4b] ?? 0;

        if (windowX === this.lcdPixelX + 7
            && (this.model === 'dmg' || windowX === 0)
            && this.lcdWindowStartedThisLine
            && !this.lcdWindowFetchActive
            && this.lcdFetcherState === 0
            && this.lcdBackgroundFIFO.length === 8) {
            this.lcdInsertBackgroundPixel = true;
        }
    }

    private fillLCDDesyncRemainder(): void {

        if (this.lcdOutputX >= this.frame.width) {
            return;
        }

        const frameOffset = this.lcdLine * this.frame.width;
        const color = this.lcdOutputX === 0
            ? (this.framePalette[0] ?? 0xffffffff)
            : (this.frame.pixels[frameOffset + this.lcdOutputX - 1] ?? 0xffffffff);

        while (this.lcdOutputX < this.frame.width) {
            this.frame.pixels[frameOffset + this.lcdOutputX] = color;
            this.lcdOutputX++;
        }
    }

    private pushFetchedLCDTile(): void {

        const lcdControl = this.io[0x40] ?? 0;
        const backgroundEnabled = this.cgbMode || ((lcdControl >> 0) & 1) !== 0;

        for (let pixel = this.lcdFetcherInitialPixel; pixel < 8; pixel++) {
            const tileX = ((this.lcdFetcherAttributes >> 5) & 1) !== 0 ? 7 - pixel : pixel;
            const bit = 7 - tileX;
            const low = (this.lcdFetcherDataLow >> bit) & 1;
            const high = (this.lcdFetcherDataHigh >> bit) & 1;

            this.lcdBackgroundFIFO.push({
                color: backgroundEnabled ? low | (high << 1) : 0,
                palette: this.lcdFetcherAttributes & 0x07,
                priority: ((this.lcdFetcherAttributes >> 7) & 1) !== 0,
            });
        }

        this.lcdFetcherInitialPixel = 0;
    }

    private startLCDWindowFetch(): boolean {

        const lcdControl = this.io[0x40] ?? 0;
        const windowX = this.io[0x4b] ?? 0;
        const windowCanStart = (this.model === 'cgb' || ((lcdControl >> 0) & 1) !== 0)
            && this.lcdWindowYTriggered
            && ((lcdControl >> 5) & 1) !== 0
            && windowX < 166 + (this.model === 'cgb' ? 1 : 0);
        const normalMatch = windowX === this.lcdPixelX + 7;
        const dmgDesyncMatch = this.model === 'dmg'
            && windowX === this.lcdPixelX + 6
            && this.lcdWXJustChangedCycles === 0;

        if (this.model === 'dmg'
            && !this.lcdWindowStartedThisLine
            && this.lcdWindowYTriggered
            && ((lcdControl >> 5) & 1) !== 0
            && windowX === 166
            && normalMatch) {
            this.lcdWX166MatchedThisLine = true;

            return false;
        }

        if (this.lcdWindowStartedThisLine
            || !windowCanStart
            || (!normalMatch
                && !dmgDesyncMatch
                && (this.lcdPixelX !== 0 || windowX >= 7))) {
            return false;
        }

        const scroll = (this.io[0x43] ?? 0) & 0x07;
        const rawPenalty = 6 - (windowX === 0 && scroll !== 0 ? 1 : 0);
        const penalty = this.adjustLCDFetchPenalty(rawPenalty);

        this.lcdWindowStartedThisLine = true;
        this.lcdWindowStartX = this.lcdPixelX;
        this.lcdWindowSourceX = windowX < 7 ? 7 - windowX : 0;
        this.lcdBackgroundFIFO.length = 0;
        this.lcdFetcherState = 0;
        this.lcdFetcherTileX = 0;
        this.lcdFetcherWindow = true;
        this.lcdFetcherInitialPixel = this.lcdWindowSourceX;
        this.lcdWindowFetcherStall = true;
        this.lcdWindowFetchActive = true;

        if (dmgDesyncMatch && this.lcdOutputX > 0) {
            this.lcdOutputX--;
        }

        if (this.model === 'cgb' && windowX === 166) {
            this.lcdWX166STATGlitchCycles = 1;
        }

        for (let phase = 0; phase < Math.max(1, 7 - penalty); phase++) {
            this.tickLCDBackgroundFetcher();
        }

        this.lcdPixelStallCycles = Math.max(penalty - 1, 0);

        return true;
    }

    private startLCDSpriteFetch(): boolean {

        const lcdControl = this.io[0x40] ?? 0;

        if (((lcdControl >> 1) & 1) === 0 && this.model !== 'cgb') {
            return false;
        }

        for (const sprite of this.lcdLineSprites) {
            if (this.lcdFetchedSprites.has(sprite)) {
                continue;
            }

            const positionX = this.oam[sprite * 4 + 1] ?? 0;
            const triggerX = Math.max(positionX - 8, 0);

            if (positionX >= 168 || triggerX > this.lcdPixelX) {
                continue;
            }

            const pixelX = positionX - 8;
            const scroll = (this.io[0x43] ?? 0) & 0x07;
            const inWindow = this.lcdWindowStartedThisLine && pixelX >= this.lcdWindowStartX;
            const tilePosition = inWindow ? pixelX - this.lcdWindowStartX : pixelX + scroll;
            const tile = `${inWindow ? 'window' : 'background'}:${Math.floor(tilePosition / 8)}`;
            let penalty = 6;

            if (!this.lcdConsideredSpriteTiles.has(tile)) {
                const tileOffset = positionX === 0 ? 0 : tilePosition & 0x07;

                this.lcdConsideredSpriteTiles.add(tile);
                penalty += Math.max(5 - tileOffset, 0);
            }

            this.lcdObjectFetchSnapshot = [...this.lcdObjectFIFO];
            this.fetchLCDSpritePixels(sprite);
            this.lcdFetchedSprites.add(sprite);
            this.lcdPixelStallCycles = Math.max(this.adjustLCDFetchPenalty(penalty) - 1, 0);

            return true;
        }

        return false;
    }

    private abortLCDObjectFetch(): void {

        const snapshot = this.lcdObjectFetchSnapshot;

        if (snapshot === undefined) {
            return;
        }

        this.lcdObjectFIFO.length = 0;
        this.lcdObjectFIFO.push(...snapshot);
        this.lcdMode3End -= this.lcdPixelStallCycles;
        this.lcdPixelStallCycles = 0;
        this.lcdObjectFetchSnapshot = undefined;

        const consideredTiles = new Set(this.lcdConsideredSpriteTiles);
        const scroll = (this.io[0x43] ?? 0) & 0x07;

        for (const sprite of this.lcdLineSprites) {
            if (this.lcdFetchedSprites.has(sprite)) {
                continue;
            }

            const positionX = this.oam[sprite * 4 + 1] ?? 0;

            if (positionX >= 168) {
                continue;
            }

            const pixelX = positionX - 8;
            const inWindow = this.lcdWindowStartedThisLine && pixelX >= this.lcdWindowStartX;
            const tilePosition = inWindow ? pixelX - this.lcdWindowStartX : pixelX + scroll;
            const tile = `${inWindow ? 'window' : 'background'}:${Math.floor(tilePosition / 8)}`;
            let penalty = 6;

            if (!consideredTiles.has(tile)) {
                const tileOffset = positionX === 0 ? 0 : tilePosition & 0x07;

                consideredTiles.add(tile);
                penalty += Math.max(5 - tileOffset, 0);
            }

            this.lcdMode3End -= penalty;
            this.lcdFetchedSprites.add(sprite);
        }
    }

    private fetchLCDSpritePixels(sprite: number): void {

        const lcdControl = this.io[0x40] ?? 0;
        const spriteHeight = ((lcdControl >> 2) & 1) !== 0 ? 16 : 8;
        const offset = sprite * 4;
        const positionX = this.oam[offset + 1] ?? 0;
        const screenX = positionX - 8;
        const flags = this.oam[offset + 3] ?? 0;
        let sourceY = this.lcdLine + 16 - (this.oam[offset] ?? 0);

        if (((flags >> 6) & 1) !== 0) {
            sourceY = spriteHeight - 1 - sourceY;
        }

        let tile = this.oam[offset + 2] ?? 0;

        if (spriteHeight === 16) {
            tile = (tile & 0xfe) + (sourceY >> 3);
        }

        const tileBankOffset = this.cgbMode ? ((flags >> 3) & 1) * 0x2000 : 0;
        const tileRowAddress = tileBankOffset + tile * 16 + (sourceY & 0x07) * 2;
        const low = this.vram[tileRowAddress] ?? 0;
        const high = this.vram[tileRowAddress + 1] ?? 0;

        for (let pixel = 0; pixel < 8; pixel++) {
            const targetX = screenX + pixel;

            if (targetX < this.lcdPixelX || targetX >= this.frame.width) {
                continue;
            }

            const sourceX = ((flags >> 5) & 1) !== 0 ? 7 - pixel : pixel;
            const bit = 7 - sourceX;
            const color = ((low >> bit) & 1) | (((high >> bit) & 1) << 1);

            if (color === 0) {
                continue;
            }

            const fifoIndex = targetX - this.lcdPixelX;

            while (this.lcdObjectFIFO.length <= fifoIndex) {
                this.lcdObjectFIFO.push(undefined);
            }

            const existing = this.lcdObjectFIFO[fifoIndex];
            const candidateWins = existing === undefined
                || (this.model === 'cgb' && ((this.io[0x6c] ?? 0) & 1) === 0
                    ? sprite < existing.sprite
                    : positionX < existing.positionX
                        || (positionX === existing.positionX && sprite < existing.sprite));

            if (candidateWins) {
                this.lcdObjectFIFO[fifoIndex] = {
                    color,
                    palette: this.cgbMode ? flags & 0x07 : (flags >> 4) & 1,
                    behindBackground: ((flags >> 7) & 1) !== 0,
                    sprite,
                    positionX,
                };
            }
        }
    }

    private adjustLCDFetchPenalty(penalty: number): number {

        const adjusted = Math.max(penalty - this.lcdFetchPenaltyAdjustment, 0);

        this.lcdFetchPenaltyAdjustment = 0;

        return adjusted;
    }

    private renderLCDPixel(
        pixelX: number,
        tilePixel: LCDPixel,
        objectPixel: LCDObjectPixel | undefined,
    ): void {

        const lcdControl = this.io[0x40] ?? 0;
        const backgroundEnabled = this.cgbMode || ((lcdControl >> 0) & 1) !== 0;
        const backgroundPalette = this.io[0x47] ?? 0;
        const frameOffset = this.lcdLine * this.frame.width;
        const color = backgroundEnabled ? tilePixel.color : 0;

        if (this.lcdWindowStartedThisLine) {
            this.lcdWindowRenderedThisLine = true;
        }

        this.lcdBackgroundColors[pixelX] = color;
        this.lcdBackgroundPriority[pixelX] = tilePixel.priority ? 1 : 0;
        this.frame.pixels[frameOffset + pixelX] = backgroundEnabled
            ? (this.cgbMode
                ? this.mapCGBColor(this.cgbBackgroundPalettes, tilePixel.palette, color)
                : (this.cgbCompatibilityPalettes
                    ? this.mapCGBCompatibilityColor(this.cgbBackgroundPalettes, 0, backgroundPalette, color)
                    : this.mapDMGColor(backgroundPalette, color)))
            : (this.framePalette[0] ?? 0xffffffff);

        if (((lcdControl >> 1) & 1) !== 0 && objectPixel !== undefined) {
            this.renderLCDSpritePixel(lcdControl, frameOffset, pixelX, objectPixel);
        }
    }

    private renderLCDSpritePixel(
        lcdControl: number,
        frameOffset: number,
        pixelX: number,
        objectPixel: LCDObjectPixel,
    ): void {

        const backgroundPriorityEnabled = !this.cgbMode || ((lcdControl >> 0) & 1) !== 0;
        const backgroundWins = backgroundPriorityEnabled
            && this.lcdBackgroundColors[pixelX] !== 0
            && (objectPixel.behindBackground
                || (this.cgbMode && this.lcdBackgroundPriority[pixelX] !== 0));

        if (backgroundWins) {
            return;
        }

        const objectPalette = this.io[objectPixel.palette !== 0 ? 0x49 : 0x48] ?? 0;

        this.frame.pixels[frameOffset + pixelX] = this.cgbMode
            ? this.mapCGBColor(this.cgbObjectPalettes, objectPixel.palette, objectPixel.color)
            : (this.cgbCompatibilityPalettes
                ? this.mapCGBCompatibilityColor(
                    this.cgbObjectPalettes,
                    objectPixel.palette,
                    objectPalette,
                    objectPixel.color,
                )
                : this.mapDMGColor(objectPalette, objectPixel.color));
    }

    private mapDMGColor(palette: number, color: number): number {

        const shade = (palette >> (color * 2)) & 0x03;

        return this.framePalette[shade] ?? 0xff000000;
    }

    private mapCGBColor(palettes: Uint8Array, palette: number, color: number): number {

        const offset = palette * 8 + color * 2;
        const rgb555 = (palettes[offset] ?? 0) | ((palettes[offset + 1] ?? 0) << 8);
        const red5 = rgb555 & 0x1f;
        const green5 = (rgb555 >> 5) & 0x1f;
        const blue5 = (rgb555 >> 10) & 0x1f;
        const red = (red5 << 3) | (red5 >> 2);
        const green = (green5 << 3) | (green5 >> 2);
        const blue = (blue5 << 3) | (blue5 >> 2);

        return (0xff000000 | (red << 16) | (green << 8) | blue) >>> 0;
    }

    private mapCGBCompatibilityColor(
        palettes: Uint8Array,
        palette: number,
        dmgPalette: number,
        color: number,
    ): number {

        const shade = (dmgPalette >> (color * 2)) & 0x03;

        return this.mapCGBColor(palettes, palette, shade);
    }

    private initializeCGBRegisters(): void {

        if (this.model !== 'cgb') {
            return;
        }

        this.io[0x4d] = 0x7e;
        this.io[0x4c] = 0;
        this.io[0x4f] = 0xfe;
        this.io[0x51] = 0xff;
        this.io[0x52] = 0xff;
        this.io[0x53] = 0xff;
        this.io[0x54] = 0xff;
        this.io[0x55] = 0xff;
        this.io[0x68] = 0;
        this.io[0x6a] = 0;
        this.io[0x6c] = 0xfe;
        this.io[0x70] = 0xf9;
        this.io[0x72] = 0;
        this.io[0x73] = 0;
        this.io[0x75] = 0;
    }

    private setCGBMode(enabled: boolean): void {

        this.cgbMode = this.model === 'cgb' && enabled;

        if (this.cgbMode) {
            return;
        }

        this.cgbCompatibilityPalettes = this.model === 'cgb' && this.bootROMMapped;
    }

    private writeHDMAControl(value: number): void {

        if (this.hdmaActive) {
            if (((value >> 7) & 1) === 0) {
                this.hdmaActive = false;
            }

            return;
        }

        this.hdmaSource = ((this.io[0x51] ?? 0) << 8) | ((this.io[0x52] ?? 0) & 0xf0);
        this.hdmaDestination = ((this.io[0x53] ?? 0) & 0x1f) << 8 | ((this.io[0x54] ?? 0) & 0xf0);
        this.hdmaBlocksRemaining = (value & 0x7f) + 1;

        if (((value >> 7) & 1) !== 0 && this.lcdEnabled) {
            this.hdmaActive = true;

            if (!this.lcdStarting && this.lcdMode() === 0) {
                this.transferHDMABlock();
            }

            return;
        }

        this.hdmaActive = false;

        while (this.hdmaBlocksRemaining > 0) {
            this.transferHDMABlock();
        }
    }

    private transferHDMABlock(): void {

        for (let index = 0; index < 0x10; index++) {
            const source = (this.hdmaSource + index) & 0xffff;
            const destination = (this.hdmaDestination + index) & 0x1fff;

            this.vram[this.vramBank * 0x2000 + destination] = this.readMapped(source);
        }

        this.hdmaSource = (this.hdmaSource + 0x10) & 0xffff;
        this.hdmaDestination = (this.hdmaDestination + 0x10) & 0x1fff;
        this.hdmaBlocksRemaining--;
        this.hdmaCPUStallCycles += this.doubleSpeed ? 64 : 32;
        this.io[0x51] = this.hdmaSource >> 8;
        this.io[0x52] = this.hdmaSource & 0xf0;
        this.io[0x53] = (this.hdmaDestination >> 8) & 0x1f;
        this.io[0x54] = this.hdmaDestination & 0xf0;

        if (this.hdmaBlocksRemaining === 0) {
            this.hdmaActive = false;
        }
    }

    private writeMappedRAM(address: number, value: number): void {

        if (address < 0xd000) {
            this.wram[address - 0xc000] = value;
        } else {
            this.wram[this.wramBank * 0x1000 + address - 0xd000] = value;
        }
    }

    private readCPUVideoRAM(address: number): number {

        let offset = address - 0x8000;

        if (this.model === 'cgb'
            && !this.doubleSpeed
            && this.lcdLine < 144
            && this.lcdLineCycles === this.lcdMode3End) {
            if ((offset & 0x1000) !== 0) {
                if ((this.cgbRevision === '0'
                    || this.cgbRevision === 'a'
                    || this.cgbRevision === 'b'
                    || this.cgbRevision === 'c')
                    && (this.lcdFetcherTileDataAddress & 0x1000) === 0) {
                    return 0;
                }

                offset = this.lcdFetcherMapAddress;
            } else if ((this.lcdFetcherTileDataAddress & 0x1000) !== 0) {
                if (this.cgbRevision === 'e') {
                    const value = this.cpuVRAMBus;

                    this.cpuVRAMBus = this.vram[this.vramBank * 0x2000 + offset] ?? 0xff;

                    return value;
                }

                return this.cpuVRAMBus;
            } else {
                offset = this.lcdFetcherTileDataAddress;
            }
        }

        const value = this.vram[this.vramBank * 0x2000 + (offset & 0x1fff)] ?? 0xff;

        this.cpuVRAMBus = value;

        return value;
    }

    private tickCGBLine153(): void {

        const lateTiming = this.doubleSpeed
            || this.cgbRevision === 'd'
            || this.cgbRevision === 'e';

        if (this.lcdLineCycles === 2) {
            this.lcdLY = 153;
        } else if (this.lcdLineCycles === (lateTiming ? 8 : 6)) {
            this.lcdLY = 0;
        }

        if (this.lcdLineCycles === (lateTiming ? 4 : 6)
            || this.lcdLineCycles === 8
            || this.lcdLineCycles === 12) {
            this.updateLCDCoincidence();
            this.updateSTATInterruptLine();
        }
    }

    private updateLCDCoincidence(): void {

        if (this.model === 'cgb' && this.lcdLine === 153) {
            const lateTiming = this.doubleSpeed
                || this.cgbRevision === 'd'
                || this.cgbRevision === 'e';
            let comparison: number | undefined;

            if (this.lcdLineCycles >= 12) {
                comparison = 0;
            } else if (this.lcdLineCycles >= (lateTiming ? 4 : 6)
                && (lateTiming || this.lcdLineCycles < 8)) {
                comparison = 153;
            }

            if (comparison === undefined && lateTiming) {
                return;
            }

            this.lcdCoincidence = comparison === this.io[0x45];

            return;
        }

        this.lcdCoincidence = this.lcdLine === this.io[0x45];
    }

    private updateLCDWindowYTrigger(): void {

        const lcdControl = this.io[0x40] ?? 0;

        if (((lcdControl >> 5) & 1) !== 0 && this.lcdLine === this.io[0x4a]) {
            this.lcdWindowYTriggered = true;
        }
    }

    private updateSTATInterruptLine(): void {

        const stat = this.io[0x41] ?? 0;
        const mode = this.lcdMode();
        const mode0 = this.lcdEnabled && mode === 0 && ((stat >> 3) & 1) !== 0;
        const mode1 = this.lcdEnabled && mode === 1 && ((stat >> 4) & 1) !== 0;
        const mode2 = this.lcdEnabled && mode === 2 && ((stat >> 5) & 1) !== 0;
        const coincidence = this.lcdCoincidence && ((stat >> 6) & 1) !== 0;

        this.setSTATInterruptLine(mode0 || mode1 || mode2 || coincidence);
    }

    private pulseDMGVBlankMode2STAT(): void {

        const stat = this.io[0x41] ?? 0;

        if (((stat >> 5) & 1) !== 0) {
            this.setSTATInterruptLine(true);
        }
    }

    private setSTATInterruptLine(signal: boolean): void {

        if (signal && !this.statInterruptLine) {
            this.requestInterrupt(GAME_BOY_INTERRUPT.lcdStat);
        }

        this.statInterruptLine = signal;
    }

    private cpuCanAccessDuringDMA(address: number): boolean {

        return (address >= 0xff80 && address < 0xffff) || address === 0xff46;
    }

    private isUnusedIOAddress(address: number): boolean {

        if (address === 0xff03
            || (address >= 0xff08 && address <= 0xff0e)
            || address === 0xff15
            || address === 0xff1f
            || (address >= 0xff27 && address <= 0xff2f)) {
            return true;
        }

        if (this.model === 'dmg') {
            return address >= 0xff4c && address < 0xff80 && address !== 0xff50;
        }

        return address === 0xff4e
            || (address >= 0xff57 && address <= 0xff67)
            || (address >= 0xff6d && address <= 0xff6f)
            || address === 0xff71
            || (address >= 0xff78 && address <= 0xff7f);
    }

    private readUnusableOAM(address: number): number {

        if (this.model !== 'cgb') {
            return 0xff;
        }

        const offset = address & 0xff;

        if (this.cgbRevision === 'e') {
            return (offset & 0xf0) | (offset >> 4);
        }

        const mappedOffset = this.cgbRevision === 'd'
            ? (offset >= 0xc0 ? offset | 0xf0 : offset)
            : offset & ~0x18;

        return this.extraOAM[mappedOffset - 0xa0] ?? 0xff;
    }

    private writeUnusableOAM(address: number, value: number): void {

        if (this.model !== 'cgb' || this.cgbRevision === 'e') {
            return;
        }

        const offset = address & 0xff;
        const mappedOffset = this.cgbRevision === 'd'
            ? (offset >= 0xc0 ? offset | 0xf0 : offset)
            : offset & ~0x18;

        this.extraOAM[mappedOffset - 0xa0] = value;
    }

    private cpuCanReadPPUMemory(address: number): boolean {

        const mode = this.lcdMode();

        if (address >= 0x8000 && address < 0xa000) {
            if (this.model === 'dmg' && mode === 2 && this.lcdLineCycles >= 76) {
                return false;
            }

            return mode !== 3;
        }

        if (address >= 0xfe00 && address < 0xff00) {
            if (this.lcdLY !== this.lcdLine) {
                return false;
            }

            if (this.model === 'cgb'
                && (this.cgbRevision === 'd' || this.cgbRevision === 'e')
                && this.lcdLine < 144
                && this.lcdLineCycles === this.lcdMode3End) {
                return false;
            }

            return mode !== 2 && mode !== 3;
        }

        return true;
    }

    private cpuCanWritePPUMemory(address: number): boolean {

        const mode = this.lcdMode();

        if (address >= 0x8000 && address < 0xa000) {
            return mode !== 3;
        }

        if (address >= 0xfe00 && address < 0xff00) {
            if (mode === 3) {
                return false;
            }

            if (mode === 2) {
                return this.model === 'dmg'
                    && this.lcdLineCycles >= 76;
            }
        }

        return true;
    }

    private lcdMode(): number {

        if (!this.lcdEnabled) {
            return 0;
        }

        if (this.lcdLine >= 144) {
            return 1;
        }

        if (this.lcdLineCycles < (this.lcdStarting ? 76 : 80)) {
            return this.lcdStarting ? 0 : 2;
        }

        if (this.lcdLineCycles < this.lcdMode3End) {
            return 3;
        }

        return 0;
    }

    private calculateLCDMode3EndCycle(): number {

        const lcdControl = this.io[0x40] ?? 0;
        const scroll = (this.io[0x43] ?? 0) & 0x07;
        const windowX = this.io[0x4b] ?? 0;
        const windowStart = windowX - 7;
        const windowActive = this.lcdWindowYTriggered
            && ((lcdControl >> 5) & 1) !== 0
            && windowX < 166 + (this.model === 'cgb' ? 1 : 0);
        let endCycle = (this.lcdStarting ? 248 : 252) + scroll;
        const spriteHeight = ((lcdControl >> 2) & 1) !== 0 ? 16 : 8;
        const linePosition = this.lcdLine + 16;
        const consideredTiles = new Set<string>();
        const selectedSpritePositions: number[] = [];

        for (let index = 0;
            ((lcdControl >> 1) & 1) !== 0 && index < 40 && selectedSpritePositions.length < 10;
            index++) {
            const offset = index * 4;
            const positionY = this.oam[offset] ?? 0;

            if (linePosition < positionY || linePosition >= positionY + spriteHeight) {
                continue;
            }

            selectedSpritePositions.push(this.oam[offset + 1] ?? 0);
        }

        selectedSpritePositions.sort((left, right) => left - right);

        for (const positionX of selectedSpritePositions) {

            if (positionX >= 168) {
                continue;
            }

            endCycle += 6;

            const pixelX = positionX - 8;
            const inWindow = windowActive && pixelX >= windowStart;
            const tilePosition = inWindow ? pixelX - windowStart : pixelX + scroll;
            const tile = `${inWindow ? 'window' : 'background'}:${Math.floor(tilePosition / 8)}`;

            if (!consideredTiles.has(tile)) {
                const tileOffset = positionX === 0 ? 0 : tilePosition & 0x07;

                consideredTiles.add(tile);
                endCycle += Math.max(5 - tileOffset, 0);
            }
        }

        if (selectedSpritePositions.length !== 0 || windowActive) {
            endCycle -= 3;
        }

        if (windowActive) {
            endCycle += 6;

            if (windowX === 0 && scroll !== 0) {
                endCycle--;
            }
        }

        return endCycle;
    }

    private tickOAMDMA(cycles: number): void {

        for (let cycle = 0; cycle < cycles && this.dmaActive; cycle++) {
            if (this.dmaTransferring) {
                this.dmaCyclesUntilByte--;

                if (this.dmaCyclesUntilByte === 0) {
                    let sourceAddress = (this.dmaSource + this.dmaIndex) & 0xffff;

                    if (sourceAddress >= 0xe000) {
                        sourceAddress &= ~0x2000;
                    }

                    this.oam[this.dmaIndex] = this.readMapped(sourceAddress);
                    this.dmaIndex++;

                    if (this.dmaIndex === this.oam.length) {
                        this.dmaTransferring = false;

                        if (this.dmaStartCycles === 0) {
                            this.dmaActive = false;
                        }
                    } else {
                        this.dmaCyclesUntilByte = 4;
                    }
                }
            }

            if (this.dmaStartCycles > 0) {
                this.dmaStartCycles--;

                if (this.dmaStartCycles === 0) {
                    this.dmaSource = this.dmaPendingSource;
                    this.dmaIndex = 0;
                    this.dmaCyclesUntilByte = 4;
                    this.dmaTransferring = true;
                }
            }
        }
    }
}
