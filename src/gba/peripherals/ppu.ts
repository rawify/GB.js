import type { FrameBuffer } from '../../types.js';
import type { GBAClockedComponent } from '../scheduler/scheduler.js';
import { GBA_INTERRUPT, type GBAInterruptController } from './interrupts.js';

export const GBA_CYCLES_PER_SCANLINE = 1232;
export const GBA_VISIBLE_PIXEL_CYCLES = 960;
export const GBA_HDRAW_CYCLES = 1007;
export const GBA_VISIBLE_SCANLINES = 160;
export const GBA_TOTAL_SCANLINES = 228;
export const GBA_DISPCNT_WRITABLE_MASK = 0xfff7;
export const GBA_DISPSTAT_WRITABLE_MASK = 0xff38;
export const GBA_TEXT_BGCNT_WRITABLE_MASK = 0xdfcf;
export const GBA_BG2CNT_WRITABLE_MASK = 0xffcf;

const DISPSTAT_VBLANK = 0x0001;
const DISPSTAT_HBLANK = 0x0002;
const DISPSTAT_VCOUNT = 0x0004;
const DISPSTAT_VBLANK_IRQ = 0x0008;
const DISPSTAT_HBLANK_IRQ = 0x0010;
const DISPSTAT_VCOUNT_IRQ = 0x0020;
const DISPCNT_HBLANK_INTERVAL_FREE = 0x0020;
const DISPCNT_FORCED_BLANK = 0x0080;
const DISPCNT_BG0_ENABLE = 0x0100;
const DISPCNT_BG2_ENABLE = 0x0400;
const DISPCNT_OBJECT_ENABLE = 0x1000;
const DISPCNT_WINDOW0_ENABLE = 0x2000;
const DISPCNT_WINDOW1_ENABLE = 0x4000;
const DISPCNT_OBJECT_WINDOW_ENABLE = 0x8000;
const BGCNT_OVERFLOW_WRAP = 0x2000;
const OBJECT_DIMENSIONS = [
    [[8, 8], [16, 16], [32, 32], [64, 64]],
    [[16, 8], [32, 8], [32, 16], [64, 32]],
    [[8, 16], [8, 32], [16, 32], [32, 64]],
] as const;

export interface GBAPPUDMA {
    trigger(trigger: 'vblank' | 'hblank'): void;
}

export interface GBAPPUVideoMemory {
    readonly oam: Uint8Array;
    readonly paletteRAM: Uint8Array;
    readonly vram: Uint8Array;
}

export type GBAPPUVideoBus = 'palette' | 'background-vram' | 'object-vram' | 'oam';

export class GBAPPU implements GBAClockedComponent {

    readonly frame: FrameBuffer = {
        width: 240,
        height: 160,
        pixels: new Uint32Array(240 * 160).fill(0xffffffff),
    };
    private readonly scanlineTopLayer = new Uint8Array(240);
    private readonly scanlineTopRank = new Uint16Array(240);
    private readonly scanlineTopSemiTransparent = new Uint8Array(240);
    private readonly scanlineSecondColor = new Uint32Array(240);
    private readonly scanlineSecondLayer = new Uint8Array(240);
    private readonly scanlineSecondRank = new Uint16Array(240);
    private readonly scanlineWindowMask = new Uint8Array(240);
    private readonly scanlineObjectWindow = new Uint8Array(240);
    private readonly objectOAMSlots = new Uint8Array(GBA_CYCLES_PER_SCANLINE);
    private readonly objectVRAMSlots = new Uint8Array(GBA_CYCLES_PER_SCANLINE);
    private readonly interrupts: GBAInterruptController;
    private readonly dma: GBAPPUDMA;
    private readonly videoMemory: GBAPPUVideoMemory;
    private displayControl = 0;
    private displayStatus = 0;
    private readonly backgroundControl = new Uint16Array(4);
    private readonly backgroundHorizontalOffset = new Uint16Array(4);
    private readonly backgroundVerticalOffset = new Uint16Array(4);
    private readonly backgroundAffineMatrix = [
        new Uint16Array([0x0100, 0, 0, 0x0100]),
        new Uint16Array([0x0100, 0, 0, 0x0100]),
    ];
    private readonly backgroundAffineReference = [new Uint32Array(2), new Uint32Array(2)];
    private readonly backgroundAffineInternalX = new Int32Array(2);
    private readonly backgroundAffineInternalY = new Int32Array(2);
    private readonly windowHorizontal = new Uint16Array(2);
    private readonly windowVertical = new Uint16Array(2);
    private readonly windowControl = new Uint8Array(4);
    private mosaic = 0;
    private blendControl = 0;
    private blendAlpha = 0;
    private blendBrightness = 0;
    private scanline = 0;
    private scanlineCycles = 0;
    private objectScheduleSourceLine = -1;
    private renderingEnabled = true;

    constructor(
        interrupts: GBAInterruptController,
        dma: GBAPPUDMA,
        videoMemory: GBAPPUVideoMemory = {
            oam: new Uint8Array(0x400),
            paletteRAM: new Uint8Array(0x400),
            vram: new Uint8Array(0x18000),
        },
    ) {

        this.interrupts = interrupts;
        this.dma = dma;
        this.videoMemory = videoMemory;
    }

    get verticalCount(): number {

        return this.scanline;
    }

    get cyclesIntoScanline(): number {

        return this.scanlineCycles;
    }

    get displayMode(): number {

        return this.displayControl & 0x07;
    }

    get frameSelect(): number {

        return (this.displayControl >>> 4) & 0x01;
    }

    get hblankIntervalFree(): boolean {

        return (this.displayControl & DISPCNT_HBLANK_INTERVAL_FREE) !== 0;
    }

    setRenderingEnabled(enabled: boolean): void {

        this.renderingEnabled = enabled;
    }

    get objectMapping1D(): boolean {

        return (this.displayControl & 0x0040) !== 0;
    }

    get forcedBlank(): boolean {

        return (this.displayControl & DISPCNT_FORCED_BLANK) !== 0;
    }

    readDisplayControl(): number {

        return this.displayControl;
    }

    writeDisplayControl(value: number): void {

        this.displayControl = value & GBA_DISPCNT_WRITABLE_MASK;
    }

    cpuVideoAccessCycles(
        bus: GBAPPUVideoBus,
        width: 8 | 16 | 32,
        cycleOffset = 0,
    ): number {

        const transfers = bus === 'oam' ? 1 : width === 32 ? 2 : 1;
        let cycles = 0;

        for (let transfer = 0; transfer < transfers; transfer++) {
            do {
                cycles++;
            } while (this.videoBusBusy(bus, cycleOffset + cycles));
        }

        return cycles;
    }

    canAccessOAM(): boolean {

        return this.forcedBlank
            || this.inVBlank()
            || (this.scanlineCycles >= GBA_HDRAW_CYCLES
                && this.hblankIntervalFree);
    }

    readDisplayStatus(): number {

        let status = this.displayStatus;

        if (this.inVBlank()) {
            status |= DISPSTAT_VBLANK;
        }

        if (this.scanlineCycles >= GBA_HDRAW_CYCLES) {
            status |= DISPSTAT_HBLANK;
        }

        if (this.vcountMatches()) {
            status |= DISPSTAT_VCOUNT;
        }

        return status;
    }

    writeDisplayStatus(value: number): void {

        this.displayStatus = value & GBA_DISPSTAT_WRITABLE_MASK;
    }

    readBackground0Control(): number {

        return this.readBackgroundControl(0);
    }

    writeBackground0Control(value: number): void {

        this.writeBackgroundControl(0, value);
    }

    readBackground0Offset(vertical: boolean): number {

        return this.readBackgroundOffset(0, vertical);
    }

    writeBackground0Offset(vertical: boolean, value: number): void {

        this.writeBackgroundOffset(0, vertical, value);
    }

    readBackgroundControl(index: number): number {

        return this.backgroundControl[this.backgroundIndex(index)] ?? 0;
    }

    writeBackgroundControl(index: number, value: number): void {

        const background = this.backgroundIndex(index);
        const mask = background < 2 ? GBA_TEXT_BGCNT_WRITABLE_MASK : GBA_BG2CNT_WRITABLE_MASK;

        this.backgroundControl[background] = value & mask;
    }

    readBackgroundOffset(index: number, vertical: boolean): number {

        const background = this.backgroundIndex(index);

        return (vertical ? this.backgroundVerticalOffset : this.backgroundHorizontalOffset)[background] ?? 0;
    }

    writeBackgroundOffset(index: number, vertical: boolean, value: number): void {

        const background = this.backgroundIndex(index);

        (vertical ? this.backgroundVerticalOffset : this.backgroundHorizontalOffset)[background] = value & 0x01ff;
    }

    readBackground2Control(): number {

        return this.readBackgroundControl(2);
    }

    writeBackground2Control(value: number): void {

        this.writeBackgroundControl(2, value);
    }

    readBackground2Parameter(index: number): number {

        return this.readBackgroundAffineParameter(2, index);
    }

    writeBackground2Parameter(index: number, value: number): void {

        this.writeBackgroundAffineParameter(2, index, value);
    }

    readBackground2Reference(index: number): number {

        return this.readBackgroundAffineReference(2, index);
    }

    writeBackground2Reference(index: number, value: number, reload = true): void {

        this.writeBackgroundAffineReference(2, index, value, reload);
    }

    readBackgroundAffineParameter(background: number, index: number): number {

        const affine = this.affineBackgroundIndex(background);

        return this.backgroundAffineMatrix[affine]?.[this.affineParameterIndex(index)] ?? 0;
    }

    writeBackgroundAffineParameter(background: number, index: number, value: number): void {

        const affine = this.affineBackgroundIndex(background);
        const matrix = this.backgroundAffineMatrix[affine];

        if (matrix !== undefined) {
            matrix[this.affineParameterIndex(index)] = value & 0xffff;
        }
    }

    readBackgroundAffineReference(background: number, index: number): number {

        const affine = this.affineBackgroundIndex(background);

        return this.backgroundAffineReference[affine]?.[this.referenceIndex(index)] ?? 0;
    }

    writeBackgroundAffineReference(
        background: number,
        index: number,
        value: number,
        reload = true,
    ): void {

        const affine = this.affineBackgroundIndex(background);
        const referenceIndex = this.referenceIndex(index);
        const reference = value & 0x0fffffff;

        this.backgroundAffineReference[affine]?.set([reference], referenceIndex);

        if (reload) {
            if (referenceIndex === 0) {
                this.backgroundAffineInternalX[affine] = this.signExtend(reference, 28);
            } else {
                this.backgroundAffineInternalY[affine] = this.signExtend(reference, 28);
            }
        }
    }

    readWindowBounds(index: number, vertical: boolean): number {

        const window = this.windowIndex(index);

        return (vertical ? this.windowVertical : this.windowHorizontal)[window] ?? 0;
    }

    writeWindowBounds(index: number, vertical: boolean, value: number): void {

        const window = this.windowIndex(index);

        (vertical ? this.windowVertical : this.windowHorizontal)[window] = value & 0xffff;
    }

    readWindowControl(index: number): number {

        return this.windowControl[this.windowControlIndex(index)] ?? 0;
    }

    writeWindowControl(index: number, value: number): void {

        this.windowControl[this.windowControlIndex(index)] = value & 0x3f;
    }

    readMosaic(): number {

        return this.mosaic;
    }

    writeMosaic(value: number): void {

        this.mosaic = value & 0xffff;
    }

    readBlendRegister(index: number): number {

        switch (index) {
            case 0:
                return this.blendControl;
            case 1:
                return this.blendAlpha;
            case 2:
                return this.blendBrightness;
            default:
                throw new RangeError(`GBA blend register index ${index} is outside 0-2.`);
        }
    }

    writeBlendRegister(index: number, value: number): void {

        switch (index) {
            case 0:
                this.blendControl = value & 0x3fff;
                return;
            case 1:
                this.blendAlpha = value & 0x1f1f;
                return;
            case 2:
                this.blendBrightness = value & 0x001f;
                return;
            default:
                throw new RangeError(`GBA blend register index ${index} is outside 0-2.`);
        }
    }

    cyclesUntilNextEvent(maximumCycles: number): number | undefined {

        let nextBoundary = this.scanlineCycles < GBA_HDRAW_CYCLES
            ? GBA_HDRAW_CYCLES
            : GBA_CYCLES_PER_SCANLINE;

        if (this.scanlineCycles < 40) {
            nextBoundary = 40;
        }

        const cycles = nextBoundary - this.scanlineCycles;

        return cycles <= maximumCycles ? cycles : undefined;
    }

    tick(cycles: number): void {

        let remainingCycles = cycles;

        while (remainingCycles > 0) {
            let nextBoundary = this.scanlineCycles < GBA_HDRAW_CYCLES
                ? GBA_HDRAW_CYCLES
                : GBA_CYCLES_PER_SCANLINE;

            if (this.scanlineCycles < 40) {
                nextBoundary = 40;
            }

            const step = Math.min(remainingCycles, nextBoundary - this.scanlineCycles);

            this.scanlineCycles += step;
            remainingCycles -= step;

            if (this.scanlineCycles === 40) {
                this.prepareObjectSchedule(this.scanline);
            } else if (this.scanlineCycles === GBA_HDRAW_CYCLES) {
                this.enterHBlank();
            } else if (this.scanlineCycles === GBA_CYCLES_PER_SCANLINE) {
                this.beginScanline();
            }
        }
    }

    reset(): void {

        this.displayControl = 0;
        this.displayStatus = 0;
        this.backgroundControl.fill(0);
        this.backgroundHorizontalOffset.fill(0);
        this.backgroundVerticalOffset.fill(0);
        this.windowHorizontal.fill(0);
        this.windowVertical.fill(0);
        this.windowControl.fill(0);
        this.mosaic = 0;
        this.blendControl = 0;
        this.blendAlpha = 0;
        this.blendBrightness = 0;
        for (let affine = 0; affine < 2; affine++) {
            this.backgroundAffineMatrix[affine]?.set([0x0100, 0, 0, 0x0100]);
            this.backgroundAffineReference[affine]?.fill(0);
            this.backgroundAffineInternalX[affine] = 0;
            this.backgroundAffineInternalY[affine] = 0;
        }
        this.scanline = 0;
        this.scanlineCycles = 0;
        this.objectOAMSlots.fill(0);
        this.objectVRAMSlots.fill(0);
        this.objectScheduleSourceLine = -1;
        this.renderingEnabled = true;
        this.frame.pixels.fill(0xffffffff);
    }

    private enterHBlank(): void {

        if (this.renderingEnabled && this.scanline < GBA_VISIBLE_SCANLINES) {
            this.renderScanline(this.scanline);
        }

        this.dma.trigger('hblank');

        if ((this.displayStatus & DISPSTAT_HBLANK_IRQ) !== 0) {
            this.interrupts.request(GBA_INTERRUPT.hblank);
        }
    }

    private beginScanline(): void {

        this.scanlineCycles = 0;
        this.scanline = (this.scanline + 1) % GBA_TOTAL_SCANLINES;

        for (let background = 2; background <= 3; background++) {
            const affine = background - 2;

            if (this.scanline === 0) {
                this.backgroundAffineInternalX[affine] = this.signExtend(
                    this.backgroundAffineReference[affine]?.[0] ?? 0,
                    28,
                );
                this.backgroundAffineInternalY[affine] = this.signExtend(
                    this.backgroundAffineReference[affine]?.[1] ?? 0,
                    28,
                );
            } else {
                this.backgroundAffineInternalX[affine] = (this.backgroundAffineInternalX[affine] ?? 0)
                    + this.signedParameter(background, 1);
                this.backgroundAffineInternalY[affine] = (this.backgroundAffineInternalY[affine] ?? 0)
                    + this.signedParameter(background, 3);
            }
        }

        if (this.scanline === GBA_VISIBLE_SCANLINES) {
            this.dma.trigger('vblank');

            if ((this.displayStatus & DISPSTAT_VBLANK_IRQ) !== 0) {
                this.interrupts.request(GBA_INTERRUPT.vblank);
            }
        }

        if (this.vcountMatches() && (this.displayStatus & DISPSTAT_VCOUNT_IRQ) !== 0) {
            this.interrupts.request(GBA_INTERRUPT.vcount);
        }
    }

    private inVBlank(): boolean {

        return this.scanline >= GBA_VISIBLE_SCANLINES && this.scanline < GBA_TOTAL_SCANLINES - 1;
    }

    private vcountMatches(): boolean {

        return this.scanline === (this.displayStatus >>> 8);
    }

    private videoBusBusy(bus: GBAPPUVideoBus, cycleOffset: number): boolean {

        const absoluteCycle = this.scanlineCycles + cycleOffset;
        const scanlineOffset = Math.floor(absoluteCycle / GBA_CYCLES_PER_SCANLINE);
        const scanline = (this.scanline + scanlineOffset) % GBA_TOTAL_SCANLINES;
        const cycle = absoluteCycle % GBA_CYCLES_PER_SCANLINE;

        if (scanline >= GBA_VISIBLE_SCANLINES || this.forcedBlank) {
            return false;
        }

        if (bus === 'background-vram') {
            return this.backgroundVRAMBusy(cycle);
        }

        if (bus === 'object-vram' || bus === 'oam') {
            return this.objectBusBusy(bus, scanline, cycle);
        }

        if (bus === 'palette') {
            return this.paletteRAMBusy(cycle);
        }

        return false;
    }

    private objectBusBusy(
        bus: 'object-vram' | 'oam',
        scanline: number,
        cycle: number,
    ): boolean {

        const sourceLine = cycle >= 40
            ? scanline
            : (scanline + GBA_TOTAL_SCANLINES - 1) % GBA_TOTAL_SCANLINES;

        if (this.objectScheduleSourceLine !== sourceLine) {
            this.prepareObjectSchedule(sourceLine);
        }

        const objectCycle = cycle >= 40 ? cycle - 40 : cycle + 1192;
        const slots = bus === 'oam' ? this.objectOAMSlots : this.objectVRAMSlots;

        return (slots[objectCycle] ?? 0) !== 0;
    }

    private prepareObjectSchedule(sourceLine: number): void {

        this.objectOAMSlots.fill(0);
        this.objectVRAMSlots.fill(0);
        this.objectScheduleSourceLine = sourceLine;

        const targetLine = (sourceLine + 1) % GBA_TOTAL_SCANLINES;
        const objectLayers = DISPCNT_OBJECT_ENABLE | DISPCNT_OBJECT_WINDOW_ENABLE;

        if (targetLine >= GBA_VISIBLE_SCANLINES
            || (this.displayControl & objectLayers) === 0) {
            return;
        }

        const cycleLimit = this.hblankIntervalFree
            ? GBA_HDRAW_CYCLES - 40
            : GBA_CYCLES_PER_SCANLINE;
        let object = 0;
        let fetchStep = 0;
        let wait = 0;
        let pendingWait = 0;
        let delayWait = false;
        let drawingPixels = 0;
        let drawingAffine = false;
        let pendingDrawingPixels = 0;
        let pendingAffine = false;
        const submit = (): void => {

            drawingPixels = pendingDrawingPixels;
            drawingAffine = pendingAffine;
            object++;
            fetchStep = 0;
            wait = pendingWait;
            delayWait = true;
        };

        for (let cycle = 0; cycle < cycleLimit; cycle += 2) {
            if (drawingPixels > 0 && !(drawingAffine && delayWait)) {
                this.objectVRAMSlots[cycle] = 1;
                drawingPixels -= drawingAffine ? 1 : 2;
            }

            if (wait > 0 && !delayWait) {
                wait--;
                continue;
            }

            delayWait = false;

            if (object >= 128) {
                continue;
            }

            const oamOffset = object * 8;

            if (fetchStep === 0) {
                this.objectOAMSlots[cycle] = 1;

                const attribute0 = this.readOAMHalfword(oamOffset);
                const attribute1 = this.readOAMHalfword(oamOffset + 2);
                const affine = (attribute0 & 0x0100) !== 0;
                const disabled = !affine && (attribute0 & 0x0200) !== 0;
                const objectMode = (attribute0 >>> 10) & 0x03;
                const shape = attribute0 >>> 14;
                const size = attribute1 >>> 14;
                const dimensions = OBJECT_DIMENSIONS[shape]?.[size];

                if (disabled || objectMode === 3 || dimensions === undefined) {
                    object++;
                    continue;
                }

                const [width, height] = dimensions;
                const doubleSize = affine && (attribute0 & 0x0200) !== 0;
                const fieldWidth = doubleSize ? width * 2 : width;
                const fieldHeight = doubleSize ? height * 2 : height;
                const positionY = attribute0 & 0xff;
                const intersects = ((targetLine - positionY) & 0xff) < fieldHeight;
                let positionX = attribute1 & 0x01ff;

                if (!intersects) {
                    object++;
                    continue;
                }

                if (positionX >= 240) {
                    positionX -= 512;
                }

                const clippedPixels = positionX < 0
                    ? (-positionX) & (affine ? ~0 : ~1)
                    : 0;

                pendingDrawingPixels = fieldWidth - clippedPixels;

                if (pendingDrawingPixels <= 0) {
                    object++;
                    continue;
                }

                pendingAffine = affine;
                pendingWait = affine
                    ? fieldWidth - 1 - clippedPixels
                    : fieldWidth / 2 - 2 - clippedPixels / 2;
                fetchStep = 1;
                continue;
            }

            this.objectOAMSlots[cycle] = 1;

            if (fetchStep === 1) {
                if (pendingAffine) {
                    fetchStep = 2;
                } else {
                    submit();
                }
                continue;
            }

            fetchStep++;

            if (fetchStep === 6) {
                submit();
            }
        }
    }

    private backgroundVRAMBusy(cycle: number): boolean {

        if (cycle < 1 || cycle >= GBA_HDRAW_CYCLES) {
            return false;
        }

        const mode = this.displayMode;

        if (mode <= 1) {
            const lastTextBackground = mode === 0 ? 3 : 1;

            for (let background = 0; background <= lastTextBackground; background++) {
                if ((this.displayControl & (DISPCNT_BG0_ENABLE << background)) !== 0
                    && this.textBackgroundVRAMBusy(background, cycle)) {
                    return true;
                }
            }
        }

        if (mode === 1 && (this.displayControl & DISPCNT_BG2_ENABLE) !== 0) {
            return cycle >= 32 && (cycle & 3) >= 2;
        }

        if (mode === 2) {
            const background2Busy = (this.displayControl & DISPCNT_BG2_ENABLE) !== 0
                && (cycle & 3) >= 2;
            const background3Busy = (this.displayControl & (DISPCNT_BG2_ENABLE << 1)) !== 0
                && (cycle & 3) < 2;

            return cycle >= 32 && (background2Busy || background3Busy);
        }

        return mode >= 3
            && mode <= 5
            && (this.displayControl & DISPCNT_BG2_ENABLE) !== 0
            && cycle >= 32
            && (cycle & 3) === 3;
    }

    private textBackgroundVRAMBusy(background: number, cycle: number): boolean {

        const scroll = (this.backgroundHorizontalOffset[background] ?? 0) & 0x07;
        const firstMapFetch = 32 - scroll * 4 + background;
        const tileCycle = (cycle - firstMapFetch) % 32;

        if (cycle < firstMapFetch) {
            return false;
        }

        if (tileCycle === 0) {
            return true;
        }

        const color256 = ((this.backgroundControl[background] ?? 0) & 0x0080) !== 0;

        return color256
            ? tileCycle === 4 || tileCycle === 12 || tileCycle === 20 || tileCycle === 28
            : tileCycle === 4 || tileCycle === 20;
    }

    private paletteRAMBusy(cycle: number): boolean {

        const compositorCycle = cycle - 46;

        if (compositorCycle < 0 || compositorCycle >= this.frame.width * 4) {
            return false;
        }

        const phase = compositorCycle & 3;

        if (phase === 0) {
            const directMode3 = this.displayMode === 3
                && (this.displayControl & DISPCNT_BG2_ENABLE) !== 0
                && (this.displayControl & DISPCNT_OBJECT_ENABLE) === 0;

            return !directMode3;
        }

        if (phase !== 2) {
            return false;
        }

        const alphaBlend = ((this.blendControl >>> 6) & 0x03) === 1;
        const hasFirstTarget = (this.blendControl & 0x003f) !== 0;
        const hasSecondTarget = (this.blendControl & 0x3f00) !== 0;
        const semiTransparentObject = (this.displayControl & DISPCNT_OBJECT_ENABLE) !== 0;

        return hasSecondTarget && ((alphaBlend && hasFirstTarget) || semiTransparentObject);
    }

    private renderScanline(scanline: number): void {

        const frameOffset = scanline * this.frame.width;

        if (this.forcedBlank) {
            this.frame.pixels.fill(0xffffffff, frameOffset, frameOffset + this.frame.width);
            return;
        }

        const backdrop = this.readPaletteColor(0);

        this.frame.pixels.fill(backdrop, frameOffset, frameOffset + this.frame.width);
        this.scanlineTopLayer.fill(5);
        this.scanlineTopRank.fill(0xffff);
        this.scanlineTopSemiTransparent.fill(0);
        this.scanlineSecondLayer.fill(0xff);
        this.scanlineSecondRank.fill(0xffff);
        this.prepareWindowMask(scanline);

        if (this.displayMode <= 2) {
            const backgrounds = [0, 1, 2, 3].filter((background) => {

                const available = this.displayMode === 0
                    || (this.displayMode === 1 && background <= 2)
                    || (this.displayMode === 2 && background >= 2);

                return available
                    && (this.displayControl & (DISPCNT_BG0_ENABLE << background)) !== 0;
            }).sort((left, right) => {

                const priorityDifference = (this.readBackgroundControl(right) & 0x03)
                    - (this.readBackgroundControl(left) & 0x03);

                return priorityDifference || right - left;
            });

            for (const background of backgrounds) {
                if (this.displayMode === 0 || background < 2) {
                    this.renderTextBackground(background, scanline, frameOffset);
                } else {
                    this.renderAffineTileBackground(background, frameOffset);
                }
            }

            this.finishScanline(scanline, frameOffset);
            return;
        }

        if ((this.displayControl & DISPCNT_BG2_ENABLE) === 0) {
            this.finishScanline(scanline, frameOffset);
            return;
        }

        if (this.displayMode < 3 || this.displayMode > 5) {
            this.finishScanline(scanline, frameOffset);
            return;
        }

        const textureWidth = this.displayMode === 5 ? 160 : 240;
        const textureHeight = this.displayMode === 5 ? 128 : 160;
        const pageOffset = this.displayMode === 3 ? 0 : this.frameSelect * 0x0a000;
        const parameterA = this.signedParameter(2, 0);
        const parameterB = this.signedParameter(2, 1);
        const parameterC = this.signedParameter(2, 2);
        const parameterD = this.signedParameter(2, 3);
        const mosaic = (this.readBackground2Control() & 0x0040) !== 0;
        const mosaicWidth = (this.mosaic & 0x0f) + 1;
        const mosaicHeight = ((this.mosaic >>> 4) & 0x0f) + 1;
        const mosaicY = mosaic ? scanline % mosaicHeight : 0;
        const originX = (this.backgroundAffineInternalX[0] ?? 0) - parameterB * mosaicY;
        const originY = (this.backgroundAffineInternalY[0] ?? 0) - parameterD * mosaicY;

        for (let pixelX = 0; pixelX < this.frame.width; pixelX++) {
            if (((this.scanlineWindowMask[pixelX] ?? 0) & 0x04) === 0) {
                continue;
            }

            const sampleX = mosaic ? pixelX - (pixelX % mosaicWidth) : pixelX;
            const textureX = originX + parameterA * sampleX;
            const textureY = originY + parameterC * sampleX;
            let sourceX = Math.floor(textureX / 0x100);
            let sourceY = Math.floor(textureY / 0x100);

            if ((this.readBackground2Control() & BGCNT_OVERFLOW_WRAP) !== 0) {
                sourceX = this.wrapCoordinate(sourceX, textureWidth);
                sourceY = this.wrapCoordinate(sourceY, textureHeight);
            }

            if (sourceX >= 0 && sourceX < textureWidth && sourceY >= 0 && sourceY < textureHeight) {
                const sourceOffset = sourceY * textureWidth + sourceX;
                const color = this.displayMode === 4
                    ? this.readPaletteColor((this.videoMemory.vram[pageOffset + sourceOffset] ?? 0) * 2)
                    : this.readVRAMColor(pageOffset + sourceOffset * 2);

                this.submitPixel(
                    pixelX,
                    frameOffset,
                    color,
                    2,
                    this.backgroundRank(2),
                );
            }

        }

        this.finishScanline(scanline, frameOffset);
    }

    private readPaletteColor(offset: number): number {

        const color = (this.videoMemory.paletteRAM[offset] ?? 0)
            | ((this.videoMemory.paletteRAM[offset + 1] ?? 0) << 8);

        return this.mapRGB555(color);
    }

    private renderTextBackground(background: number, scanline: number, frameOffset: number): void {

        const control = this.readBackgroundControl(background);
        const size = control >>> 14;
        const backgroundWidth = (size & 0x01) !== 0 ? 512 : 256;
        const backgroundHeight = (size & 0x02) !== 0 ? 512 : 256;
        const characterBase = ((control >>> 2) & 0x03) * 0x4000;
        const screenBase = ((control >>> 8) & 0x1f) * 0x0800;
        const color256 = (control & 0x0080) !== 0;
        const mosaic = (control & 0x0040) !== 0;
        const mosaicWidth = (this.mosaic & 0x0f) + 1;
        const mosaicHeight = ((this.mosaic >>> 4) & 0x0f) + 1;
        const screenY = mosaic ? scanline - (scanline % mosaicHeight) : scanline;
        const sourceY = (screenY + this.readBackgroundOffset(background, true)) % backgroundHeight;
        const horizontalOffset = this.readBackgroundOffset(background, false);
        const windowMask = 1 << background;
        const rank = this.backgroundRank(background);
        const vram = this.videoMemory.vram;

        for (let pixelX = 0; pixelX < this.frame.width; pixelX++) {
            const screenX = mosaic ? pixelX - (pixelX % mosaicWidth) : pixelX;
            const sourceX = (screenX + horizontalOffset) % backgroundWidth;

            if (((this.scanlineWindowMask[pixelX] ?? 0) & windowMask) === 0) {
                continue;
            }

            const tileX = sourceX >>> 3;
            const tileY = sourceY >>> 3;
            const screenBlockX = tileX >>> 5;
            const screenBlockY = tileY >>> 5;
            const screenBlocksWide = backgroundWidth >>> 8;
            const screenBlock = screenBlockY * screenBlocksWide + screenBlockX;
            const mapOffset = screenBase
                + screenBlock * 0x0800
                + (((tileY & 0x1f) * 32 + (tileX & 0x1f)) * 2);
            const mapEntry = (vram[mapOffset] ?? 0) | ((vram[mapOffset + 1] ?? 0) << 8);
            const tile = mapEntry & 0x03ff;
            const tilePixelX = (mapEntry & 0x0400) !== 0 ? 7 - (sourceX & 0x07) : sourceX & 0x07;
            const tilePixelY = (mapEntry & 0x0800) !== 0 ? 7 - (sourceY & 0x07) : sourceY & 0x07;
            let paletteIndex: number;

            if (color256) {
                const tileOffset = characterBase + tile * 64 + tilePixelY * 8 + tilePixelX;

                paletteIndex = vram[tileOffset] ?? 0;
            } else {
                const tileOffset = characterBase + tile * 32 + tilePixelY * 4 + (tilePixelX >>> 1);
                const packedPixels = vram[tileOffset] ?? 0;
                const color = (packedPixels >>> ((tilePixelX & 1) * 4)) & 0x0f;

                paletteIndex = ((mapEntry >>> 12) * 16) + color;
            }

            if ((paletteIndex & (color256 ? 0xff : 0x0f)) !== 0) {
                this.submitPixel(
                    pixelX,
                    frameOffset,
                    this.readPaletteColor(paletteIndex * 2),
                    background,
                    rank,
                );
            }
        }
    }

    private renderAffineTileBackground(background: number, frameOffset: number): void {

        const affine = this.affineBackgroundIndex(background);
        const control = this.readBackgroundControl(background);
        const size = 128 << (control >>> 14);
        const tilesPerAxis = size >>> 3;
        const characterBase = ((control >>> 2) & 0x03) * 0x4000;
        const screenBase = ((control >>> 8) & 0x1f) * 0x0800;
        const parameterA = this.signedParameter(background, 0);
        const parameterB = this.signedParameter(background, 1);
        const parameterC = this.signedParameter(background, 2);
        const parameterD = this.signedParameter(background, 3);
        const mosaic = (control & 0x0040) !== 0;
        const mosaicWidth = (this.mosaic & 0x0f) + 1;
        const mosaicHeight = ((this.mosaic >>> 4) & 0x0f) + 1;
        const mosaicY = mosaic ? this.scanline % mosaicHeight : 0;
        const originX = (this.backgroundAffineInternalX[affine] ?? 0) - parameterB * mosaicY;
        const originY = (this.backgroundAffineInternalY[affine] ?? 0) - parameterD * mosaicY;

        for (let pixelX = 0; pixelX < this.frame.width; pixelX++) {
            if (((this.scanlineWindowMask[pixelX] ?? 0) & (1 << background)) === 0) {
                continue;
            }

            const sampleX = mosaic ? pixelX - (pixelX % mosaicWidth) : pixelX;
            const textureX = originX + parameterA * sampleX;
            const textureY = originY + parameterC * sampleX;
            let sourceX = Math.floor(textureX / 0x100);
            let sourceY = Math.floor(textureY / 0x100);

            if ((control & BGCNT_OVERFLOW_WRAP) !== 0) {
                sourceX = this.wrapCoordinate(sourceX, size);
                sourceY = this.wrapCoordinate(sourceY, size);
            }

            if (sourceX >= 0 && sourceX < size && sourceY >= 0 && sourceY < size) {
                const mapOffset = screenBase
                    + (sourceY >>> 3) * tilesPerAxis
                    + (sourceX >>> 3);
                const tile = this.videoMemory.vram[mapOffset] ?? 0;
                const tileOffset = characterBase
                    + tile * 64
                    + (sourceY & 0x07) * 8
                    + (sourceX & 0x07);
                const paletteIndex = this.videoMemory.vram[tileOffset] ?? 0;

                if (paletteIndex !== 0) {
                    this.submitPixel(
                        pixelX,
                        frameOffset,
                        this.readPaletteColor(paletteIndex * 2),
                        background,
                        this.backgroundRank(background),
                    );
                }
            }
        }
    }

    private renderObjects(scanline: number, frameOffset: number, objectWindow = false): void {

        const enable = objectWindow ? DISPCNT_OBJECT_WINDOW_ENABLE : DISPCNT_OBJECT_ENABLE;

        if ((this.displayControl & enable) === 0) {
            return;
        }

        for (let object = 127; object >= 0; object--) {
            const oamOffset = object * 8;
            const attribute0 = this.readOAMHalfword(oamOffset);
            const attribute1 = this.readOAMHalfword(oamOffset + 2);
            const attribute2 = this.readOAMHalfword(oamOffset + 4);
            const affine = (attribute0 & 0x0100) !== 0;
            const objectMode = (attribute0 >>> 10) & 0x03;
            const drawableObject = objectMode === 0 || objectMode === 1;

            if ((!affine && (attribute0 & 0x0200) !== 0)
                    || (objectWindow ? objectMode !== 2 : !drawableObject)) {
                continue;
            }

            const shape = attribute0 >>> 14;
            const size = attribute1 >>> 14;
            const dimensions = OBJECT_DIMENSIONS[shape]?.[size];

            if (dimensions === undefined) {
                continue;
            }

            const [width, height] = dimensions;
            const doubleSize = affine && (attribute0 & 0x0200) !== 0;
            const fieldWidth = doubleSize ? width * 2 : width;
            const fieldHeight = doubleSize ? height * 2 : height;
            const positionY = attribute0 & 0xff;
            const rawObjectY = (scanline - positionY) & 0xff;

            if (rawObjectY >= fieldHeight) {
                continue;
            }

            const rawPositionX = attribute1 & 0x01ff;
            const positionX = rawPositionX >= 0x0100 ? rawPositionX - 0x0200 : rawPositionX;
            const color256 = (attribute0 & 0x2000) !== 0;
            const tileUnitsPerTile = color256 ? 2 : 1;
            const baseTile = (attribute2 & 0x03ff) & (color256 ? 0x03fe : 0x03ff);
            const priority = (attribute2 >>> 10) & 0x03;
            const matrix = (attribute1 >>> 9) & 0x1f;
            const parameterA = affine ? this.readObjectAffineParameter(matrix, 0) : 0;
            const parameterB = affine ? this.readObjectAffineParameter(matrix, 1) : 0;
            const parameterC = affine ? this.readObjectAffineParameter(matrix, 2) : 0;
            const parameterD = affine ? this.readObjectAffineParameter(matrix, 3) : 0;
            const mosaic = (attribute0 & 0x1000) !== 0;
            const mosaicWidth = ((this.mosaic >>> 8) & 0x0f) + 1;
            const mosaicHeight = ((this.mosaic >>> 12) & 0x0f) + 1;
            const objectY = mosaic
                ? rawObjectY - (rawObjectY % mosaicHeight)
                : rawObjectY;

            if (this.displayMode >= 3 && baseTile < 0x0200) {
                continue;
            }

            for (let objectX = 0; objectX < fieldWidth; objectX++) {
                const screenX = positionX + objectX;

                if (screenX < 0 || screenX >= this.frame.width
                    || (!objectWindow
                        && ((this.scanlineWindowMask[screenX] ?? 0) & 0x10) === 0)) {
                    continue;
                }

                let sourceX: number;
                let sourceY: number;
                const sampleX = mosaic ? objectX - (objectX % mosaicWidth) : objectX;

                if (affine) {
                    const centeredX = sampleX - fieldWidth / 2;
                    const centeredY = objectY - fieldHeight / 2;

                    sourceX = Math.floor(
                        (parameterA * centeredX + parameterB * centeredY + width * 0x80)
                        / 0x100,
                    );
                    sourceY = Math.floor(
                        (parameterC * centeredX + parameterD * centeredY + height * 0x80)
                        / 0x100,
                    );

                    if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) {
                        continue;
                    }
                } else {
                    sourceX = (attribute1 & 0x1000) !== 0 ? width - 1 - sampleX : sampleX;
                    sourceY = (attribute1 & 0x2000) !== 0 ? height - 1 - objectY : objectY;
                }

                const tileX = sourceX >>> 3;
                const tileY = sourceY >>> 3;
                const tileUnit = this.objectMapping1D
                    ? baseTile + (tileY * (width >>> 3) + tileX) * tileUnitsPerTile
                    : baseTile + tileY * 32 + tileX * tileUnitsPerTile;
                const tileOffset = 0x10000
                    + (tileUnit & 0x03ff) * 32
                    + (sourceY & 0x07) * (color256 ? 8 : 4)
                    + (color256 ? sourceX & 0x07 : (sourceX & 0x07) >>> 1);
                const packedPixels = this.videoMemory.vram[tileOffset] ?? 0;
                const color = color256
                    ? packedPixels
                    : (packedPixels >>> ((sourceX & 1) * 4)) & 0x0f;

                if (color === 0) {
                    continue;
                }

                if (objectWindow) {
                    this.scanlineObjectWindow[screenX] = 1;
                    continue;
                }

                const palette = color256 ? 0 : attribute2 >>> 12;

                this.submitPixel(
                    screenX,
                    frameOffset,
                    this.readPaletteColor(0x200 + (palette * 16 + color) * 2),
                    4,
                    priority * 132 + object,
                    objectMode === 1,
                );
            }
        }
    }

    private finishScanline(scanline: number, frameOffset: number): void {

        this.renderObjects(scanline, frameOffset);
        this.applyColorEffects(frameOffset);
    }

    private submitPixel(
        pixelX: number,
        frameOffset: number,
        color: number,
        layer: number,
        rank: number,
        semiTransparent = false,
    ): void {

        const topRank = this.scanlineTopRank[pixelX] ?? 0xffff;

        if (rank < topRank) {
            this.scanlineSecondColor[pixelX] = this.frame.pixels[frameOffset + pixelX] ?? 0xff000000;
            this.scanlineSecondLayer[pixelX] = this.scanlineTopLayer[pixelX] ?? 5;
            this.scanlineSecondRank[pixelX] = topRank;
            this.frame.pixels[frameOffset + pixelX] = color;
            this.scanlineTopLayer[pixelX] = layer;
            this.scanlineTopRank[pixelX] = rank;
            this.scanlineTopSemiTransparent[pixelX] = semiTransparent ? 1 : 0;
        } else if (rank < (this.scanlineSecondRank[pixelX] ?? 0xffff)) {
            this.scanlineSecondColor[pixelX] = color;
            this.scanlineSecondLayer[pixelX] = layer;
            this.scanlineSecondRank[pixelX] = rank;
        }
    }

    private applyColorEffects(frameOffset: number): void {

        const effect = (this.blendControl >>> 6) & 0x03;

        for (let pixelX = 0; pixelX < this.frame.width; pixelX++) {
            if (((this.scanlineWindowMask[pixelX] ?? 0) & 0x20) === 0) {
                continue;
            }

            const layer = this.scanlineTopLayer[pixelX] ?? 5;
            const firstTarget = (this.blendControl & (1 << layer)) !== 0;
            const semiTransparent = (this.scanlineTopSemiTransparent[pixelX] ?? 0) !== 0;
            const secondLayer = this.scanlineSecondLayer[pixelX] ?? 0xff;
            const secondTarget = secondLayer < 6
                && (this.blendControl & (1 << (8 + secondLayer))) !== 0;
            const color = this.frame.pixels[frameOffset + pixelX] ?? 0xff000000;

            if ((semiTransparent || (effect === 1 && firstTarget)) && secondTarget) {
                this.frame.pixels[frameOffset + pixelX] = this.alphaBlend(
                    color,
                    this.scanlineSecondColor[pixelX] ?? 0xff000000,
                );
            } else if (!semiTransparent && firstTarget && effect === 2) {
                this.frame.pixels[frameOffset + pixelX] = this.adjustBrightness(color, true);
            } else if (!semiTransparent && firstTarget && effect === 3) {
                this.frame.pixels[frameOffset + pixelX] = this.adjustBrightness(color, false);
            }
        }
    }

    private alphaBlend(first: number, second: number): number {

        const coefficientA = Math.min(this.blendAlpha & 0x1f, 16);
        const coefficientB = Math.min((this.blendAlpha >>> 8) & 0x1f, 16);

        return this.transformColor(first, (channel, shift) => Math.min(
            31,
            ((channel * coefficientA)
                + (((second >>> shift) & 0xff) >>> 3) * coefficientB) >>> 4,
        ));
    }

    private adjustBrightness(color: number, increase: boolean): number {

        const coefficient = Math.min(this.blendBrightness & 0x1f, 16);

        return this.transformColor(color, (channel) => increase
            ? channel + (((31 - channel) * coefficient) >>> 4)
            : channel - ((channel * coefficient) >>> 4));
    }

    private transformColor(color: number, transform: (channel: number, shift: number) => number): number {

        const red = transform(((color >>> 16) & 0xff) >>> 3, 16);
        const green = transform(((color >>> 8) & 0xff) >>> 3, 8);
        const blue = transform((color & 0xff) >>> 3, 0);

        return this.mapRGB555(red | (green << 5) | (blue << 10));
    }

    private backgroundRank(background: number): number {

        return (this.readBackgroundControl(background) & 0x03) * 132 + 128 + background;
    }

    private prepareWindowMask(scanline: number): void {

        const windowsEnabled = this.displayControl & (
            DISPCNT_WINDOW0_ENABLE
            | DISPCNT_WINDOW1_ENABLE
            | DISPCNT_OBJECT_WINDOW_ENABLE
        );

        if (windowsEnabled === 0) {
            this.scanlineWindowMask.fill(0x3f);
            return;
        }

        this.scanlineWindowMask.fill(this.readWindowControl(2));

        if ((this.displayControl & DISPCNT_OBJECT_WINDOW_ENABLE) !== 0) {
            this.scanlineObjectWindow.fill(0);
            this.renderObjects(scanline, 0, true);

            for (let pixelX = 0; pixelX < this.frame.width; pixelX++) {
                if ((this.scanlineObjectWindow[pixelX] ?? 0) !== 0) {
                    this.scanlineWindowMask[pixelX] = this.readWindowControl(3);
                }
            }
        }

        for (let window = 1; window >= 0; window--) {
            const enable = window === 0 ? DISPCNT_WINDOW0_ENABLE : DISPCNT_WINDOW1_ENABLE;

            if ((this.displayControl & enable) === 0
                || !this.inWindowRange(scanline, this.readWindowBounds(window, true))) {
                continue;
            }

            const horizontal = this.readWindowBounds(window, false);

            for (let pixelX = 0; pixelX < this.frame.width; pixelX++) {
                if (this.inWindowRange(pixelX, horizontal)) {
                    this.scanlineWindowMask[pixelX] = this.readWindowControl(window);
                }
            }
        }
    }

    private inWindowRange(position: number, bounds: number): boolean {

        const start = bounds >>> 8;
        const end = bounds & 0xff;

        return start <= end
            ? position >= start && position < end
            : position >= start || position < end;
    }

    private readObjectAffineParameter(matrix: number, parameter: number): number {

        return this.signExtend(this.readOAMHalfword(matrix * 32 + 6 + parameter * 8), 16);
    }

    private readOAMHalfword(offset: number): number {

        return (this.videoMemory.oam[offset] ?? 0)
            | ((this.videoMemory.oam[offset + 1] ?? 0) << 8);
    }

    private readVRAMColor(offset: number): number {

        const color = (this.videoMemory.vram[offset] ?? 0)
            | ((this.videoMemory.vram[offset + 1] ?? 0) << 8);

        return this.mapRGB555(color);
    }

    private mapRGB555(color: number): number {

        const red5 = color & 0x1f;
        const green5 = (color >>> 5) & 0x1f;
        const blue5 = (color >>> 10) & 0x1f;
        const red = (red5 << 3) | (red5 >>> 2);
        const green = (green5 << 3) | (green5 >>> 2);
        const blue = (blue5 << 3) | (blue5 >>> 2);

        return (0xff000000 | (red << 16) | (green << 8) | blue) >>> 0;
    }

    private signedParameter(background: number, index: number): number {

        return this.signExtend(this.readBackgroundAffineParameter(background, index), 16);
    }

    private signExtend(value: number, bits: number): number {

        const shift = 32 - bits;

        return (value << shift) >> shift;
    }

    private wrapCoordinate(value: number, size: number): number {

        return ((value % size) + size) % size;
    }

    private affineParameterIndex(index: number): number {

        if (!Number.isInteger(index) || index < 0 || index >= 4) {
            throw new RangeError(`GBA affine parameter index ${index} is outside 0-3.`);
        }

        return index;
    }

    private referenceIndex(index: number): number {

        if (!Number.isInteger(index) || index < 0 || index >= 2) {
            throw new RangeError(`GBA affine reference index ${index} is outside 0-1.`);
        }

        return index;
    }

    private affineBackgroundIndex(background: number): number {

        if (!Number.isInteger(background) || background < 2 || background > 3) {
            throw new RangeError(`GBA affine background index ${background} is outside 2-3.`);
        }

        return background - 2;
    }

    private backgroundIndex(index: number): number {

        if (!Number.isInteger(index) || index < 0 || index >= 4) {
            throw new RangeError(`GBA background index ${index} is outside 0-3.`);
        }

        return index;
    }

    private windowIndex(index: number): number {

        if (!Number.isInteger(index) || index < 0 || index >= 2) {
            throw new RangeError(`GBA window index ${index} is outside 0-1.`);
        }

        return index;
    }

    private windowControlIndex(index: number): number {

        if (!Number.isInteger(index) || index < 0 || index >= 4) {
            throw new RangeError(`GBA window control index ${index} is outside 0-3.`);
        }

        return index;
    }
}
