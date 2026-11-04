import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DMGBus,
    GAME_BOY_LOGO,
    SM83CPU,
    calculateGameBoyHeaderChecksum,
    createGameBoyCartridge,
} from '../../dist/index.mjs';

function createCGBROM() {

    const rom = new Uint8Array(0x8000);

    rom.set(GAME_BOY_LOGO, 0x0104);
    rom.set([0x43, 0x47, 0x42], 0x0134);
    rom[0x0143] = 0xc0;
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    return rom;
}

function createDMGROM() {

    const rom = createCGBROM();

    rom[0x0143] = 0;
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    return rom;
}

function createCGBBus(options = {}) {

    return new DMGBus({
        model: 'cgb',
        cartridge: createGameBoyCartridge(createCGBROM()),
        ...options,
    });
}

describe('CGB bus', () => {

    it('defaults to CGB-C and validates revision selection', () => {

        assert.equal(createCGBBus().cgbRevision, 'c');
        assert.throws(
            () => new DMGBus({
                cartridge: createGameBoyCartridge(createDMGROM()),
                cgbRevision: 'e',
            }),
            /CGB revision requires the CGB hardware model/,
        );
    });

    it('mirrors extra OAM according to the selected CGB revision', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0xfea0, 0x12);
            bus.write(0xfec3, 0x34);
            assert.equal(bus.read(0xfea8), 0x12);
            assert.equal(bus.read(0xfeb0), 0x12);
            assert.equal(bus.read(0xfedb), 0x34);
        }

        const revisionD = createCGBBus({ cgbRevision: 'd' });

        revisionD.write(0xfea0, 0x12);
        revisionD.write(0xfec3, 0x34);
        assert.equal(revisionD.read(0xfea0), 0x12);
        assert.equal(revisionD.read(0xfea8), 0);
        assert.equal(revisionD.read(0xfed3), 0x34);
        assert.equal(revisionD.read(0xfef3), 0x34);

        const revisionE = createCGBBus({ cgbRevision: 'e' });

        revisionE.write(0xfea0, 0x12);
        assert.equal(revisionE.read(0xfea0), 0xaa);
        assert.equal(revisionE.read(0xfeb5), 0xbb);
        assert.equal(revisionE.read(0xfecf), 0xcc);
        assert.equal(revisionE.read(0xfeff), 0xff);
    });

    it('applies the CGB-E infrared register read mask', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c', 'd']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0xff56, 0);
            assert.equal(bus.read(0xff56), 0x3e);
            bus.write(0xff56, 0xff);
            assert.equal(bus.read(0xff56), 0xff);
        }

        const revisionE = createCGBBus({ cgbRevision: 'e' });

        revisionE.write(0xff56, 0);
        assert.equal(revisionE.read(0xff56), 0x2e);
        revisionE.write(0xff56, 0xff);
        assert.equal(revisionE.read(0xff56), 0xef);
    });

    it('latches fetcher Y on CGB-D and newer revisions', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c', 'd', 'e']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0xff42, 0);
            bus.write(0xff40, 0x91);
            bus.tick(81);
            bus.write(0xff42, 1);
            bus.tick(1);

            const cachesFetcherY = cgbRevision === 'd' || cgbRevision === 'e';

            assert.equal(bus.lcdFetcherTileDataAddress, cachesFetcherY ? 0 : 2, cgbRevision);
        }
    });

    it('keeps OAM read-blocked for the first HBlank cycle on CGB-D and newer', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c', 'd', 'e']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0xfe00, 0x12);
            bus.write(0xff40, 0x80);
            bus.tick(452 + 252);

            const blocksFirstHBlankCycle = cgbRevision === 'd' || cgbRevision === 'e';

            assert.equal(bus.read(0xff41) & 0x03, 0, cgbRevision);
            assert.equal(bus.read(0xfe00), blocksFirstHBlankCycle ? 0xff : 0x12, cgbRevision);
            bus.tick(1);
            assert.equal(bus.read(0xfe00), 0x12, cgbRevision);
        }
    });

    it('uses revision-specific LY and LYC phases on line 153', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c', 'd', 'e']) {
            const bus = createCGBBus({ cgbRevision });
            const lateTiming = cgbRevision === 'd' || cgbRevision === 'e';

            bus.write(0xff45, 153);
            bus.write(0xff40, 0x80);
            bus.tick(452 + (456 * 152));

            assert.equal(bus.lcdLine, 153, cgbRevision);
            assert.equal(bus.read(0xff44), 152, cgbRevision);
            assert.equal((bus.read(0xff41) >> 2) & 1, 0, cgbRevision);

            bus.tick(2);
            assert.equal(bus.read(0xff44), 153, cgbRevision);
            assert.equal((bus.read(0xff41) >> 2) & 1, 0, cgbRevision);

            bus.tick(2);
            assert.equal((bus.read(0xff41) >> 2) & 1, lateTiming ? 1 : 0, cgbRevision);

            bus.tick(2);
            assert.equal(bus.read(0xff44), lateTiming ? 153 : 0, cgbRevision);
            assert.equal((bus.read(0xff41) >> 2) & 1, 1, cgbRevision);

            bus.tick(2);
            assert.equal(bus.read(0xff44), 0, cgbRevision);
            assert.equal((bus.read(0xff41) >> 2) & 1, lateTiming ? 1 : 0, cgbRevision);

            bus.tick(4);
            assert.equal((bus.read(0xff41) >> 2) & 1, 0, cgbRevision);
        }
    });

    it('applies the CGB-D tile-select conflict during a tile-data fetch', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c', 'd', 'e']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0x8000, 0xaa);
            bus.write(0xff40, 0x91);
            bus.tick(82);
            bus.write(0xff40, 0x81);
            bus.tick(1);

            assert.equal(bus.lcdFetcherDataLow, cgbRevision === 'd' ? 0xaa : 0, cgbRevision);
        }
    });

    it('lets only CGB-E search OAM while DMA is halted', () => {

        for (const cgbRevision of ['0', 'a', 'b', 'c', 'd', 'e']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0xfe00, 17);
            bus.write(0xfe01, 8);
            bus.write(0xff40, 0x82);
            bus.tick(452);
            bus.dmaActive = true;
            bus.setCPUPaused(true);
            bus.tick(80);

            assert.deepEqual(bus.lcdLineSprites, cgbRevision === 'e' ? [0] : [], cgbRevision);
        }
    });

    it('applies revision-specific VRAM reads on the first HBlank cycle', () => {

        for (const cgbRevision of ['c', 'd', 'e']) {
            const bus = createCGBBus({ cgbRevision });

            bus.write(0x8000, 0x11);
            bus.write(0x8001, 0x44);
            bus.write(0x9800, 0x22);
            assert.equal(bus.read(0x8001), 0x44);
            bus.write(0xff40, 0x80);
            bus.tick(452 + 252);
            bus.lcdFetcherMapAddress = 0x1800;
            bus.lcdFetcherTileDataAddress = 0x0000;

            assert.equal(bus.read(0x9000), cgbRevision === 'c' ? 0 : 0x22, cgbRevision);

            bus.lcdFetcherTileDataAddress = 0x1000;
            assert.equal(bus.read(0x8000), cgbRevision === 'c' ? 0x44 : 0x22, cgbRevision);

            if (cgbRevision === 'e') {
                assert.equal(bus.read(0x8000), 0x11);
            }
        }
    });

    it('ignores writes to unmapped CGB IO addresses', () => {

        const bus = createCGBBus();

        for (const address of [0xff03, 0xff08, 0xff15, 0xff1f, 0xff27, 0xff4e, 0xff57, 0xff67, 0xff6d, 0xff71, 0xff78, 0xff7f]) {
            bus.write(address, 0);
            assert.equal(bus.read(address), 0xff);
        }
    });

    it('exposes hardware CGB power-on and write-only register values', () => {

        const bus = createCGBBus();

        assert.equal(bus.read(0xff42), 0);
        assert.equal(bus.read(0xff50), 0xff);
        assert.equal(bus.read(0xff72), 0);
        assert.equal(bus.read(0xff73), 0);
        assert.equal(bus.read(0xff75), 0x8f);

        for (let address = 0xff51; address <= 0xff54; address++) {
            bus.write(address, 0x12);
            assert.equal(bus.read(address), 0xff);
        }

        bus.write(0xff42, 0x12);
        bus.write(0xff72, 0x34);
        bus.write(0xff73, 0x56);
        bus.write(0xff75, 0x20);
        bus.reset();

        assert.equal(bus.read(0xff42), 0);
        assert.equal(bus.read(0xff72), 0);
        assert.equal(bus.read(0xff73), 0);
        assert.equal(bus.read(0xff75), 0x8f);
    });

    it('selects CGB or DMG compatibility mode from the cartridge without a boot ROM', () => {

        const color = createCGBBus();
        const compatible = createCGBBus({
            cartridge: createGameBoyCartridge(createDMGROM()),
        });

        assert.equal(color.isCGBMode, true);
        assert.equal(compatible.isCGBMode, false);
        assert.equal(compatible.read(0xff4c), 0xff);
        compatible.write(0xff4c, 0);
        assert.equal(compatible.isCGBMode, false);
    });

    it('lets KEY0 select compatibility mode only until FF50 locks it', () => {

        const bootROM = new Uint8Array(0x0900);
        const bus = createCGBBus({ bootROM });

        assert.equal(bus.isCGBMode, true);
        bus.write(0xff4f, 1);
        bus.write(0xff4c, 0x04);
        assert.equal(bus.isCGBMode, false);
        assert.equal(bus.read(0xff4f), 0xff);
        bus.write(0xff4c, 0);
        assert.equal(bus.isCGBMode, true);
        bus.write(0xff4c, 0x0c);
        bus.write(0xff50, 1);
        bus.write(0xff4c, 0);

        assert.equal(bus.isCGBMode, false);
        assert.equal(bus.read(0xff4c), 0xff);

        bus.reset();
        assert.equal(bus.isCGBMode, true);
        assert.equal(bus.isBootROMMapped, true);
    });

    it('applies KEY0 mode gates to OPRI and undocumented CGB registers', () => {

        const bootROM = new Uint8Array(0x0900);
        const bus = createCGBBus({ bootROM });

        bus.write(0xff4c, 0x04);
        bus.write(0xff6c, 1);
        bus.write(0xff72, 0x12);
        bus.write(0xff73, 0x34);
        bus.write(0xff74, 0x56);
        bus.write(0xff75, 0x20);
        bus.write(0xff50, 1);
        bus.write(0xff6c, 0);

        assert.equal(bus.read(0xff6c), 0xff);
        assert.equal(bus.io[0x6c] & 1, 1);
        assert.equal(bus.read(0xff72), 0x12);
        assert.equal(bus.read(0xff73), 0x34);
        assert.equal(bus.read(0xff74), 0xff);
        assert.equal(bus.read(0xff75), 0xaf);

        const pgb = createCGBBus({ bootROM });

        pgb.write(0xff4c, 0x08);
        pgb.write(0xff50, 1);
        pgb.write(0xff6c, 1);
        assert.equal(pgb.read(0xff6c), 0xff);
        assert.equal(pgb.io[0x6c] & 1, 1);
    });

    it('gates CGB-only registers after entering DMG compatibility mode', () => {

        const bus = createCGBBus({
            cartridge: createGameBoyCartridge(createDMGROM()),
        });

        bus.write(0xc000, 0xaa);
        bus.write(0xff4d, 1);
        bus.write(0xff4f, 1);
        bus.write(0xff51, 0xc0);
        bus.write(0xff55, 0);
        bus.write(0xff69, 0x1f);
        bus.write(0xff70, 2);

        assert.equal(bus.read(0xff4d), 0xff);
        assert.equal(bus.stop(), false);
        assert.equal(bus.read(0xff4f), 0xfe);
        assert.equal(bus.read(0xff55), 0xff);
        assert.equal(bus.read(0xff69), 0xff);
        assert.equal(bus.read(0xff70), 0xff);
        assert.equal(bus.vram[0], 0);

        bus.write(0xff68, 0x85);
        assert.equal(bus.read(0xff68), 0xc5);
        assert.equal(bus.read(0xff76), 0);

        bus.write(0xff01, 0);
        bus.write(0xff02, 0x83);
        bus.tick(128);
        assert.equal((bus.read(0xff02) >> 7) & 1, 1);
        bus.tick(3968);
        assert.equal((bus.read(0xff02) >> 7) & 1, 0);
    });

    it('renders CGB hardware in compatibility mode with DMG tile and palette rules', () => {

        const bus = createCGBBus({
            cartridge: createGameBoyCartridge(createDMGROM()),
        });

        bus.write(0x8000, 0x80);
        bus.vram[0x3800] = 0x89;
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);
        bus.tick(92);

        assert.equal(bus.frame.pixels[0], 0xffaaaaaa);
    });

    it('keeps boot-loaded CGB palettes for DMG compatibility rendering', () => {

        const bus = createCGBBus({ bootROM: new Uint8Array(0x0900) });

        bus.write(0xff68, 0x82);
        bus.write(0xff69, 0x1f);
        bus.write(0xff69, 0x00);
        bus.write(0xff4c, 0x04);
        bus.write(0xff50, 1);
        bus.write(0x8000, 0x80);
        bus.write(0xff42, 0);
        bus.write(0xff47, 0xe4);
        bus.write(0xff40, 0x91);
        bus.tick(92);

        assert.equal(bus.read(0xff69), 0xff);
        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('banks VRAM and WRAM through VBK and SVBK', () => {

        const bus = createCGBBus();

        assert.equal(bus.model, 'cgb');
        assert.equal(bus.read(0xff4f), 0xfe);
        assert.equal(bus.read(0xff70), 0xf9);

        bus.write(0x8000, 0x11);
        bus.write(0xff4f, 1);
        bus.write(0x8000, 0x22);
        assert.equal(bus.read(0x8000), 0x22);
        bus.write(0xff4f, 0);
        assert.equal(bus.read(0x8000), 0x11);

        bus.write(0xc000, 0x30);
        bus.write(0xd000, 0x41);
        bus.write(0xff70, 2);
        bus.write(0xd000, 0x42);
        assert.equal(bus.read(0xc000), 0x30);
        assert.equal(bus.read(0xd000), 0x42);
        bus.write(0xff70, 1);
        assert.equal(bus.read(0xd000), 0x41);
        bus.write(0xff70, 0);
        assert.equal(bus.read(0xff70), 0xf9);
        assert.equal(bus.read(0xd000), 0x41);
    });

    it('renders CGB tile attributes and RGB555 palettes', () => {

        const bus = createCGBBus();

        bus.write(0xff4f, 1);
        bus.write(0x8000, 0x80);
        bus.write(0x9800, 0x0a);
        bus.write(0xff4f, 0);

        bus.write(0xff68, 0x92);
        bus.write(0xff69, 0x1f);
        bus.write(0xff69, 0x00);
        assert.equal(bus.read(0xff68), 0xd4);

        bus.write(0xff42, 0);
        bus.write(0xff40, 0x91);
        bus.tick(92);

        assert.equal(bus.frame.pixels[0], 0xffff0000);
    });

    it('blocks CGB palette data in mode 3 while auto-incrementing its index', () => {

        const bus = createCGBBus();

        bus.write(0xff68, 0x80);
        bus.write(0xff69, 0x12);
        bus.write(0xff68, 0x80);
        bus.write(0xff40, 0x80);
        bus.tick(80);

        assert.equal(bus.read(0xff69), 0xff);
        bus.write(0xff69, 0x34);
        assert.equal(bus.read(0xff68), 0xc1);

        bus.write(0xff40, 0);
        bus.write(0xff68, 0);
        assert.equal(bus.read(0xff69), 0x12);
        bus.write(0xff68, 1);
        assert.equal(bus.read(0xff69), 0);
    });

    it('masks OPRI and disables CGB background priority through LCDC bit 0', () => {

        const bus = createCGBBus();

        bus.write(0xff6c, 0xff);
        assert.equal(bus.read(0xff6c), 0xff);
        bus.write(0xff6c, 0);
        assert.equal(bus.read(0xff6c), 0xfe);

        bus.write(0x8000, 0x80);
        bus.write(0xfe00, 16);
        bus.write(0xfe01, 8);
        bus.write(0xfe02, 0);
        bus.write(0xfe03, 0);
        bus.write(0xff4f, 1);
        bus.write(0x9800, 0x80);
        bus.write(0xff4f, 0);
        bus.write(0xff68, 0x82);
        bus.write(0xff69, 0x1f);
        bus.write(0xff69, 0);
        bus.write(0xff6a, 0x82);
        bus.write(0xff6b, 0xe0);
        bus.write(0xff6b, 0x03);
        bus.write(0xff40, 0x92);
        bus.tick(100);

        assert.equal(bus.frame.pixels[0], 0xff00ff00);
    });

    it('switches CGB CPU speed through KEY1 and STOP', () => {

        const bootROM = new Uint8Array(0x0900);

        bootROM.set([0x10, 0x00, 0x00]);

        const bus = createCGBBus({ bootROM });
        const cpu = new SM83CPU(bus);

        assert.equal(bus.read(0xff4d), 0x7e);
        bus.tick(256);
        assert.equal(bus.read(0xff04), 1);
        bus.write(0xff4d, 1);
        assert.equal(bus.read(0xff4d), 0x7f);
        assert.equal(cpu.step(), 4);
        assert.equal(cpu.isStopped, false);
        assert.equal(bus.read(0xff4d), 0xfe);
        assert.equal(bus.read(0xff04), 0);

        bus.write(0xff40, 0x80);
        bus.tick(151);
        assert.equal(bus.read(0xff41) & 0x03, 0);
        bus.tick(1);
        assert.equal(bus.read(0xff41) & 0x03, 3);
    });

    it('runs the CGB fast internal serial clock', () => {

        const incomingBits = [1, 0, 1, 0, 0, 1, 0, 1];
        const outgoingBits = [];
        const bus = createCGBBus({
            serialEndpoint: {
                exchangeBit(outgoingBit) {

                    outgoingBits.push(outgoingBit);

                    return incomingBits.shift();
                },
            },
        });

        bus.write(0xff01, 0x3c);
        bus.write(0xff02, 0x83);
        bus.tick(127);
        assert.equal((bus.read(0xff02) >> 7) & 1, 1);
        bus.tick(1);

        assert.deepEqual(outgoingBits, [0, 0, 1, 1, 1, 1, 0, 0]);
        assert.equal(bus.read(0xff01), 0xa5);
        assert.equal(bus.read(0xff02), 0x7f);
        assert.equal(bus.interruptFlags, 0x08);
    });

    it('exposes the four CGB PCM channel amplitudes', () => {

        const bus = createCGBBus();

        bus.write(0xff26, 0x80);
        bus.write(0xff11, 0x40);
        bus.write(0xff12, 0xf0);
        bus.write(0xff13, 0xff);
        bus.write(0xff14, 0x87);
        bus.tick(12);
        bus.write(0xff11, 0xc0);
        bus.write(0xff30, 0xf0);
        bus.write(0xff31, 0xf0);
        bus.write(0xff1a, 0x80);
        bus.write(0xff1c, 0x20);
        bus.write(0xff1d, 0xff);
        bus.write(0xff1e, 0x87);
        bus.tick(10);

        assert.equal(bus.read(0xff76), 0x0f);
        assert.equal(bus.read(0xff77), 0x0f);
        bus.write(0xff76, 0xff);
        assert.equal(bus.read(0xff76), 0x0f);
    });

    it('copies CGB general and HBlank DMA blocks to the selected VRAM bank', () => {

        const bus = createCGBBus();

        for (let index = 0; index < 0x40; index++) {
            bus.write(0xc000 + index, 0x80 + index);
        }

        bus.write(0xff4f, 1);
        bus.write(0xff51, 0xc0);
        bus.write(0xff52, 0x00);
        bus.write(0xff53, 0x00);
        bus.write(0xff54, 0x00);
        bus.write(0xff55, 0x01);
        assert.equal(bus.read(0xff55), 0xff);
        assert.deepEqual(
            [...bus.vram.slice(0x2000, 0x2020)],
            Array.from({ length: 0x20 }, (_, index) => 0x80 + index),
        );

        bus.write(0xff51, 0xc0);
        bus.write(0xff52, 0x20);
        bus.write(0xff53, 0x00);
        bus.write(0xff54, 0x20);
        bus.write(0xff40, 0x80);
        bus.write(0xff55, 0x81);
        assert.equal(bus.read(0xff55), 0x01);

        bus.tick(252);
        assert.equal(bus.read(0xff55), 0x00);
        assert.deepEqual(
            [...bus.vram.slice(0x2020, 0x2030)],
            Array.from({ length: 0x10 }, (_, index) => 0xa0 + index),
        );

        bus.tick(456);
        assert.equal(bus.read(0xff55), 0xff);
        assert.deepEqual(
            [...bus.vram.slice(0x2030, 0x2040)],
            Array.from({ length: 0x10 }, (_, index) => 0xb0 + index),
        );

        bus.write(0xff51, 0xc0);
        bus.write(0xff52, 0x00);
        bus.write(0xff53, 0x00);
        bus.write(0xff54, 0x40);
        bus.write(0xff55, 0x82);
        assert.equal(bus.read(0xff55), 0x01);
        assert.deepEqual(
            [...bus.vram.slice(0x2040, 0x2050)],
            Array.from({ length: 0x10 }, (_, index) => 0x80 + index),
        );

        bus.write(0xff55, 0);
        assert.equal(bus.read(0xff55), 0x81);
    });

    it('charges exact normal- and double-speed CPU stalls for general DMA', () => {

        for (const scenario of [
            { name: 'normal speed', doubleSpeed: false, expectedCycles: 68 },
            { name: 'double speed', doubleSpeed: true, expectedCycles: 132 },
        ]) {
            const bus = createCGBBus();
            const cpu = new SM83CPU(bus);

            if (scenario.doubleSpeed) {
                bus.write(0xff4d, 1);
                bus.stop();
            }

            bus.write(0xff51, 0xc0);
            bus.write(0xff52, 0x00);
            bus.write(0xff53, 0x00);
            bus.write(0xff54, 0x00);
            bus.write(0xff55, 0x01);

            assert.equal(cpu.step(), scenario.expectedCycles, scenario.name);
            assert.equal(cpu.cycles, scenario.expectedCycles, scenario.name);
            assert.equal(cpu.step(), 4, `${scenario.name} consumes the stall once`);
        }
    });

    it('starts a general DMA stall after the FF55 write instruction completes', () => {

        const rom = createCGBROM();

        rom.set([
            0x3e, 0x00,
            0xe0, 0x55,
            0x00,
        ]);

        const bus = createCGBBus({ cartridge: createGameBoyCartridge(rom) });
        const cpu = new SM83CPU(bus);

        bus.write(0xff51, 0xc0);
        bus.write(0xff52, 0x00);
        bus.write(0xff53, 0x00);
        bus.write(0xff54, 0x00);

        assert.equal(cpu.step(), 8);
        assert.equal(cpu.step(), 12);
        assert.equal(cpu.cycles, 20);
        assert.equal(cpu.step(), 36);
        assert.equal(cpu.registers.pc, 5);
        assert.equal(cpu.cycles, 56);
    });

    it('charges each HBlank DMA block once while advancing exactly 32 LCD dots', () => {

        for (const scenario of [
            { name: 'normal speed', doubleSpeed: false, expectedCycles: 36 },
            { name: 'double speed', doubleSpeed: true, expectedCycles: 68 },
        ]) {
            const bus = createCGBBus();
            const cpu = new SM83CPU(bus);

            if (scenario.doubleSpeed) {
                bus.write(0xff4d, 1);
                bus.stop();
            }

            bus.write(0xff40, 0x80);
            bus.write(0xff51, 0xc0);
            bus.write(0xff52, 0x00);
            bus.write(0xff53, 0x00);
            bus.write(0xff54, 0x00);
            bus.write(0xff55, 0x81);
            bus.tick(scenario.doubleSpeed ? 504 : 252);

            const lineCycles = bus.lcdLineCycles;

            assert.equal(bus.read(0xff55), 0x00, scenario.name);
            assert.equal(cpu.step(), scenario.expectedCycles, scenario.name);
            assert.equal(bus.lcdLineCycles - lineCycles, 32 + (scenario.doubleSpeed ? 2 : 4), scenario.name);
            assert.equal(cpu.step(), 4, `${scenario.name} consumes the block stall once`);
        }
    });

    it('pauses HBlank DMA while the CPU is halted and resumes it on wake', () => {

        const rom = createCGBROM();

        rom[0] = 0x76;

        const bus = createCGBBus({ cartridge: createGameBoyCartridge(rom) });
        const cpu = new SM83CPU(bus);

        bus.write(0xff40, 0x80);
        bus.write(0xff51, 0xc0);
        bus.write(0xff52, 0x00);
        bus.write(0xff53, 0x00);
        bus.write(0xff54, 0x00);
        bus.write(0xff55, 0x81);
        bus.tick(80);

        assert.equal(cpu.step(), 4);
        assert.equal(cpu.isHalted, true);
        bus.tick(168);
        assert.equal(bus.read(0xff55), 0x01);

        bus.enabledInterrupts = 1;
        bus.interruptFlags = 1;

        assert.equal(cpu.step(), 36);
        assert.equal(cpu.isHalted, false);
        assert.equal(bus.read(0xff55), 0x00);
        assert.equal(cpu.step(), 4);
    });
});
