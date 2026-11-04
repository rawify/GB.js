import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GAME_BOY_ADVANCE_LOGO,
    GAME_BOY_LOGO,
    calculateGameBoyAdvanceHeaderChecksum,
    calculateGameBoyGlobalChecksum,
    calculateGameBoyHeaderChecksum,
    detectROM,
    parseGameBoyAdvanceHeader,
    parseGameBoyHeader,
    parseROMHeader,
} from '../../dist/index.mjs';

function writeASCII(target, offset, text) {

    for (let index = 0; index < text.length; index++) {
        target[offset + index] = text.charCodeAt(index);
    }
}

function createGameBoyROM(cgbFlag = 0x00) {

    const rom = new Uint8Array(32 * 1024);

    rom.set(GAME_BOY_LOGO, 0x0104);
    writeASCII(rom, 0x0134, cgbFlag === 0 ? 'TEST GAME' : 'COLOR TEST');
    rom[0x0143] = cgbFlag;
    rom[0x0147] = 0x03;
    rom[0x0148] = 0x00;
    rom[0x0149] = 0x03;
    rom[0x014a] = 0x01;
    rom[0x014b] = 0x01;
    rom[0x014d] = calculateGameBoyHeaderChecksum(rom);

    const globalChecksum = calculateGameBoyGlobalChecksum(rom);

    rom[0x014e] = globalChecksum >> 8;
    rom[0x014f] = globalChecksum & 0xff;

    return rom;
}

function createGameBoyAdvanceROM() {

    const rom = new Uint8Array(1024 * 1024);

    rom[0x0003] = 0xea;
    rom.set(GAME_BOY_ADVANCE_LOGO, 0x0004);
    writeASCII(rom, 0x00a0, 'ADVANCE TEST');
    writeASCII(rom, 0x00ac, 'ATSE');
    writeASCII(rom, 0x00b0, '01');
    rom[0x00b2] = 0x96;
    rom[0x00bd] = calculateGameBoyAdvanceHeaderChecksum(rom);

    return rom;
}

describe('Game Boy cartridge headers', () => {

    it('parses and validates a DMG cartridge header', () => {

        const header = parseGameBoyHeader(createGameBoyROM());

        assert.equal(header.title, 'TEST GAME');
        assert.equal(header.compatibility, 'dmg');
        assert.equal(header.cartridgeType.mapper, 'mbc1');
        assert.equal(header.cartridgeType.hasBattery, true);
        assert.equal(header.romSize, 32 * 1024);
        assert.equal(header.ramSize, 32 * 1024);
        assert.equal(header.headerChecksumValid, true);
        assert.equal(header.globalChecksumValid, true);
    });

    it('detects CGB-compatible cartridges', () => {

        const detected = parseROMHeader(createGameBoyROM(0x80));

        assert.equal(detected.model, 'cgb');
        assert.equal(detected.header.platform, 'gb');
        assert.equal(detected.header.compatibility, 'dual');
    });

    it('rejects a damaged header in strict mode', () => {

        const rom = createGameBoyROM();

        rom[0x0134] ^= 0xff;

        assert.throws(() => parseGameBoyHeader(rom), /checksum/i);
        assert.equal(parseGameBoyHeader(rom, { strict: false }).headerChecksumValid, false);
    });
});

describe('Game Boy Advance cartridge headers', () => {

    it('parses and validates a GBA cartridge header', () => {

        const header = parseGameBoyAdvanceHeader(createGameBoyAdvanceROM());

        assert.equal(header.title, 'ADVANCE TEST');
        assert.equal(header.gameCode, 'ATSE');
        assert.equal(header.makerCode, '01');
        assert.equal(header.entryPointValid, true);
        assert.equal(header.logoValid, true);
        assert.equal(header.fixedValueValid, true);
        assert.equal(header.headerChecksumValid, true);
    });

    it('rejects a damaged logo in strict mode', () => {

        const rom = createGameBoyAdvanceROM();

        rom[0x0004] ^= 0xff;

        assert.throws(() => parseGameBoyAdvanceHeader(rom), /logo/i);
        assert.equal(detectROM(rom), null);
    });

    it('detects GBA ROMs without relying on a filename', () => {

        const detected = detectROM(createGameBoyAdvanceROM());

        assert.equal(detected?.model, 'gba');
        assert.equal(detected?.header.platform, 'gba');
    });
});
