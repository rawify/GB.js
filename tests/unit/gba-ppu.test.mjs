import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_BACKGROUND0_CONTROL_ADDRESS,
    GBA_BACKGROUND0_OFFSET_ADDRESS,
    GBA_BACKGROUND2_AFFINE_ADDRESS,
    GBA_BACKGROUND2_CONTROL_ADDRESS,
    GBA_BACKGROUND3_AFFINE_ADDRESS,
    GBA_BLEND_CONTROL_ADDRESS,
    GBA_CYCLES_PER_SCANLINE,
    GBA_DISPLAY_CONTROL_ADDRESS,
    GBA_DISPLAY_STATUS_ADDRESS,
    GBA_DMA_BASE_ADDRESS,
    GBA_HDRAW_CYCLES,
    GBA_INTERRUPT,
    GBA_MOSAIC_ADDRESS,
    GBA_VERTICAL_COUNT_ADDRESS,
    GBA_WINDOW0_HORIZONTAL_ADDRESS,
    GBA_WINDOW_CONTROL_ADDRESS,
    GBAPPU,
    GBABus,
    GBAInterruptController,
    GBAScheduler,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

function createPPU() {

    const interrupts = new GBAInterruptController();
    const triggers = [];
    const ppu = new GBAPPU(interrupts, {
        trigger: (trigger) => triggers.push(trigger),
    });
    const scheduler = new GBAScheduler();

    scheduler.register(ppu);

    return { interrupts, ppu, scheduler, triggers };
}

function writeObject(bus, index, attribute0, attribute1, attribute2) {

    const offset = index * 8;

    bus.oam[offset] = attribute0 & 0xff;
    bus.oam[offset + 1] = attribute0 >>> 8;
    bus.oam[offset + 2] = attribute1 & 0xff;
    bus.oam[offset + 3] = attribute1 >>> 8;
    bus.oam[offset + 4] = attribute2 & 0xff;
    bus.oam[offset + 5] = attribute2 >>> 8;
}

function writeObjectMatrix(bus, index, parameters) {

    for (let parameter = 0; parameter < parameters.length; parameter++) {
        const offset = index * 32 + 6 + parameter * 8;
        const value = parameters[parameter];

        bus.oam[offset] = value & 0xff;
        bus.oam[offset + 1] = value >>> 8;
    }
}

describe('GBA PPU timing', () => {

    it('starts HBlank after the measured 1007-cycle drawing interval', () => {

        assert.equal(GBA_HDRAW_CYCLES, 1007);
        assert.equal(GBA_CYCLES_PER_SCANLINE - GBA_HDRAW_CYCLES, 225);
    });

    it('stalls CPU VRAM accesses on text, affine and bitmap background fetches', () => {

        const cases = [
            { control: 0x0100, cycle: 31, penalty: 1 },
            { control: 2 | 0x0400, cycle: 33, penalty: 2 },
            { control: 3 | 0x0400, cycle: 34, penalty: 1 },
        ];

        for (const { control, cycle, penalty } of cases) {
            const bus = new GBABus({ rom: new Uint8Array(0x100) });

            bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, control);
            bus.ppu.tick(cycle);
            bus.beginTiming();
            bus.read16(0x06000000);

            assert.equal(bus.endTiming(), penalty);
        }
    });

    it('stalls palette accesses on compositor fetch phases', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.ppu.tick(45);
        bus.beginTiming();
        bus.read16(0x05000000);

        assert.equal(bus.endTiming(), 1);

        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x2000 | 0x0020 | 0x0040);
        bus.ppu.tick(2);
        bus.beginTiming();
        bus.read16(0x05000000);

        assert.equal(bus.endTiming(), 1);
    });

    it('stalls OAM and OBJ VRAM on regular sprite pipeline fetches', () => {

        const oamBus = new GBABus({ rom: new Uint8Array(0x100) });

        writeObject(oamBus, 0, 1, 0, 0);
        oamBus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        oamBus.ppu.tick(39);
        oamBus.beginTiming();
        oamBus.read32(0x07000000);

        assert.equal(oamBus.endTiming(), 1);

        const vramBus = new GBABus({ rom: new Uint8Array(0x100) });

        writeObject(vramBus, 0, 1, 0, 0);
        vramBus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        vramBus.ppu.tick(43);
        vramBus.beginTiming();
        vramBus.read16(0x06010000);

        assert.equal(vramBus.endTiming(), 1);
    });

    it('runs the OBJ pipeline for an independently enabled object window', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        writeObject(bus, 0, 2 << 10, 0, 0);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x8000);
        bus.ppu.tick(39);
        bus.beginTiming();
        bus.read32(0x07000000);

        assert.equal(bus.endTiming(), 1);
    });

    it('delays affine OBJ pixels and stops OBJ fetches for HBlank-free access', () => {

        const affineBus = new GBABus({ rom: new Uint8Array(0x100) });

        writeObject(affineBus, 0, 0x0101, 0, 0);
        affineBus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        affineBus.ppu.tick(55);
        affineBus.beginTiming();
        affineBus.read16(0x06010000);

        assert.equal(affineBus.endTiming(), 1);

        const hblankFreeBus = new GBABus({ rom: new Uint8Array(0x100) });

        for (let object = 0; object < 128; object++) {
            writeObject(hblankFreeBus, object, 1, 3 << 14, 0);
        }

        hblankFreeBus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1020);
        hblankFreeBus.ppu.tick(GBA_HDRAW_CYCLES - 1);
        hblankFreeBus.beginTiming();
        hblankFreeBus.read16(0x06010000);

        assert.equal(hblankFreeBus.endTiming(), 0);
    });

    it('applies video bus stalls to DMA destinations', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0100);
        bus.ppu.tick(28);
        bus.write32(0x040000b0, 0x03000000);
        bus.write32(0x040000b4, 0x06000000);
        bus.write16(0x040000b8, 1);
        bus.write16(0x040000ba, 0x8000);

        assert.equal(bus.dma.runPending(), 5);
    });

    it('maps and resets the MOSAIC register', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_MOSAIC_ADDRESS, 0x1234);

        assert.equal(bus.read16(GBA_MOSAIC_ADDRESS), 0x1234);
        assert.equal(bus.ppu.readMosaic(), 0x1234);

        bus.reset();

        assert.equal(bus.read16(GBA_MOSAIC_ADDRESS), 0);
    });

    it('applies horizontal and vertical mosaic to text backgrounds', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000004, 0x7c00);
        bus.vram[32] = 0x21;
        bus.vram[32 + 4] = 0x22;
        bus.vram[0x2000] = 1;
        bus.write16(0x04000008, 0x0040 | (4 << 8));
        bus.write16(GBA_MOSAIC_ADDRESS, 0x0011);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0100);
        bus.ppu.tick(GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(240, 242)],
            [0xffff0000, 0xffff0000],
        );
    });

    it('applies screen-space mosaic to affine bitmap backgrounds', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x06000000, 0x001f);
        bus.write16(0x06000002, 0x7c00);
        bus.write16(0x060001e0, 0x03e0);
        bus.write16(GBA_BACKGROUND2_CONTROL_ADDRESS, 0x0040);
        bus.write16(GBA_MOSAIC_ADDRESS, 0x0011);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);
        bus.ppu.tick(GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(240, 242)],
            [0xffff0000, 0xffff0000],
        );
    });

    it('applies local mosaic coordinates to regular and affine OBJ', () => {

        for (const affine of [false, true]) {
            const bus = new GBABus({ rom: new Uint8Array(0x100) });

            bus.write16(0x05000202, 0x001f);
            bus.write16(0x05000204, 0x7c00);
            bus.vram[0x10000 + 32] = 0x21;
            bus.vram[0x10000 + 32 + 4] = 0x22;
            writeObject(bus, 0, 0x1000 | (affine ? 0x0100 : 0), 0, 1);

            if (affine) {
                writeObjectMatrix(bus, 0, [0x0100, 0, 0, 0x0100]);
            }

            bus.write16(GBA_MOSAIC_ADDRESS, 0x1100);
            bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
            bus.ppu.tick(GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

            assert.deepEqual(
                [...bus.frame.pixels.slice(240, 242)],
                [0xffff0000, 0xffff0000],
                `affine ${affine}`,
            );
        }
    });

    it('maps masked blend control, alpha and brightness registers', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0xffff);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 2, 0xffff);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 4, 0xffff);

        assert.equal(bus.read16(GBA_BLEND_CONTROL_ADDRESS), 0x3fff);
        assert.equal(bus.read16(GBA_BLEND_CONTROL_ADDRESS + 2), 0x1f1f);
        assert.equal(bus.read16(GBA_BLEND_CONTROL_ADDRESS + 4), 0x001f);
        assert.throws(() => bus.ppu.readBlendRegister(3), /outside 0-2/);

        bus.reset();

        assert.equal(bus.read16(GBA_BLEND_CONTROL_ADDRESS), 0);
        assert.equal(bus.read16(GBA_BLEND_CONTROL_ADDRESS + 2), 0);
        assert.equal(bus.read16(GBA_BLEND_CONTROL_ADDRESS + 4), 0);
    });

    it('alpha blends the first target with the next visible second target', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000004, 0x7c00);
        bus.vram[32] = 1;
        bus.vram[0x4000 + 32] = 2;
        bus.vram[0x2000] = 1;
        bus.vram[0x2800] = 1;
        bus.write16(0x04000008, 4 << 8);
        bus.write16(0x0400000a, 1 | 4 | (5 << 8));
        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x0241);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 2, 0x0808);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0300);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff7b007b);
    });

    it('retains a lower-priority OBJ as the second alpha target behind a BG', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000204, 0x7c00);
        bus.vram[32] = 1;
        bus.vram[0x2000] = 1;
        bus.vram[0x10000 + 32] = 2;
        writeObject(bus, 0, 0, 0, 1 | (1 << 10));
        bus.write16(0x04000008, 4 << 8);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x1041);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 2, 0x0808);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff7b007b);
    });

    it('brightens and darkens selected first-target pixels', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x00bf);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 4, 0x001f);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffffffff);

        bus.ppu.reset();
        bus.write16(0x05000000, 0x7fff);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x00ff);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 4, 0x0010);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff000000);
    });

    it('forces alpha for semi-transparent OBJ and obeys the window effects bit', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x7c00);
        bus.write16(0x05000202, 0x001f);
        bus.vram[32] = 1;
        bus.vram[0x2000] = 1;
        bus.vram[0x10000 + 32] = 1;
        writeObject(bus, 0, 0x0400, 0, 1);
        bus.write16(0x04000008, 4 << 8);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x0100);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 2, 0x0808);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff7b007b);

        bus.ppu.reset();
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS, 0x0001);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4, 0x0001);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS, 0x0011);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS, 0x0100);
        bus.write16(GBA_BLEND_CONTROL_ADDRESS + 2, 0x0808);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x3100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('maps window bounds and masked layer controls', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS, 0x1234);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 2, 0x5678);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4, 0x9abc);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 6, 0xdef0);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS, 0xffff);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS + 2, 0xffff);

        assert.equal(bus.read16(GBA_WINDOW0_HORIZONTAL_ADDRESS), 0x1234);
        assert.equal(bus.read16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 2), 0x5678);
        assert.equal(bus.read16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4), 0x9abc);
        assert.equal(bus.read16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 6), 0xdef0);
        assert.equal(bus.read16(GBA_WINDOW_CONTROL_ADDRESS), 0x3f3f);
        assert.equal(bus.read16(GBA_WINDOW_CONTROL_ADDRESS + 2), 0x3f3f);

        bus.reset();

        assert.equal(bus.read16(GBA_WINDOW0_HORIZONTAL_ADDRESS), 0);
        assert.equal(bus.read16(GBA_WINDOW_CONTROL_ADDRESS), 0);
        assert.throws(() => bus.ppu.readWindowBounds(2, false), /outside 0-1/);
        assert.throws(() => bus.ppu.readWindowControl(4), /outside 0-3/);
    });

    it('clips BG and OBJ layers through WIN0 and WINOUT controls', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000204, 0x7c00);
        bus.vram[32] = 0x11;
        bus.vram[33] = 0x11;
        bus.vram[0x2000] = 1;
        bus.vram[0x10000 + 32] = 0x22;
        bus.vram[0x10000 + 33] = 0x22;
        writeObject(bus, 0, 0, 0, 1);
        bus.write16(0x04000008, 4 << 8);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS, 0x0103);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4, 0x0001);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS, 0x0010);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS + 2, 0x0001);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x3100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 4)],
            [0xffff0000, 0xff0000ff, 0xff0000ff, 0xffff0000],
        );
    });

    it('wraps WIN1 horizontally and vertically below WIN0 priority', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x05000002, 0x001f);
        bus.vram[32] = 0x11;
        bus.vram[33] = 0x11;
        bus.vram[0x2000] = 1;
        bus.write16(0x04000008, 4 << 8);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS, 0x0103);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 2, 0x0201);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4, 0x0001);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 6, 0x9f01);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS, 0x0100);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS + 2, 0x0000);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x6100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 4)],
            [0xffff0000, 0xff00ff00, 0xff00ff00, 0xffff0000],
        );
    });

    it('uses visible OBJ-window pixels below WIN0 and above WINOUT', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x05000002, 0x001f);
        bus.vram[32] = 0x11;
        bus.vram[0x2000] = 1;
        bus.vram[0x10000 + 32] = 0x01;
        writeObject(bus, 0, 0x0800, 1, 1);
        bus.write16(0x04000008, 4 << 8);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS + 2, 0x0100);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x8100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 3)],
            [0xff00ff00, 0xffff0000, 0xff00ff00],
        );

        bus.ppu.reset();
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS, 0x0102);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4, 0x0001);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS, 0x0000);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS + 2, 0x0100);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0xa100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[1], 0xff00ff00);
    });

    it('clips bitmap BG2 pixels through the window layer mask', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x06000000, 0x001f);
        bus.write16(0x06000002, 0x7c00);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS, 0x0102);
        bus.write16(GBA_WINDOW0_HORIZONTAL_ADDRESS + 4, 0x0001);
        bus.write16(GBA_WINDOW_CONTROL_ADDRESS, 0x0004);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400 | 0x2000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 2)],
            [0xff00ff00, 0xff0000ff],
        );
    });

    it('renders flipped regular 4-bpp objects through OBJ palette banks', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000246, 0x001f);
        bus.vram[0x10000 + 32 + 7 * 4 + 3] = 0x30;
        writeObject(bus, 0, 0, 0x3000, 1 | (2 << 12));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('renders every regular OBJ shape and size at its bottom-right pixel', () => {

        const dimensions = [
            [[8, 8], [16, 16], [32, 32], [64, 64]],
            [[16, 8], [32, 8], [32, 16], [64, 32]],
            [[8, 16], [8, 32], [16, 32], [32, 64]],
        ];

        for (let shape = 0; shape < dimensions.length; shape++) {
            for (let size = 0; size < 4; size++) {
                const bus = new GBABus({ rom: new Uint8Array(0x100) });
                const [width, height] = dimensions[shape][size];
                const tile = 1 + ((height >>> 3) - 1) * (width >>> 3) + ((width >>> 3) - 1);

                bus.write16(0x05000202, 0x001f);
                bus.vram[0x10000 + tile * 32 + 31] = 0x10;
                writeObject(bus, 0, shape << 14, size << 14, 1);
                bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1040);
                bus.ppu.tick((height - 1) * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

                assert.equal(
                    bus.frame.pixels[(height - 1) * 240 + width - 1],
                    0xffff0000,
                    `shape ${shape}, size ${size}`,
                );
            }
        }
    });

    it('transforms affine objects through their selected OAM matrix', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000202, 0x001f);
        bus.vram[0x10000 + 32] = 1;
        writeObject(bus, 0, 0x0103, 2 | (31 << 9), 1);
        writeObjectMatrix(bus, 31, [0x0100, 0, 0, 0x0100]);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(3 * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[3 * 240 + 2], 0xffff0000);
        assert.equal(bus.frame.pixels[3 * 240 + 3], 0xff000000);
    });

    it('centers affine objects inside their double-size field', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000202, 0x001f);
        bus.vram[0x10000 + 32] = 1;
        writeObject(bus, 0, 0x0300, 0, 1);
        writeObjectMatrix(bus, 0, [0x0100, 0, 0, 0x0100]);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(4 * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[4 * 240], 0xff000000);
        assert.equal(bus.frame.pixels[4 * 240 + 4], 0xffff0000);
    });

    it('applies signed off-diagonal affine OBJ parameters', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000202, 0x001f);
        bus.vram[0x10000 + 32 + 7 * 4] = 1;
        writeObject(bus, 0, 0x0100, 0, 1);
        writeObjectMatrix(bus, 0, [0, 0x0100, 0xff00, 0]);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff000000);
        assert.equal(bus.frame.pixels[1], 0xffff0000);
    });

    it('maps affine rectangular objects across 1D tile rows', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const tile = 1 + 3 * 8 + 7;

        bus.write16(0x05000202, 0x001f);
        bus.vram[0x10000 + tile * 32 + 31] = 0x10;
        writeObject(bus, 0, 0x4100, 3 << 14, 1);
        writeObjectMatrix(bus, 0, [0x0100, 0, 0, 0x0100]);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1040);
        bus.ppu.tick(31 * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[31 * 240 + 63], 0xffff0000);
    });

    it('selects 1D or 2D object tile rows and supports 8-bpp tiles', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000202, 0x001f);
        bus.write16(0x05000204, 0x7c00);
        bus.vram[0x10000 + 4 * 32] = 1;
        bus.vram[0x10000 + 34 * 32] = 2;
        writeObject(bus, 0, 0, 1 << 14, 1);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1040);
        bus.ppu.tick(8 * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[8 * 240 + 8], 0xffff0000);

        bus.ppu.reset();
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(8 * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[8 * 240 + 8], 0xff0000ff);

        bus.ppu.reset();
        bus.vram[0x10000 + 2 * 32] = 5;
        bus.write16(0x0500020a, 0x03e0);
        writeObject(bus, 0, 0x2000, 0, 3);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff00ff00);
    });

    it('wraps object coordinates and preserves the backdrop through transparent pixels', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x05000202, 0x001f);
        bus.vram[0x10000 + 32 + 4 + 2] = 0x10;
        writeObject(bus, 0, 0x0200, 0, 1);
        writeObject(bus, 1, 0x00ff, 0x01fc, 1);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 2)],
            [0xff00ff00, 0xffff0000],
        );
    });

    it('uses only the upper OBJ tile half in bitmap modes', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000202, 0x001f);
        bus.write16(0x05000204, 0x7c00);
        bus.vram[0x10000 + 32] = 1;
        bus.vram[0x14000] = 2;
        writeObject(bus, 0, 0, 0, 1);
        writeObject(bus, 1, 0, 0, 0x0200);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);
    });

    it('renders semi-transparent OBJ opaquely without a second target and hides OBJ-window color', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x05000202, 0x001f);
        bus.vram[0x10000 + 32] = 1;
        writeObject(bus, 0, 0x0400, 0, 1);
        writeObject(bus, 1, 0x0800, 0, 1);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('resolves OBJ priority against backgrounds and OAM index ties', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000204, 0x7c00);
        bus.write16(0x05000206, 0x03e0);
        bus.vram[32] = 1;
        bus.vram[0x2000] = 1;
        bus.vram[0x10000 + 32] = 2;
        bus.vram[0x10000 + 64] = 3;
        writeObject(bus, 0, 0, 0, 1 | (1 << 10));
        writeObject(bus, 1, 0, 0, 2 | (1 << 10));
        bus.write16(0x04000008, 4 << 8);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);

        bus.ppu.reset();
        bus.write16(0x04000008, (4 << 8) | 1);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);

        bus.ppu.reset();
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x1000);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);
    });

    it('maps BG0 control and write-only 9-bit scroll offsets', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_BACKGROUND0_CONTROL_ADDRESS, 0xffff);
        bus.write16(GBA_BACKGROUND0_OFFSET_ADDRESS, 0xffff);
        bus.write16(GBA_BACKGROUND0_OFFSET_ADDRESS + 2, 0x1234);

        assert.equal(bus.read16(GBA_BACKGROUND0_CONTROL_ADDRESS), 0xdfcf);
        assert.equal(bus.read32(GBA_BACKGROUND0_OFFSET_ADDRESS), 0);
        assert.equal(bus.ppu.readBackground0Offset(false), 0x01ff);
        assert.equal(bus.ppu.readBackground0Offset(true), 0x0034);

        bus.reset();

        assert.equal(bus.read16(GBA_BACKGROUND0_CONTROL_ADDRESS), 0);
        assert.equal(bus.ppu.readBackground0Offset(false), 0);
        assert.equal(bus.ppu.readBackground0Offset(true), 0);
    });

    it('renders flipped 4-bpp BG0 tiles through their palette bank', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const mapEntry = 1 | 0x0400 | 0x0800 | (2 << 12);

        bus.write16(0x05000046, 0x001f);
        bus.vram[32 + 7 * 4 + 3] = 0x30;
        bus.vram[0x0800] = mapEntry & 0xff;
        bus.vram[0x0801] = mapEntry >>> 8;
        bus.write16(GBA_BACKGROUND0_CONTROL_ADDRESS, 1 << 8);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('maps scrolled 8-bpp BG0 tiles across 512 by 512 screen blocks', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const screenBase = 8 * 0x0800;
        const fourthBlock = screenBase + 3 * 0x0800;

        bus.write16(0x0500000a, 0x7c00);
        bus.vram[2 * 64] = 5;
        bus.vram[fourthBlock] = 2;
        bus.write16(GBA_BACKGROUND0_CONTROL_ADDRESS, 0x0080 | (8 << 8) | (3 << 14));
        bus.write16(GBA_BACKGROUND0_OFFSET_ADDRESS, 0x0100);
        bus.write16(GBA_BACKGROUND0_OFFSET_ADDRESS + 2, 0x0100);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0100);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);
    });

    it('composes Mode 0 text backgrounds by priority and BG number', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000004, 0x7c00);
        bus.vram[32] = 1;
        bus.vram[0x4000 + 32] = 2;
        bus.vram[0x2000] = 1;
        bus.vram[0x2800] = 1;
        bus.write16(0x04000008, (4 << 8) | 1);
        bus.write16(0x0400000a, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0300);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);

        bus.ppu.reset();
        bus.write16(0x04000008, 4 << 8);
        bus.write16(0x0400000a, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0300);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('renders transparent BG0/BG1 text pixels in Mode 1', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.vram[32] = 1;
        bus.vram[0x2000] = 1;
        bus.vram[0x2800] = 2;
        bus.write16(0x04000008, 4 << 8);
        bus.write16(0x0400000a, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 1 | 0x0300);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('maps BG1-BG3 controls and scroll offsets across their I/O ranges', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        for (let background = 1; background < 4; background++) {
            bus.write16(GBA_BACKGROUND0_CONTROL_ADDRESS + background * 2, 0xffff);
            bus.write16(GBA_BACKGROUND0_OFFSET_ADDRESS + background * 4, 0x0100 + background);
            bus.write16(GBA_BACKGROUND0_OFFSET_ADDRESS + background * 4 + 2, 0x0180 + background);
        }

        assert.equal(bus.ppu.readBackgroundControl(1), 0xdfcf);
        assert.equal(bus.ppu.readBackgroundControl(2), 0xffcf);
        assert.equal(bus.ppu.readBackgroundControl(3), 0xffcf);
        assert.equal(bus.ppu.readBackgroundOffset(1, false), 0x0101);
        assert.equal(bus.ppu.readBackgroundOffset(2, true), 0x0182);
        assert.equal(bus.ppu.readBackgroundOffset(3, true), 0x0183);
        assert.throws(() => bus.ppu.readBackgroundControl(4), /outside 0-3/);
    });

    it('maps BG2 affine parameters and signed 28-bit reference points', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        assert.equal(bus.read16(GBA_BACKGROUND2_AFFINE_ADDRESS), 0x0100);
        assert.equal(bus.read16(GBA_BACKGROUND2_AFFINE_ADDRESS + 6), 0x0100);

        bus.write16(GBA_BACKGROUND2_CONTROL_ADDRESS, 0xffff);
        bus.write16(GBA_BACKGROUND2_AFFINE_ADDRESS, 0xff80);
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x0fffff00);

        assert.equal(bus.read16(GBA_BACKGROUND2_CONTROL_ADDRESS), 0xffcf);
        assert.equal(bus.read16(GBA_BACKGROUND2_AFFINE_ADDRESS), 0xff80);
        assert.equal(bus.read32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8), 0);
        assert.equal(bus.ppu.readBackground2Reference(0), 0x0fffff00);
        assert.throws(() => bus.ppu.readBackground2Parameter(4), /outside 0-3/);
        assert.throws(() => bus.ppu.readBackground2Reference(2), /outside 0-1/);
    });

    it('maps independent BG3 affine matrix and reference registers', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_BACKGROUND3_AFFINE_ADDRESS, 0xff00);
        bus.write16(GBA_BACKGROUND3_AFFINE_ADDRESS + 6, 0x0200);
        bus.write32(GBA_BACKGROUND3_AFFINE_ADDRESS + 8, 0x0fffff00);

        assert.equal(bus.read16(GBA_BACKGROUND3_AFFINE_ADDRESS), 0xff00);
        assert.equal(bus.read16(GBA_BACKGROUND3_AFFINE_ADDRESS + 6), 0x0200);
        assert.equal(bus.read32(GBA_BACKGROUND3_AFFINE_ADDRESS + 8), 0);
        assert.equal(bus.ppu.readBackgroundAffineReference(3, 0), 0x0fffff00);
        assert.equal(bus.ppu.readBackground2Parameter(0), 0x0100);
        assert.throws(() => bus.ppu.readBackgroundAffineParameter(1, 0), /outside 2-3/);
    });

    it('composes Mode 2 affine BG2/BG3 tiles by priority and BG number', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000004, 0x7c00);
        bus.vram[64] = 1;
        bus.vram[0x4000 + 64] = 2;
        bus.vram[0x2000] = 1;
        bus.vram[0x2800] = 1;
        bus.write16(0x0400000c, (4 << 8) | 1);
        bus.write16(0x0400000e, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 2 | 0x0c00);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);

        bus.ppu.reset();
        bus.write16(0x0400000c, 4 << 8);
        bus.write16(0x0400000e, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 2 | 0x0c00);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('composes Mode 1 text BG0 with transparent affine BG2 pixels', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000004, 0x7c00);
        bus.vram[32] = 1;
        bus.vram[0x4000 + 64] = 2;
        bus.vram[0x2000] = 1;
        bus.vram[0x2800] = 1;
        bus.write16(0x04000008, (4 << 8) | 1);
        bus.write16(0x0400000c, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 1 | 0x0500);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff0000ff);

        bus.ppu.reset();
        bus.vram[0x4000 + 64] = 0;
        bus.write16(0x04000008, (4 << 8) | 1);
        bus.write16(0x0400000c, 4 | (5 << 8));
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 1 | 0x0500);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('addresses every affine map size at its bottom-right tile', () => {

        for (let sizeSelection = 0; sizeSelection < 4; sizeSelection++) {
            const bus = new GBABus({ rom: new Uint8Array(0x100) });
            const size = 128 << sizeSelection;
            const tilesPerAxis = size >>> 3;
            const screenBase = 8 * 0x0800;

            bus.write16(0x05000002, 0x001f);
            bus.vram[64 + 63] = 1;
            bus.vram[screenBase + tilesPerAxis * tilesPerAxis - 1] = 1;
            bus.write16(
                GBA_BACKGROUND2_CONTROL_ADDRESS,
                (8 << 8) | (sizeSelection << 14),
            );
            bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, (size - 1) << 8);
            bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 12, (size - 1) << 8);
            bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 2 | 0x0400);
            bus.ppu.tick(GBA_HDRAW_CYCLES);

            assert.equal(bus.frame.pixels[0], 0xffff0000, `size ${size}`);
        }
    });

    it('addresses 1024-pixel affine maps and wraps negative coordinates', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const screenBase = 8 * 0x0800;

        bus.write16(0x05000002, 0x001f);
        bus.vram[64 + 63] = 1;
        bus.vram[screenBase + 128 * 128 - 1] = 1;
        bus.write16(GBA_BACKGROUND2_CONTROL_ADDRESS, (8 << 8) | (3 << 14));
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x0fffff00);
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 12, 0x0fffff00);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 2 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff000000);

        bus.ppu.reset();
        bus.write16(GBA_BACKGROUND2_CONTROL_ADDRESS, 0x2000 | (8 << 8) | (3 << 14));
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x0fffff00);
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 12, 0x0fffff00);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 2 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('maps DISPCNT fields and resets display control', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        assert.equal(bus.read16(GBA_DISPLAY_CONTROL_ADDRESS), 0);

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0xffff);

        assert.equal(bus.read16(GBA_DISPLAY_CONTROL_ADDRESS), 0xfff7);
        assert.equal(bus.ppu.displayMode, 7);
        assert.equal(bus.ppu.frameSelect, 1);
        assert.equal(bus.ppu.hblankIntervalFree, true);
        assert.equal(bus.ppu.objectMapping1D, true);
        assert.equal(bus.ppu.forcedBlank, true);

        bus.reset();

        assert.equal(bus.read16(GBA_DISPLAY_CONTROL_ADDRESS), 0);
        assert.equal(bus.ppu.displayMode, 0);
        assert.equal(bus.ppu.frameSelect, 0);
        assert.equal(bus.ppu.hblankIntervalFree, false);
        assert.equal(bus.ppu.objectMapping1D, false);
        assert.equal(bus.ppu.forcedBlank, false);
    });

    it('uses display mode to separate bitmap and object VRAM byte writes', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x06010000, 0x1111);
        bus.write8(0x06010000, 0x22);
        assert.equal(bus.read16(0x06010000), 0x1111);

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3);
        bus.write8(0x06010000, 0x33);
        bus.write16(0x06014000, 0x4444);
        bus.write8(0x06014000, 0x55);

        assert.equal(bus.read16(0x06010000), 0x3333);
        assert.equal(bus.read16(0x06014000), 0x4444);
    });

    it('renders mode 3 RGB555 scanlines with BG2, backdrop and forced blank', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x06000000, 0x001f);
        bus.write16(0x06000002, 0x7c00);

        assert.equal(bus.frame.width, 240);
        assert.equal(bus.frame.height, 160);
        assert.equal(bus.frame.pixels.length, 240 * 160);
        assert.equal(bus.frame.pixels[0], 0xffffffff);

        bus.ppu.writeDisplayControl(3);
        bus.ppu.tick(GBA_HDRAW_CYCLES);
        assert.equal(bus.frame.pixels[0], 0xff00ff00);

        bus.ppu.reset();
        bus.ppu.writeDisplayControl(3 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);
        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 2)],
            [0xffff0000, 0xff0000ff],
        );

        bus.ppu.reset();
        bus.ppu.writeDisplayControl(3 | 0x0400 | 0x0080);
        bus.ppu.tick(GBA_HDRAW_CYCLES);
        assert.equal(bus.frame.pixels[0], 0xffffffff);
    });

    it('applies signed 8.8 matrix parameters and 20.8 reference points', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const sourceA = (1 * 240 + 1) * 2;
        const sourceB = 1 * 240 * 2;

        bus.vram[sourceA] = 0x1f;
        bus.vram[sourceB + 1] = 0x7c;
        bus.write16(GBA_BACKGROUND2_AFFINE_ADDRESS, 0xff00);
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x00000100);
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 12, 0x00000100);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 2)],
            [0xffff0000, 0xff0000ff],
        );
    });

    it('clips negative affine coordinates or wraps them through BG2CNT', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000000, 0x03e0);
        bus.write16(0x060001de, 0x001f);
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x0fffff00);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xff00ff00);

        bus.ppu.reset();
        bus.write32(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x0fffff00);
        bus.write16(GBA_BACKGROUND2_CONTROL_ADDRESS, 0x2000);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('advances internal references by PB/PD and reloads on reference high writes', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x06000000, 0x001f);
        bus.write16(0x060001e2, 0x7c00);
        bus.write16(0x060003cc, 0x03e0);
        bus.write16(GBA_BACKGROUND2_AFFINE_ADDRESS + 2, 0x0100);
        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);

        bus.write16(GBA_BACKGROUND2_AFFINE_ADDRESS + 8, 0x0500);
        bus.ppu.tick(GBA_CYCLES_PER_SCANLINE);

        assert.equal(bus.frame.pixels[240], 0xff0000ff);

        bus.write16(GBA_BACKGROUND2_AFFINE_ADDRESS + 10, 0);
        bus.ppu.tick(GBA_CYCLES_PER_SCANLINE);

        assert.equal(bus.frame.pixels[480], 0xff00ff00);
    });

    it('renders mode 4 palette indices from the selected bitmap page', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(0x05000002, 0x001f);
        bus.write16(0x05000004, 0x7c00);
        bus.vram[0] = 1;
        bus.vram[0x0a000] = 2;

        bus.ppu.writeDisplayControl(4 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);
        assert.equal(bus.frame.pixels[0], 0xffff0000);

        bus.ppu.reset();
        bus.ppu.writeDisplayControl(4 | 0x0010 | 0x0400);
        bus.ppu.tick(GBA_HDRAW_CYCLES);
        assert.equal(bus.frame.pixels[0], 0xff0000ff);
    });

    it('renders mode 5 pages at 160 by 128 over the backdrop', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const lastPixelOffset = 0x0a000 + ((127 * 160 + 159) * 2);

        bus.write16(0x05000000, 0x03e0);
        bus.vram[0x0a000] = 0x1f;
        bus.vram[lastPixelOffset] = 0x00;
        bus.vram[lastPixelOffset + 1] = 0x7c;
        bus.ppu.writeDisplayControl(5 | 0x0010 | 0x0400);
        bus.ppu.tick(127 * GBA_CYCLES_PER_SCANLINE + GBA_HDRAW_CYCLES);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
        assert.equal(bus.frame.pixels[127 * 240 + 159], 0xff0000ff);
        assert.equal(bus.frame.pixels[127 * 240 + 160], 0xff00ff00);

        bus.ppu.tick(GBA_CYCLES_PER_SCANLINE);
        assert.equal(bus.frame.pixels[128 * 240], 0xff00ff00);
    });

    it('publishes scanlines through the system framebuffer exactly at HBlank', () => {

        const system = new GameBoyAdvanceSystem({ rom: new Uint8Array(0x100) });

        system.bus.write16(0x06000000, 0x001f);
        system.bus.write16(0x060001e0, 0x03e0);
        system.bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);

        assert.equal(system.frame, system.bus.frame);
        assert.equal(system.frame.pixels[0], 0xffffffff);

        system.scheduler.advance(GBA_HDRAW_CYCLES - 1);
        assert.equal(system.frame.pixels[0], 0xffffffff);

        system.scheduler.advance(1);
        assert.equal(system.frame.pixels[0], 0xffff0000);

        system.scheduler.advance(GBA_CYCLES_PER_SCANLINE - 1);
        assert.equal(system.frame.pixels[240], 0xffffffff);

        system.scheduler.advance(1);
        assert.equal(system.frame.pixels[240], 0xff00ff00);
    });

    it('can skip pixel output without skipping PPU timing', () => {

        const system = new GameBoyAdvanceSystem({ rom: new Uint8Array(0x100) });

        system.bus.write16(0x06000000, 0x001f);
        system.bus.write16(0x060001e0, 0x03e0);
        system.bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 3 | 0x0400);
        system.bus.ppu.setRenderingEnabled(false);
        system.scheduler.advance(GBA_CYCLES_PER_SCANLINE);

        assert.equal(system.frame.pixels[0], 0xffffffff);
        assert.equal(system.bus.ppu.verticalCount, 1);

        system.bus.ppu.setRenderingEnabled(true);
        system.scheduler.advance(GBA_HDRAW_CYCLES);

        assert.equal(system.frame.pixels[240], 0xff00ff00);
    });

    it('gates OAM by display phase, forced blank and HBlank-free control', () => {

        const { ppu, scheduler } = createPPU();

        assert.equal(ppu.canAccessOAM(), false);

        ppu.writeDisplayControl(0x0080);
        assert.equal(ppu.canAccessOAM(), true);

        ppu.writeDisplayControl(0);
        scheduler.advance(GBA_HDRAW_CYCLES);
        assert.equal(ppu.canAccessOAM(), false);

        ppu.writeDisplayControl(0x0020);
        assert.equal(ppu.canAccessOAM(), true);

        scheduler.advance((160 * GBA_CYCLES_PER_SCANLINE) - GBA_HDRAW_CYCLES);
        ppu.writeDisplayControl(0);
        assert.equal(ppu.canAccessOAM(), true);
    });

    it('ignores locked OAM writes and returns open bus until access is free', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.setOpenBus(0x44332211);
        bus.write16(0x07000000, 0x1234);

        assert.equal(bus.oam[0], 0);
        assert.equal(bus.read16(0x07000000), 0x2211);

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0080);
        bus.write16(0x07000000, 0x5678);

        assert.equal(bus.read16(0x07000000), 0x5678);

        bus.write16(GBA_DISPLAY_CONTROL_ADDRESS, 0x0020);
        bus.ppu.tick(GBA_HDRAW_CYCLES);

        assert.equal(bus.read16(0x07000000), 0x5678);
    });

    it('enters HBlank and advances VCOUNT at exact scanline boundaries', () => {

        const { interrupts, ppu, scheduler, triggers } = createPPU();

        ppu.writeDisplayStatus(0x0130);
        scheduler.advance(GBA_HDRAW_CYCLES - 1);

        assert.equal(ppu.readDisplayStatus() & 0x02, 0);
        assert.deepEqual(triggers, []);

        scheduler.advance(1);

        assert.equal(ppu.readDisplayStatus() & 0x02, 0x02);
        assert.deepEqual(triggers, ['hblank']);
        assert.equal(interrupts.requested, GBA_INTERRUPT.hblank);

        scheduler.advance(GBA_CYCLES_PER_SCANLINE - GBA_HDRAW_CYCLES - 1);
        assert.equal(ppu.verticalCount, 0);

        scheduler.advance(1);

        assert.equal(ppu.verticalCount, 1);
        assert.equal(ppu.cyclesIntoScanline, 0);
        assert.equal(ppu.readDisplayStatus() & 0x06, 0x04);
        assert.equal(interrupts.requested, GBA_INTERRUPT.hblank | GBA_INTERRUPT.vcount);
    });

    it('sets VBlank through line 226 and wraps after line 227', () => {

        const { interrupts, ppu, scheduler, triggers } = createPPU();

        ppu.writeDisplayStatus(0xa028);
        scheduler.advance(160 * GBA_CYCLES_PER_SCANLINE - 1);

        assert.equal(ppu.verticalCount, 159);
        assert.equal(ppu.readDisplayStatus() & 0x05, 0);

        scheduler.advance(1);

        assert.equal(ppu.verticalCount, 160);
        assert.equal(ppu.readDisplayStatus() & 0x05, 0x05);
        assert.equal(triggers.at(-1), 'vblank');
        assert.equal(interrupts.requested, GBA_INTERRUPT.vblank | GBA_INTERRUPT.vcount);

        scheduler.advance(67 * GBA_CYCLES_PER_SCANLINE);
        assert.equal(ppu.verticalCount, 227);
        assert.equal(ppu.readDisplayStatus() & 0x01, 0);

        scheduler.advance(GBA_CYCLES_PER_SCANLINE);
        assert.equal(ppu.verticalCount, 0);
        assert.equal(ppu.readDisplayStatus() & 0x04, 0);
    });

    it('maps writable DISPSTAT fields and read-only VCOUNT through the bus', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        assert.equal(bus.read16(GBA_DISPLAY_STATUS_ADDRESS), 0x0004);
        assert.equal(bus.read16(GBA_VERTICAL_COUNT_ADDRESS), 0);

        bus.write16(GBA_DISPLAY_STATUS_ADDRESS, 0xffff);
        bus.write16(GBA_VERTICAL_COUNT_ADDRESS, 0xffff);

        assert.equal(bus.read16(GBA_DISPLAY_STATUS_ADDRESS), 0xff38);
        assert.equal(bus.read16(GBA_VERTICAL_COUNT_ADDRESS), 0);

        bus.reset();

        assert.equal(bus.read16(GBA_DISPLAY_STATUS_ADDRESS), 0x0004);
    });

    it('raises HBlank IRQ and DMA from the system scheduler', () => {

        const system = new GameBoyAdvanceSystem({ rom: new Uint8Array(0x100) });

        system.bus.write16(0x03000000, 0x5a5a);
        system.bus.write32(GBA_DMA_BASE_ADDRESS, 0x03000000);
        system.bus.write32(GBA_DMA_BASE_ADDRESS + 4, 0x02000000);
        system.bus.write16(GBA_DMA_BASE_ADDRESS + 8, 1);
        system.bus.write16(GBA_DMA_BASE_ADDRESS + 10, 0xa000);
        system.bus.write16(GBA_DISPLAY_STATUS_ADDRESS, 0x0010);

        system.scheduler.advance(GBA_HDRAW_CYCLES - 1);

        assert.equal(system.bus.interrupts.requested, 0);
        assert.equal(system.bus.dma.hasPending, false);

        system.scheduler.advance(1);

        assert.equal(system.bus.interrupts.requested, GBA_INTERRUPT.hblank);
        assert.equal(system.bus.dma.hasPending, true);

        system.step();

        assert.equal(system.bus.read16(0x02000000), 0x5a5a);
        assert.equal(system.bus.dma.hasPending, false);
    });

    it('requests VBlank DMA only when scanline 160 begins', () => {

        const system = new GameBoyAdvanceSystem({ rom: new Uint8Array(0x100) });
        const channel = GBA_DMA_BASE_ADDRESS + 12;

        system.bus.write16(0x03000000, 0x1234);
        system.bus.write32(channel, 0x03000000);
        system.bus.write32(channel + 4, 0x02000000);
        system.bus.write16(channel + 8, 1);
        system.bus.write16(channel + 10, 0x9000);

        system.scheduler.advance(160 * GBA_CYCLES_PER_SCANLINE - 1);
        assert.equal(system.bus.dma.hasPending, false);

        system.scheduler.advance(1);
        assert.equal(system.bus.ppu.verticalCount, 160);
        assert.equal(system.bus.dma.hasPending, true);

        system.step();
        assert.equal(system.bus.read16(0x02000000), 0x1234);
    });

    it('resets scanline timing together with the system scheduler', () => {

        const system = new GameBoyAdvanceSystem({ rom: new Uint8Array(0x100) });

        system.scheduler.advance(GBA_CYCLES_PER_SCANLINE + 17);
        system.bus.write16(GBA_DISPLAY_STATUS_ADDRESS, 0xff38);
        system.reset();

        assert.equal(system.cycles, 0);
        assert.equal(system.bus.ppu.verticalCount, 0);
        assert.equal(system.bus.ppu.cyclesIntoScanline, 0);
        assert.equal(system.bus.read16(GBA_DISPLAY_STATUS_ADDRESS), 0x0004);
    });
});
