import {
    parseGameBoyHeader,
    type GameBoyCartridgeHeader,
} from './header.js';
import type {
    GameBoyCartridge,
    GameBoyCartridgeOptions,
} from './base.js';
import {
    MBC1Cartridge,
    MBC2Cartridge,
    MBC3Cartridge,
    MBC5Cartridge,
    ROMCartridge,
} from './mappers.js';

export * from './base.js';

export class UnsupportedMapperError extends Error {

    constructor(header: GameBoyCartridgeHeader) {

        super(`Cartridge mapper ${header.cartridgeType.name} is recognized but not implemented.`);
        this.name = 'UnsupportedMapperError';
    }
}

export function createGameBoyCartridge(
    rom: Uint8Array,
    options: GameBoyCartridgeOptions = {},
): GameBoyCartridge {

    const header = parseGameBoyHeader(rom, { strict: options.strictHeader !== false });

    switch (header.cartridgeType.mapper) {
        case 'rom':
            return new ROMCartridge(rom, header, options.onRAMWrite);
        case 'mbc1':
            return new MBC1Cartridge(rom, header, options.onRAMWrite);
        case 'mbc2':
            return new MBC2Cartridge(rom, header, options.onRAMWrite);
        case 'mbc3':
            return new MBC3Cartridge(rom, header, options);
        case 'mbc5':
            return new MBC5Cartridge(rom, header, options);
        default:
            throw new UnsupportedMapperError(header);
    }
}
