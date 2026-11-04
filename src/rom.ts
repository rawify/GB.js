import {
    GAME_BOY_LOGO,
    parseGameBoyHeader,
    type GameBoyCartridgeHeader,
} from './gb/cartridge/header.js';
import {
    GAME_BOY_ADVANCE_LOGO,
    parseGameBoyAdvanceHeader,
    type GameBoyAdvanceCartridgeHeader,
} from './gba/cartridge/header.js';

export type CartridgeHeader = GameBoyCartridgeHeader | GameBoyAdvanceCartridgeHeader;

export interface DetectedROM {
    readonly model: 'dmg' | 'cgb' | 'gba';
    readonly header: CartridgeHeader;
}

function bytesEqual(data: Uint8Array, offset: number, expected: readonly number[]): boolean {

    return expected.every((value, index) => data[offset + index] === value);
}

export function detectROM(rom: Uint8Array): DetectedROM | null {

    if (rom.length >= 0x0150 && bytesEqual(rom, 0x0104, GAME_BOY_LOGO)) {
        const header = parseGameBoyHeader(rom, { strict: false });

        return {
            model: header.compatibility === 'dmg' ? 'dmg' : 'cgb',
            header,
        };
    }

    if (
        rom.length >= 0x00c0
        && rom[0x0003] === 0xea
        && rom[0x00b2] === 0x96
        && bytesEqual(rom, 0x0004, GAME_BOY_ADVANCE_LOGO)
    ) {
        return {
            model: 'gba',
            header: parseGameBoyAdvanceHeader(rom, { strict: false }),
        };
    }

    return null;
}

export function parseROMHeader(rom: Uint8Array): DetectedROM {

    const detected = detectROM(rom);

    if (detected === null) {
        throw new TypeError('The data is not a recognized Game Boy, Game Boy Color, or Game Boy Advance ROM.');
    }

    if (detected.header.platform === 'gb') {
        return {
            model: detected.model,
            header: parseGameBoyHeader(rom),
        };
    }

    return {
        model: 'gba',
        header: parseGameBoyAdvanceHeader(rom),
    };
}
