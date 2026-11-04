import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DMGBus,
    DMG_GRAYSCALE_PALETTE,
    GAME_BOY_INTERRUPT,
    GAME_BOY_LOGO,
    calculateGameBoyHeaderChecksum,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

function createROM(type = 0x00, sizeCode = 0x00, bankCount = 2) {

    const rom = new Uint8Array(bankCount * 0x4000);

    for (let bank = 0; bank < bankCount; bank++) {
        rom[bank * 0x4000] = bank + 0x40;
    }

    rom.set(GAME_BOY_LOGO, 0x0104);
    rom.set([0x42, 0x55, 0x53], 0x0134);
    rom[0x0147] = type;
    rom[0x0148] = sizeCode;
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    return rom;
}

function createBus(options = {}) {

    const rom = createROM();

    if (options.model === 'cgb') {
        rom[0x0143] = 0x80;
        rom[0x014d] = calculateGameBoyHeaderChecksum(rom);
    }

    return new DMGBus({
        cartridge: createGameBoyCartridge(rom),
        ...options,
    });
}

describe('DMG bus', () => {

    it('maps the boot ROM until FF50 receives a nonzero value', () => {

        const bootROM = new Uint8Array(0x0100);

        bootROM[0] = 0x31;

        const bus = createBus({ bootROM });

        assert.equal(bus.read(0x0000), 0x31);
        assert.equal(bus.read(0xff50), 0xff);

        bus.write(0xff50, 0);
        assert.equal(bus.read(0x0000), 0x31);

        bus.write(0xff50, 1);
        assert.equal(bus.read(0x0000), 0x40);
        assert.equal(bus.read(0xff50), 0xff);

        bus.write(0xff50, 0);
        assert.equal(bus.read(0x0000), 0x40);

        bus.reset();
        assert.equal(bus.read(0x0000), 0x31);
    });

    it('rejects boot ROMs with the wrong size', () => {

        assert.throws(
            () => createBus({ bootROM: new Uint8Array(255) }),
            /256-byte DMG boot ROM/,
        );
    });

    it('exports and validates the DMG frame palette', () => {

        assert.deepEqual(
            DMG_GRAYSCALE_PALETTE,
            [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000],
        );
        assert.throws(
            () => createBus({ framePalette: [0xffffffff] }),
            /four DMG frame colors/,
        );
    });

    it('maps volatile memory, echo RAM and unusable addresses', () => {

        const bus = createBus();

        bus.write(0x8000, 0x12);
        bus.write(0xc123, 0x34);
        bus.write(0xe456, 0x56);
        bus.write(0xfe9f, 0x78);
        bus.write(0xfea0, 0x9a);
        bus.write(0xff80, 0xbc);

        assert.equal(bus.read(0x8000), 0x12);
        assert.equal(bus.read(0xe123), 0x34);
        assert.equal(bus.read(0xc456), 0x56);
        assert.equal(bus.read(0xfe9f), 0x78);
        assert.equal(bus.read(0xfea0), 0xff);
        assert.equal(bus.read(0xff80), 0xbc);
    });

    it('ignores writes to unmapped DMG IO addresses', () => {

        const bus = createBus();

        for (const address of [0xff03, 0xff08, 0xff15, 0xff1f, 0xff27, 0xff4c, 0xff51, 0xff7f]) {
            bus.write(address, 0);
            assert.equal(bus.read(address), 0xff);
        }
    });

    it('routes mapper writes and cartridge ROM reads', () => {

        const cartridge = createGameBoyCartridge(createROM(0x01, 0x01, 4));
        const bus = new DMGBus({ cartridge });

        assert.equal(bus.read(0x4000), 0x41);
        bus.write(0x2000, 0x02);
        assert.equal(bus.read(0x4000), 0x42);
    });

    it('masks and requests interrupts through IF and IE', () => {

        const bus = createBus();

        bus.write(0xff0f, 0xaa);
        bus.write(0xffff, 0xff);
        bus.requestInterrupt(GAME_BOY_INTERRUPT.timer);

        assert.equal(bus.read(0xff0f), 0xee);
        assert.equal(bus.interruptFlags, 0x0e);
        assert.equal(bus.read(0xffff), 0xff);
        assert.equal(bus.enabledInterrupts, 0x1f);
    });

    it('maps joypad rows and requests an interrupt on a selected falling edge', () => {

        const bus = createBus();

        bus.setButton('right', true);
        assert.equal(bus.read(0xff00), 0xff);
        assert.equal(bus.interruptFlags, 0);

        bus.write(0xff00, 0x20);
        assert.equal(bus.read(0xff00), 0xee);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.joypad);

        bus.setButton('right', false);
        assert.equal(bus.read(0xff00), 0xef);
    });

    it('completes an internal serial transfer after eight clocks', () => {

        const bus = createBus();

        bus.write(0xff01, 0xa5);
        bus.write(0xff02, 0x81);
        bus.tick(4095);
        assert.equal((bus.read(0xff02) >> 7) & 1, 1);
        assert.equal(bus.interruptFlags, 0);
        bus.tick(1);

        assert.equal(bus.read(0xff01), 0xff);
        assert.equal(bus.read(0xff02), 0x7f);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.serial);
    });

    it('exchanges each internally clocked bit with a serial endpoint', () => {

        const outgoingBits = [];
        const incomingBits = [0, 0, 1, 1, 1, 1, 0, 0];
        const bus = createBus({
            serialEndpoint: {
                exchangeBit(outgoingBit) {

                    outgoingBits.push(outgoingBit);

                    return incomingBits.shift();
                },
            },
        });

        bus.write(0xff01, 0xa5);
        bus.write(0xff02, 0x81);
        bus.tick(4096);

        assert.deepEqual(outgoingBits, [1, 0, 1, 0, 0, 1, 0, 1]);
        assert.equal(bus.read(0xff01), 0x3c);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.serial);
    });

    it('advances an external-clock transfer only from supplied clock edges', () => {

        const bus = createBus();
        const outgoingBits = [];

        bus.write(0xff01, 0xa5);
        bus.write(0xff02, 0x80);
        bus.tick(8192);
        assert.equal(bus.read(0xff01), 0xa5);
        assert.equal(bus.read(0xff02) & 0x80, 0x80);

        for (const inputBit of [0, 0, 1, 1, 1, 1, 0, 0]) {
            outgoingBits.push(bus.clockSerial(inputBit));
        }

        assert.deepEqual(outgoingBits, [1, 0, 1, 0, 0, 1, 0, 1]);
        assert.equal(bus.read(0xff01), 0x3c);
        assert.equal(bus.read(0xff02) & 0x80, 0);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.serial);
        assert.equal(bus.clockSerial(1), 0);
        assert.equal(bus.read(0xff01), 0x3c);
    });

    it('links an internal-clock master to an external-clock bus', () => {

        const slave = createBus();
        const master = createBus({
            serialEndpoint: {
                exchangeBit(outgoingBit) {

                    return slave.clockSerial(outgoingBit);
                },
            },
        });

        slave.write(0xff01, 0x3c);
        slave.write(0xff02, 0x80);
        master.write(0xff01, 0xa5);
        master.write(0xff02, 0x81);
        master.tick(4096);

        assert.equal(master.read(0xff01), 0x3c);
        assert.equal(slave.read(0xff01), 0xa5);
        assert.equal(master.read(0xff02) & 0x80, 0);
        assert.equal(slave.read(0xff02) & 0x80, 0);
        assert.equal(master.interruptFlags, GAME_BOY_INTERRUPT.serial);
        assert.equal(slave.interruptFlags, GAME_BOY_INTERRUPT.serial);
    });

    it('cancels and restarts serial transfers from a fresh clock phase', () => {

        const bus = createBus();

        bus.write(0xff01, 0x80);
        bus.write(0xff02, 0x81);
        bus.tick(512);
        assert.equal(bus.read(0xff01), 0x01);

        bus.write(0xff02, 0x01);
        bus.tick(4096);
        assert.equal(bus.read(0xff01), 0x01);
        assert.equal(bus.interruptFlags, 0);

        bus.write(0xff01, 0x55);
        bus.write(0xff02, 0x81);
        bus.tick(511);
        bus.write(0xff02, 0x81);
        bus.tick(511);
        assert.equal(bus.read(0xff01), 0x55);
        bus.tick(1);
        assert.equal(bus.read(0xff01), 0xab);
        bus.tick(512 * 7);

        assert.equal(bus.read(0xff01), 0xff);
        assert.equal(bus.read(0xff02) & 0x80, 0);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.serial);
    });

    it('normalizes endpoint data and ignores external clocks in internal mode', () => {

        const bus = createBus({
            serialEndpoint: {
                exchangeBit() {

                    return 3;
                },
            },
        });

        bus.write(0xff01, 0);
        bus.write(0xff02, 0x81);
        assert.equal(bus.clockSerial(0), 1);
        assert.equal(bus.read(0xff01), 0);
        bus.tick(4096);

        assert.equal(bus.read(0xff01), 0xff);
    });

    it('advances LCD lines and requests VBlank from CPU cycles', () => {

        const bus = createBus();

        assert.equal(bus.read(0xff44), 0);
        bus.tick(456);
        assert.equal(bus.read(0xff44), 0);

        bus.write(0xff40, 0x80);
        bus.tick(452 + (456 * 142));
        assert.equal(bus.read(0xff44), 143);
        assert.equal(bus.interruptFlags, 0);

        bus.tick(456);
        assert.equal(bus.read(0xff44), 144);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.vblank);

        bus.tick(456 * 10);
        assert.equal(bus.read(0xff44), 0);
        assert.equal(bus.read(0xff41) & 0x03, 2);

        bus.write(0xff40, 0);
        bus.tick(456);
        assert.equal(bus.read(0xff44), 0);
    });

    it('exposes LCD modes and blocks CPU access to active PPU memory', () => {

        const bus = createBus();

        bus.write(0x8000, 0x12);
        bus.write(0xfe00, 0x34);
        assert.equal(bus.read(0xff41) & 0x03, 0);

        bus.write(0xff40, 0x80);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        assert.equal(bus.read(0x8000), 0x12);
        assert.equal(bus.read(0xfe00), 0x34);
        bus.write(0xfe00, 0x56);

        bus.tick(80);
        assert.equal(bus.read(0xff41) & 0x03, 3);
        assert.equal(bus.read(0x8000), 0xff);
        assert.equal(bus.read(0xfe00), 0xff);
        bus.write(0x8000, 0x78);

        bus.tick(172);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        assert.equal(bus.read(0x8000), 0x12);
        assert.equal(bus.read(0xfe00), 0x56);

        bus.tick(204);
        assert.equal(bus.read(0xff41) & 0x03, 2);
        assert.equal(bus.read(0xff44), 1);

        bus.tick(456 * 143);
        assert.equal(bus.read(0xff41) & 0x03, 1);
        assert.equal(bus.read(0xff44), 144);
        assert.equal(bus.read(0xfe00), 0x56);
    });

    it('applies the DMG PPU bus gates at the final four mode 2 cycles', () => {

        const bus = createBus();

        bus.write(0x8000, 0x12);
        bus.write(0xfe00, 0x34);
        bus.write(0xff40, 0x80);
        bus.tick(452 + 75);

        assert.equal(bus.read(0xff41) & 0x03, 2);
        assert.equal(bus.read(0x8000), 0x12);
        assert.equal(bus.read(0xfe00), 0xff);
        bus.write(0xfe00, 0x56);
        assert.equal(bus.oam[0], 0x34);

        bus.tick(1);
        assert.equal(bus.read(0x8000), 0xff);
        bus.write(0x8000, 0x78);
        bus.write(0xfe00, 0x56);
        assert.equal(bus.vram[0], 0x78);
        assert.equal(bus.oam[0], 0x56);

        bus.tick(4);
        bus.write(0x8000, 0x9a);
        bus.write(0xfe00, 0x78);
        assert.equal(bus.vram[0], 0x78);
        assert.equal(bus.oam[0], 0x56);
    });

    it('keeps CGB OAM writes blocked throughout mode 2', () => {

        const bus = createBus({ model: 'cgb' });

        bus.write(0x8000, 0x12);
        bus.write(0xfe00, 0x34);
        bus.write(0xfea0, 0x56);
        bus.write(0xff40, 0x80);
        bus.tick(452 + 76);

        assert.equal(bus.read(0xff41) & 0x03, 2);
        assert.equal(bus.read(0x8000), 0x12);
        assert.equal(bus.read(0xfea0), 0xff);
        bus.write(0xfe00, 0x56);
        bus.write(0xfea0, 0x78);
        assert.equal(bus.oam[0], 0x34);

        bus.write(0xff40, 0);
        assert.equal(bus.read(0xfea0), 0x56);
    });

    it('blocks DMG OAM reads during the early-LY end-of-line window', () => {

        const bus = createBus();

        bus.write(0xfe00, 0x34);
        bus.write(0xff40, 0x80);
        bus.tick(452 + 451);
        assert.equal(bus.read(0xfe00), 0x34);

        bus.tick(1);
        assert.equal(bus.read(0xff44), 2);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        assert.equal(bus.read(0xfe00), 0xff);
        bus.write(0xfe00, 0x56);
        assert.equal(bus.oam[0], 0x56);
    });

    it('starts the first LCD line in mode 0 and enters mode 3 at cycle 76', () => {

        const bus = createBus();

        bus.write(0x8000, 0x12);
        bus.write(0xfe00, 0x34);
        bus.write(0xff40, 0x80);
        bus.tick(75);

        assert.equal(bus.read(0xff41) & 0x03, 0);
        assert.equal(bus.read(0x8000), 0x12);
        assert.equal(bus.read(0xfe00), 0x34);

        bus.tick(1);
        assert.equal(bus.read(0xff41) & 0x03, 3);
        assert.equal(bus.read(0x8000), 0xff);
        assert.equal(bus.read(0xfe00), 0xff);
    });

    it('renders background pixels into an RGBA framebuffer during mode 3', () => {

        const bus = createBus();

        bus.write(0x8000, 0xaa);
        bus.write(0x8001, 0xcc);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);

        assert.equal(bus.frame.width, 160);
        assert.equal(bus.frame.height, 144);
        assert.equal(bus.frame.pixels.length, 160 * 144);
        assert.equal(bus.frame.pixels[0], 0xffffffff);

        bus.tick(87);
        assert.equal(bus.frame.pixels[0], 0xffffffff);
        bus.tick(1);
        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 4)],
            [0xff000000, 0xffffffff, 0xffffffff, 0xffffffff],
        );
        bus.tick(3);
        assert.deepEqual(
            [...bus.frame.pixels.slice(0, 4)],
            [0xff000000, 0xff555555, 0xffaaaaaa, 0xffffffff],
        );
    });

    it('applies palette writes only to pixels not yet emitted in mode 3', () => {

        const bus = createBus();

        bus.write(0x8000, 0xff);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);
        bus.tick(103);
        bus.write(0xff47, 0xfc);
        bus.tick(145);

        assert.equal(bus.frame.pixels[15], 0xffaaaaaa);
        assert.equal(bus.frame.pixels[16], 0xff000000);
    });

    it('latches background tile data when the fetcher reads it', () => {

        const bus = createBus();

        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);
        bus.tick(85);
        bus.vram[0] = 0xff;
        bus.tick(11);

        assert.equal(bus.frame.pixels[0], 0xffffffff);
        assert.equal(bus.frame.pixels[8], 0xffaaaaaa);
    });

    it('pauses pixel output while fetching a sprite', () => {

        const bus = createBus();

        bus.write(0x8000, 0xff);
        bus.write(0xfe00, 16);
        bus.write(0xfe01, 16);
        bus.write(0xfe02, 1);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x93);
        bus.tick(95);
        bus.tick(8);

        assert.equal(bus.frame.pixels[7], 0xffaaaaaa);
        assert.equal(bus.frame.pixels[8], 0xffffffff);
        bus.tick(1);
        assert.equal(bus.frame.pixels[8], 0xffaaaaaa);
    });

    it('latches sprite pixels before its fetch stall completes', () => {

        const bus = createBus();

        bus.write(0x8010, 0xff);
        bus.write(0xfe00, 16);
        bus.write(0xfe01, 8);
        bus.write(0xfe02, 1);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff48, 0xe4);
        bus.write(0xff40, 0x93);
        bus.tick(92);
        bus.vram[0x10] = 0;
        bus.tick(8);

        assert.equal(bus.frame.pixels[0], 0xffaaaaaa);
    });

    it('aborts an active DMG sprite fetch when LCDC disables objects', () => {

        const bus = createBus();

        bus.write(0x8010, 0xff);
        bus.write(0xfe00, 16);
        bus.write(0xfe01, 8);
        bus.write(0xfe02, 1);
        bus.write(0xff47, 0xe4);
        bus.write(0xff48, 0xe4);
        bus.write(0xff40, 0x93);
        bus.tick(88);

        const mode3End = bus.lcdMode3End;

        assert.equal(bus.lcdPixelStallCycles, 7);
        assert.notEqual(bus.lcdObjectFetchSnapshot, undefined);

        bus.write(0xff40, 0x91);

        assert.equal(bus.lcdPixelStallCycles, 0);
        assert.equal(bus.lcdObjectFetchSnapshot, undefined);
        assert.equal(bus.lcdMode3End, mode3End - 7);
        assert.deepEqual(bus.lcdObjectFIFO, []);
    });

    it('does not abort an active CGB sprite fetch when LCDC disables objects', () => {

        const bus = createBus({ model: 'cgb' });

        bus.write(0x8010, 0xff);
        bus.write(0xfe00, 16);
        bus.write(0xfe01, 8);
        bus.write(0xfe02, 1);
        bus.write(0xff47, 0xe4);
        bus.write(0xff48, 0xe4);
        bus.write(0xff40, 0x93);
        bus.tick(88);

        const mode3End = bus.lcdMode3End;

        bus.write(0xff40, 0x91);

        assert.equal(bus.lcdPixelStallCycles, 7);
        assert.notEqual(bus.lcdObjectFetchSnapshot, undefined);
        assert.equal(bus.lcdMode3End, mode3End);
    });

    it('clears and refills the background FIFO when the window starts', () => {

        const bus = createBus();

        bus.write(0x8000, 0xff);
        bus.write(0x8010, 0xff);
        bus.write(0x8011, 0xff);
        bus.write(0x9c00, 1);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff4a, 0);
        bus.write(0xff4b, 15);
        bus.write(0xff40, 0xf1);
        bus.tick(95);
        bus.tick(3);

        assert.equal(bus.frame.pixels[7], 0xffaaaaaa);
        assert.equal(bus.frame.pixels[8], 0xffffffff);
        bus.tick(1);
        assert.equal(bus.frame.pixels[8], 0xff000000);
    });

    it('maps a custom frame palette and publishes complete frames at VBlank', () => {

        const framePalette = [0xff102030, 0xff405060, 0xff708090, 0xffa0b0c0];
        const publishedFrames = [];
        const bus = createBus({
            framePalette,
            onFrame: (frame, number) => publishedFrames.push({ frame, number }),
        });

        bus.write(0x8000, 0x80);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);

        assert.equal(bus.frame.pixels[0], framePalette[0]);
        assert.equal(bus.completedFrames, 0);

        bus.tick(252);
        assert.equal(bus.frame.pixels[0], framePalette[1]);
        assert.equal(publishedFrames.length, 0);

        bus.tick((456 * 144) - 252);
        assert.equal(bus.completedFrames, 1);
        assert.deepEqual(publishedFrames, [{ frame: bus.frame, number: 1 }]);

        bus.reset();
        assert.equal(bus.frame.pixels[0], framePalette[0]);
        assert.equal(bus.completedFrames, 0);
    });

    it('uses signed background tile addressing', () => {

        const bus = createBus();

        bus.write(0x8ff0, 0x80);
        bus.write(0x9800, 0xff);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x81);
        bus.tick(252);

        assert.equal(bus.frame.pixels[0], 0xffaaaaaa);
        assert.equal(bus.frame.pixels[1], 0xffffffff);
    });

    it('renders window pixels with an internal line counter after WY changes', () => {

        const bus = createBus();

        bus.write(0x8010, 0xff);
        bus.write(0x8013, 0xff);
        bus.write(0x9c00, 1);
        bus.write(0xff47, 0xe4);
        bus.write(0xff4a, 0);
        bus.write(0xff4b, 7);
        bus.write(0xff40, 0xf1);
        bus.tick(255);
        bus.write(0xff4a, 100);
        bus.tick(456);

        assert.equal(bus.frame.pixels[0], 0xffaaaaaa);
        assert.equal(bus.frame.pixels[160], 0xff555555);
    });

    it('latches the window X trigger and accepts a next-pixel WX write', () => {

        const persistent = createBus();

        persistent.write(0x8000, 0xff);
        persistent.write(0x8010, 0x00);
        persistent.write(0x9c00, 1);
        persistent.write(0x9c01, 1);
        persistent.write(0xff42, 0);
        persistent.write(0xff47, 0xe4);
        persistent.write(0xff4a, 0);
        persistent.write(0xff4b, 7);
        persistent.write(0xff40, 0xf1);
        persistent.tick(95);
        persistent.write(0xff4b, 100);
        persistent.tick(2);

        assert.equal(persistent.frame.pixels[9], 0xffffffff);

        const triggered = createBus();

        triggered.write(0x8000, 0xff);
        triggered.write(0x8010, 0x00);
        triggered.write(0x9c00, 1);
        triggered.write(0xff42, 0);
        triggered.write(0xff47, 0xe4);
        triggered.write(0xff4a, 0);
        triggered.write(0xff4b, 100);
        triggered.write(0xff40, 0xf1);
        triggered.tick(95);
        triggered.write(0xff4b, 15);
        triggered.tick(1);

        assert.equal(triggered.frame.pixels[7], 0xffaaaaaa);
        assert.equal(triggered.frame.pixels[8], 0xffffffff);
    });

    it('distinguishes a stable DMG X+6 window match from the WX write cycle', () => {

        function prepareBus() {

            const bus = createBus();

            bus.write(0x8000, 0xff);
            bus.write(0x8010, 0xff);
            bus.write(0x8011, 0xff);
            bus.write(0x9c00, 1);
            bus.write(0xff42, 0);
            bus.write(0xff47, 0xe4);
            bus.write(0xff4a, 0);
            bus.write(0xff4b, 100);
            bus.write(0xff40, 0xf1);
            bus.tick(95);

            return bus;
        }

        const stable = prepareBus();

        stable.io[0x4b] = 14;
        stable.tick(4);
        assert.equal(stable.frame.pixels[7], 0xff000000);

        const written = prepareBus();

        written.write(0xff4b, 14);
        written.tick(4);
        assert.equal(written.frame.pixels[7], 0xffaaaaaa);
    });

    it('inserts a color-zero pixel when a pending DMG window match is disabled', () => {

        const bus = createBus();

        bus.write(0xff47, 0xe4);
        bus.write(0xff4a, 0);
        bus.write(0xff4b, 100);
        bus.write(0xff40, 0xa1);
        bus.tick(87);
        bus.write(0xff40, 0x81);
        bus.io[0x4b] = 7;
        bus.lcdFetcherState = 6;
        bus.lcdFetcherInitialPixel = 0;
        bus.lcdFetcherDataLow = 0xff;
        bus.lcdFetcherDataHigh = 0xff;
        bus.lcdBackgroundFIFO.length = 0;
        bus.lcdPixelsToDiscard = 0;
        bus.tick(1);

        assert.equal(bus.frame.pixels[0], 0xffffffff);
        assert.equal(bus.lcdBackgroundFIFO.length, 0);
    });

    it('applies CGB WX conflicts to tile, low-data and high-data fetches', () => {

        function prepareFetcher(state) {

            const bus = createBus({ model: 'cgb' });

            bus.write(0xff4a, 0);
            bus.write(0xff4b, 15);
            bus.write(0xff40, 0xe1);
            bus.tick(80);
            bus.lcdWindowYTriggered = true;
            bus.lcdWindowStartedThisLine = true;
            bus.lcdFetcherState = state;
            bus.lcdPixelX = 8;
            bus.lcdPPUPositionX = 8;
            bus.lcdBackgroundFIFO.length = 0;

            return bus;
        }

        const tile = prepareFetcher(0);

        tile.lcdFetcherTile = 0x42;
        tile.lcdFetcherAttributes = 0x81;
        tile.tick(2);
        assert.equal(tile.lcdFetcherTile, 0x42);
        assert.equal(tile.lcdFetcherAttributes, 0x81);

        const low = prepareFetcher(2);

        low.lcdFetcherDataLow = 0;
        low.lcdFetcherDataHigh = 0xa5;
        low.tick(2);
        assert.equal(low.lcdFetcherDataLow, 0xa5);

        const high = prepareFetcher(4);

        high.lcdFetcherDataLow = 0x3c;
        high.lcdFetcherDataHigh = 0;
        high.tick(2);
        assert.equal(high.lcdFetcherDataHigh, 0x3c);
    });

    it('inserts a pixel without consuming the FIFO after a started window WX match', () => {

        const bus = createBus();
        const pixel = { color: 3, palette: 0, priority: false };

        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);
        bus.tick(92);
        bus.lcdWindowStartedThisLine = true;
        bus.lcdWindowFetchActive = false;
        bus.lcdFetcherState = 0;
        bus.lcdBackgroundFIFO.length = 0;
        bus.lcdBackgroundFIFO.push(...Array(8).fill(pixel));
        bus.io[0x4b] = bus.lcdPixelX + 7;

        const outputX = bus.lcdOutputX;

        bus.tick(1);

        assert.equal(bus.frame.pixels[outputX], 0xffffffff);
        assert.equal(bus.lcdBackgroundFIFO.length, 8);
    });

    it('suppresses disabled-window insertion when LCDC disables an active fetch', () => {

        const bus = createBus();

        bus.write(0xff47, 0xe4);
        bus.write(0xff4a, 0);
        bus.write(0xff4b, 100);
        bus.write(0xff40, 0xa1);
        bus.tick(87);
        bus.lcdWindowFetchActive = true;
        bus.write(0xff40, 0x81);
        bus.io[0x4b] = 7;
        bus.lcdFetcherState = 6;
        bus.lcdFetcherInitialPixel = 0;
        bus.lcdFetcherDataLow = 0xff;
        bus.lcdFetcherDataHigh = 0xff;
        bus.lcdBackgroundFIFO.length = 0;
        bus.lcdPixelsToDiscard = 0;
        bus.tick(1);

        assert.equal(bus.frame.pixels[0], 0xff000000);
        assert.equal(bus.lcdBackgroundFIFO.length, 7);
    });

    it('advances the DMG window line at WX 166 without rendering a window pixel', () => {

        const bus = createBus();

        bus.write(0x8000, 0xff);
        bus.write(0x8010, 0xff);
        bus.write(0x8011, 0xff);
        bus.write(0x9c13, 1);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff4a, 0);
        bus.write(0xff4b, 166);
        bus.write(0xff40, 0xf1);
        bus.tick(252);

        assert.equal(bus.frame.pixels[159], 0xffaaaaaa);
        assert.equal(bus.lcdWindowStartedThisLine, false);
        assert.equal(bus.lcdWindowLine, 1);
    });

    it('pulses CGB mode-zero STAT when WX 166 starts during mode 3', () => {

        const bus = createBus({ model: 'cgb' });

        bus.write(0xff4a, 0);
        bus.write(0xff4b, 166);
        bus.write(0xff40, 0xe1);
        bus.write(0xff41, 0x08);
        bus.tick(80);
        bus.write(0xff0f, 0);
        bus.tick(171);

        assert.equal(bus.lcdWindowStartedThisLine, true);
        assert.equal(bus.interruptFlags & GAME_BOY_INTERRUPT.lcdStat, GAME_BOY_INTERRUPT.lcdStat);
    });

    it('uses the old WX value for a simultaneous CGB double-speed fetch', () => {

        function prepareBus(doubleSpeed) {

            const bus = createBus({ model: 'cgb' });

            bus.write(0xff4a, 0);
            bus.write(0xff4b, 100);
            bus.write(0xff40, 0xe1);
            bus.tick(80);

            if (doubleSpeed) {
                bus.write(0xff4d, 1);
                bus.stop();
            }

            bus.lcdWindowYTriggered = true;
            bus.lcdWindowStartedThisLine = true;
            bus.lcdFetcherState = 0;
            bus.lcdPixelX = 8;
            bus.lcdPPUPositionX = 8;
            bus.lcdBackgroundFIFO.length = 0;

            return bus;
        }

        const normal = prepareBus(false);

        normal.write(0xff4b, 15);
        normal.tick(1);
        assert.equal(normal.lcdCGBWXGlitch, true);

        const double = prepareBus(true);

        double.write(0xff4b, 15);
        double.tick(2);
        assert.equal(double.read(0xff4b), 15);
        assert.equal(double.lcdCGBWXGlitch, false);
    });

    it('includes active-window and fractional WX zero terms in CGB conflicts', () => {

        const early = createBus({ model: 'cgb' });

        early.write(0xff4a, 0);
        early.write(0xff4b, 0);
        early.write(0xff40, 0xe1);
        early.tick(80);
        assert.equal(early.lcdCGBWXGlitch, true);

        const active = createBus({ model: 'cgb' });

        active.write(0xff4a, 0);
        active.write(0xff4b, 16);
        active.write(0xff40, 0xe1);
        active.tick(80);
        active.lcdWindowYTriggered = true;
        active.lcdWindowStartedThisLine = true;
        active.lcdWindowFetchActive = true;
        active.lcdFetcherState = 0;
        active.lcdPixelX = 8;
        active.lcdPPUPositionX = 8;
        active.lcdBackgroundFIFO.length = 0;
        active.tick(1);
        assert.equal(active.lcdCGBWXGlitch, true);

        const fractional = createBus({ model: 'cgb' });

        fractional.write(0xff43, 7);
        fractional.write(0xff4a, 0);
        fractional.write(0xff4b, 0);
        fractional.write(0xff40, 0xe1);
        fractional.tick(80);
        assert.equal(fractional.lcdCGBWXGlitch, true);
    });

    it('applies DMG sprite transparency, palettes, priority and X flip', () => {

        const scenarios = [
            { name: 'opaque', flags: 0, pixel: 0, expected: 0xff000000 },
            { name: 'transparent', flags: 0, pixel: 1, expected: 0xff555555 },
            { name: 'X flip', flags: 0x20, pixel: 7, expected: 0xff000000 },
            { name: 'behind background', flags: 0x80, pixel: 0, expected: 0xff555555 },
            { name: 'object palette 1', flags: 0x10, pixel: 0, expected: 0xffaaaaaa },
        ];

        for (const scenario of scenarios) {
            const bus = createBus();

            bus.write(0x8000, 0xff);
            bus.write(0x8010, 0x80);
            bus.write(0x8011, 0x80);
            bus.write(0xfe00, 16);
            bus.write(0xfe01, 8);
            bus.write(0xfe02, 1);
            bus.write(0xfe03, scenario.flags);
            bus.write(0xff42, 0);
            bus.write(0xff47, 0xe8);
            bus.write(0xff48, 0xe4);
            bus.write(0xff49, 0x40);
            bus.write(0xff40, 0x93);
            bus.tick(300);

            assert.equal(bus.frame.pixels[scenario.pixel], scenario.expected, scenario.name);
        }
    });

    it('selects 8 by 16 sprite tiles and applies Y flip', () => {

        const scenarios = [
            { name: 'even top tile', flags: 0, expected: 0xff555555 },
            { name: 'flipped bottom row', flags: 0x40, expected: 0xffaaaaaa },
        ];

        for (const scenario of scenarios) {
            const bus = createBus();

            bus.write(0x8021, 0x80);
            bus.write(0x803e, 0x80);
            bus.write(0xfe00, 16);
            bus.write(0xfe01, 8);
            bus.write(0xfe02, 3);
            bus.write(0xfe03, scenario.flags);
            bus.write(0xff48, 0xe4);
            bus.write(0xff40, 0x86);
            bus.tick(300);

            assert.equal(bus.frame.pixels[0], scenario.expected, scenario.name);
        }
    });

    it('uses DMG X and OAM sprite priority after selecting ten sprites', () => {

        const priorityScenarios = [
            { name: 'smaller X', firstX: 9, secondX: 8, expected: 0xff555555 },
            { name: 'equal X', firstX: 8, secondX: 8, expected: 0xffaaaaaa },
        ];

        for (const scenario of priorityScenarios) {
            const bus = createBus();

            bus.write(0x8010, 0xff);
            bus.write(0x8021, 0xff);
            bus.write(0xfe00, 16);
            bus.write(0xfe01, scenario.firstX);
            bus.write(0xfe02, 1);
            bus.write(0xfe04, 16);
            bus.write(0xfe05, scenario.secondX);
            bus.write(0xfe06, 2);
            bus.write(0xff48, 0xe4);
            bus.write(0xff40, 0x82);
            bus.tick(300);

            assert.equal(bus.frame.pixels[1], scenario.expected, scenario.name);
        }

        const bus = createBus();

        bus.write(0x8010, 0xff);

        for (let index = 0; index < 10; index++) {
            bus.write(0xfe00 + index * 4, 16);
            bus.write(0xfe01 + index * 4, 0);
        }

        bus.write(0xfe28, 16);
        bus.write(0xfe29, 8);
        bus.write(0xfe2a, 1);
        bus.write(0xff48, 0xe4);
        bus.write(0xff40, 0x82);
        bus.tick(400);

        assert.equal(bus.frame.pixels[0], 0xffffffff);
    });

    it('requests STAT only on a rising combined source edge', () => {

        const bus = createBus();

        bus.write(0xff45, 0);
        bus.write(0xff40, 0x80);
        bus.write(0xff41, 0x60);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.lcdStat);

        bus.interruptFlags = 0;
        bus.tick(80);
        assert.equal(bus.read(0xff41) & 0x03, 3);
        assert.equal(bus.interruptFlags, 0);

        bus.write(0xff45, 1);
        assert.equal((bus.read(0xff41) >> 2) & 1, 0);
        bus.tick(172);
        assert.equal(bus.interruptFlags, 0);

        bus.write(0xff41, 0x08);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.lcdStat);
    });

    it('freezes LYC coincidence while the LCD is disabled', () => {

        const bus = createBus();

        bus.write(0xff41, 0x40);
        bus.write(0xff45, 0);
        bus.write(0xff40, 0x80);
        assert.equal((bus.read(0xff41) >> 2) & 1, 1);

        bus.interruptFlags = 0;
        bus.write(0xff40, 0);
        bus.write(0xff45, 1);
        assert.equal((bus.read(0xff41) >> 2) & 1, 1);
        bus.write(0xff40, 0x80);
        assert.equal((bus.read(0xff41) >> 2) & 1, 0);
        assert.equal(bus.interruptFlags, 0);

        bus.write(0xff40, 0);
        bus.write(0xff45, 0);
        bus.write(0xff40, 0x80);
        assert.equal((bus.read(0xff41) >> 2) & 1, 1);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.lcdStat);
    });

    it('raises DMG mode 2 STAT together with VBlank on line 144', () => {

        const bus = createBus();

        bus.write(0xff40, 0x80);
        bus.tick(452 + (456 * 142));
        bus.write(0xff41, 0x20);
        bus.interruptFlags = 0;
        bus.tick(456);

        assert.equal(bus.read(0xff44), 144);
        assert.equal(
            bus.interruptFlags,
            GAME_BOY_INTERRUPT.vblank | GAME_BOY_INTERRUPT.lcdStat,
        );
    });

    it('extends mode 3 by the fractional SCX value', () => {

        for (let scroll = 0; scroll < 8; scroll++) {
            const bus = createBus();

            bus.write(0xff43, scroll);
            bus.write(0xff40, 0x80);
            bus.tick(452);
            bus.tick(80);
            assert.equal(bus.read(0xff41) & 0x03, 3, `SCX ${scroll} mode 3 start`);
            bus.tick(171 + scroll);
            assert.equal(bus.read(0xff41) & 0x03, 3, `SCX ${scroll} final mode 3 cycle`);
            bus.tick(1);
            assert.equal(bus.read(0xff41) & 0x03, 0, `SCX ${scroll} HBlank start`);
        }
    });

    it('extends mode 3 by the selected sprite fetch penalties', () => {

        const scenarios = [
            { name: 'aligned sprite', positions: [0], adjustment: 8 },
            { name: 'scrolled sprite', positions: [1], scroll: 3, adjustment: 7 },
            { name: 'same tile', positions: [1, 2], adjustment: 13 },
            { name: 'same tile reversed', positions: [2, 1], adjustment: 13 },
            { name: 'separate tiles', positions: [0, 8], adjustment: 19 },
            { name: 'offscreen right', positions: [168], adjustment: -3 },
            { name: 'ten-sprite limit', positions: Array(11).fill(0), adjustment: 62 },
        ];

        for (const scenario of scenarios) {
            const bus = createBus();

            scenario.positions.forEach((position, index) => {

                bus.write(0xfe00 + index * 4, 17);
                bus.write(0xfe01 + index * 4, position);
            });
            bus.write(0xff43, scenario.scroll ?? 0);
            bus.write(0xff40, 0x82);
            bus.tick(452);
            bus.tick(251 + scenario.adjustment);
            assert.equal(bus.read(0xff41) & 0x03, 3, `${scenario.name} final mode 3 cycle`);
            bus.tick(1);
            assert.equal(bus.read(0xff41) & 0x03, 0, `${scenario.name} HBlank start`);
        }
    });

    it('extends mode 3 when the window starts on the current line', () => {

        const scenarios = [
            { name: 'left edge', windowX: 7, adjustment: 3 },
            { name: 'clipped left edge', windowX: 1, adjustment: 3 },
            { name: 'DMG WX 166 conflict', windowX: 166, adjustment: 0 },
            { name: 'offscreen right', windowX: 167, adjustment: 0 },
            { name: 'fractional scroll quirk', windowX: 0, scroll: 3, adjustment: 5 },
            { name: 'window-relative sprite', windowX: 10, spriteX: 16, adjustment: 9 },
        ];

        for (const scenario of scenarios) {
            const bus = createBus();

            if (scenario.spriteX !== undefined) {
                bus.write(0xfe00, 17);
                bus.write(0xfe01, scenario.spriteX);
            }

            bus.write(0xff43, scenario.scroll ?? 0);
            bus.write(0xff4a, 1);
            bus.write(0xff4b, scenario.windowX);
            bus.write(0xff40, scenario.spriteX === undefined ? 0xa0 : 0xa2);
            bus.tick(452);
            bus.tick(251 + scenario.adjustment);
            assert.equal(bus.read(0xff41) & 0x03, 3, `${scenario.name} final mode 3 cycle`);
            bus.tick(1);
            assert.equal(bus.read(0xff41) & 0x03, 0, `${scenario.name} HBlank start`);
        }
    });

    it('keeps the WY trigger latched after its matching line', () => {

        const bus = createBus();

        bus.write(0xff4a, 1);
        bus.write(0xff4b, 7);
        bus.write(0xff40, 0xa0);
        bus.tick(452 + 80);
        bus.write(0xff4a, 100);
        bus.tick(175);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        bus.tick(201 + 254);
        assert.equal(bus.read(0xff41) & 0x03, 3);
        bus.tick(1);
        assert.equal(bus.read(0xff41) & 0x03, 0);
    });

    it('checks WY before mode 3 and clears the trigger for the next frame', () => {

        const bus = createBus();

        bus.write(0xff4a, 100);
        bus.write(0xff4b, 7);
        bus.write(0xff40, 0xa0);
        bus.tick(452 + 40);
        bus.write(0xff4a, 1);
        bus.tick(214);
        assert.equal(bus.read(0xff41) & 0x03, 3);
        bus.tick(1);
        assert.equal(bus.read(0xff41) & 0x03, 0);

        bus.tick((456 * 153) - 255 + 251);
        assert.equal(bus.read(0xff44), 0);
        assert.equal(bus.read(0xff41) & 0x03, 3);
        bus.tick(1);
        assert.equal(bus.read(0xff41) & 0x03, 0);
    });

    it('exposes the next LY value four cycles before the next PPU line', () => {

        const bus = createBus();

        bus.write(0xff40, 0x80);
        bus.tick(452);
        bus.tick(451);
        assert.equal(bus.read(0xff44), 1);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        bus.tick(1);
        assert.equal(bus.read(0xff44), 2);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        bus.tick(4);
        assert.equal(bus.read(0xff44), 2);
        assert.equal(bus.read(0xff41) & 0x03, 2);
    });

    it('advances DIV while the LCD is disabled', () => {

        const bus = createBus();

        bus.tick(255);
        assert.equal(bus.read(0xff04), 0);
        bus.tick(1);
        assert.equal(bus.read(0xff04), 1);
        bus.tick(0x123);
        bus.write(0xff04, 0xaa);
        assert.equal(bus.read(0xff04), 0);
    });

    it('increments TIMA on the selected divider falling edge', () => {

        const periods = [1024, 16, 64, 256];

        for (let selection = 0; selection < periods.length; selection++) {
            const bus = createBus();
            const period = periods[selection];

            bus.write(0xff07, 0x04 | selection);
            bus.tick(period - 1);
            assert.equal(bus.read(0xff05), 0, `selection ${selection}`);
            bus.tick(1);
            assert.equal(bus.read(0xff05), 1, `selection ${selection}`);
        }
    });

    it('reloads TIMA four cycles after overflow and requests an interrupt', () => {

        const bus = createBus();

        bus.write(0xff06, 0x42);
        bus.write(0xff05, 0xff);
        bus.write(0xff07, 0x05);
        bus.tick(16);
        assert.equal(bus.read(0xff05), 0);
        assert.equal(bus.interruptFlags, 0);
        bus.tick(3);
        assert.equal(bus.read(0xff05), 0);
        bus.tick(1);
        assert.equal(bus.read(0xff05), 0x42);
        assert.equal(bus.interruptFlags, GAME_BOY_INTERRUPT.timer);
    });

    it('cancels a pending reload when TIMA is written', () => {

        const bus = createBus();

        bus.write(0xff06, 0x42);
        bus.write(0xff05, 0xff);
        bus.write(0xff07, 0x05);
        bus.tick(16);
        bus.write(0xff05, 0x99);
        bus.tick(4);

        assert.equal(bus.read(0xff05), 0x99);
        assert.equal(bus.interruptFlags, 0);
    });

    it('applies TIMA and TMA writes during the reloaded cycle', () => {

        const bus = createBus();

        bus.write(0xff06, 0x42);
        bus.write(0xff05, 0xff);
        bus.write(0xff07, 0x05);
        bus.tick(16);
        bus.tick(4);
        bus.write(0xff05, 0x99);
        assert.equal(bus.read(0xff05), 0x42);
        bus.write(0xff06, 0x77);
        assert.equal(bus.read(0xff05), 0x77);
        assert.equal(bus.read(0xff06), 0x77);

        bus.tick(5);
        bus.write(0xff05, 0x99);
        assert.equal(bus.read(0xff05), 0x99);
    });

    it('increments TIMA on DIV and TAC falling-edge glitches', () => {

        const dividerBus = createBus();

        dividerBus.write(0xff07, 0x05);
        dividerBus.tick(8);
        dividerBus.write(0xff04, 0);
        assert.equal(dividerBus.read(0xff05), 1);

        const controlBus = createBus();

        controlBus.write(0xff07, 0x05);
        controlBus.tick(8);
        controlBus.write(0xff07, 0);
        assert.equal(controlBus.read(0xff05), 1);
    });

    it('copies 160 OAM DMA bytes at one byte per four cycles', () => {

        const bus = createBus();

        for (let index = 0; index < 0xa0; index++) {
            bus.write(0xc000 + index, index ^ 0x5a);
        }

        bus.write(0xff46, 0xc0);
        assert.equal(bus.isOAMDMAActive, true);
        assert.equal(bus.read(0xff46), 0xc0);
        assert.equal(bus.read(0xc000), 0x5a);
        bus.write(0xff80, 0x42);
        assert.equal(bus.read(0xff80), 0x42);

        bus.tick(7);
        assert.equal(bus.read(0xc000), 0x5a);
        assert.equal(bus.oam[0], 0);
        bus.tick(1);
        assert.equal(bus.read(0xc000), 0xff);
        assert.equal(bus.oam[0], 0);
        bus.tick(4);
        assert.equal(bus.oam[0], 0x5a);
        assert.equal(bus.oamDMABytesTransferred, 1);
        bus.tick(4 * 159);

        assert.equal(bus.isOAMDMAActive, false);
        assert.equal(bus.oamDMABytesTransferred, 0xa0);
        assert.equal(bus.read(0xc000), 0x5a);

        for (let index = 0; index < 0xa0; index++) {
            assert.equal(bus.oam[index], index ^ 0x5a);
        }
    });

    it('restarts OAM DMA and mirrors high source pages on DMG', () => {

        const bus = createBus();

        for (let index = 0; index < 0xa0; index++) {
            bus.write(0xc000 + index, 0x11);
            bus.write(0xd000 + index, index);
        }

        bus.write(0xff46, 0xc0);
        bus.tick(8 + 4 * 10);
        assert.equal(bus.oamDMABytesTransferred, 10);
        bus.write(0xff46, 0xd0);
        assert.equal(bus.oamDMABytesTransferred, 10);
        bus.tick(8);
        assert.equal(bus.oamDMABytesTransferred, 0);
        bus.tick(4 * 160);

        for (let index = 0; index < 0xa0; index++) {
            assert.equal(bus.oam[index], index);
        }

        bus.write(0xff46, 0xe0);
        bus.tick(8 + 4 * 160);

        for (let index = 0; index < 0xa0; index++) {
            assert.equal(bus.oam[index], 0x11);
        }
    });

    it('delays fresh DMA bus blocking while a restarted transfer remains blocked', () => {

        const bus = createBus();

        bus.oam[0] = 0x42;
        bus.write(0xff46, 0xc0);
        assert.equal(bus.read(0xfe00), 0x42);
        bus.tick(4);
        assert.equal(bus.read(0xfe00), 0x42);
        bus.tick(4);
        assert.equal(bus.read(0xfe00), 0xff);

        bus.write(0xff46, 0xd0);
        assert.equal(bus.read(0xfe00), 0xff);
        bus.tick(4);
        assert.equal(bus.read(0xfe00), 0xff);
        bus.tick(4);
        assert.equal(bus.read(0xfe00), 0xff);
        assert.equal(bus.oamDMABytesTransferred, 0);
    });
});
