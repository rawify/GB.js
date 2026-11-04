export const GAME_BOY_LOGO: readonly number[] = [
    0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b,
    0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
    0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
    0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
    0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc,
    0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

export type GameBoyMapper
    = | 'rom'
    | 'mbc1'
    | 'mbc2'
    | 'mmm01'
    | 'mbc3'
    | 'mbc5'
    | 'mbc6'
    | 'mbc7'
    | 'camera'
    | 'tama5'
    | 'huc3'
    | 'huc1';

export interface GameBoyCartridgeType {
    readonly code: number;
    readonly name: string;
    readonly mapper: GameBoyMapper;
    readonly hasRAM: boolean;
    readonly hasBattery: boolean;
    readonly hasTimer: boolean;
    readonly hasRumble: boolean;
    readonly hasSensor: boolean;
}

function cartridgeType(
    code: number,
    name: string,
    mapper: GameBoyMapper,
    features: Partial<Omit<GameBoyCartridgeType, 'code' | 'name' | 'mapper'>> = {},
): GameBoyCartridgeType {

    return {
        code,
        name,
        mapper,
        hasRAM: false,
        hasBattery: false,
        hasTimer: false,
        hasRumble: false,
        hasSensor: false,
        ...features,
    };
}

export const GAME_BOY_CARTRIDGE_TYPES: Readonly<Record<number, GameBoyCartridgeType>> = {
    0x00: cartridgeType(0x00, 'ROM ONLY', 'rom'),
    0x01: cartridgeType(0x01, 'MBC1', 'mbc1'),
    0x02: cartridgeType(0x02, 'MBC1+RAM', 'mbc1', { hasRAM: true }),
    0x03: cartridgeType(0x03, 'MBC1+RAM+BATTERY', 'mbc1', { hasRAM: true, hasBattery: true }),
    0x05: cartridgeType(0x05, 'MBC2', 'mbc2', { hasRAM: true }),
    0x06: cartridgeType(0x06, 'MBC2+BATTERY', 'mbc2', { hasRAM: true, hasBattery: true }),
    0x08: cartridgeType(0x08, 'ROM+RAM', 'rom', { hasRAM: true }),
    0x09: cartridgeType(0x09, 'ROM+RAM+BATTERY', 'rom', { hasRAM: true, hasBattery: true }),
    0x0b: cartridgeType(0x0b, 'MMM01', 'mmm01'),
    0x0c: cartridgeType(0x0c, 'MMM01+RAM', 'mmm01', { hasRAM: true }),
    0x0d: cartridgeType(0x0d, 'MMM01+RAM+BATTERY', 'mmm01', { hasRAM: true, hasBattery: true }),
    0x0f: cartridgeType(0x0f, 'MBC3+TIMER+BATTERY', 'mbc3', { hasBattery: true, hasTimer: true }),
    0x10: cartridgeType(0x10, 'MBC3+TIMER+RAM+BATTERY', 'mbc3', { hasRAM: true, hasBattery: true, hasTimer: true }),
    0x11: cartridgeType(0x11, 'MBC3', 'mbc3'),
    0x12: cartridgeType(0x12, 'MBC3+RAM', 'mbc3', { hasRAM: true }),
    0x13: cartridgeType(0x13, 'MBC3+RAM+BATTERY', 'mbc3', { hasRAM: true, hasBattery: true }),
    0x19: cartridgeType(0x19, 'MBC5', 'mbc5'),
    0x1a: cartridgeType(0x1a, 'MBC5+RAM', 'mbc5', { hasRAM: true }),
    0x1b: cartridgeType(0x1b, 'MBC5+RAM+BATTERY', 'mbc5', { hasRAM: true, hasBattery: true }),
    0x1c: cartridgeType(0x1c, 'MBC5+RUMBLE', 'mbc5', { hasRumble: true }),
    0x1d: cartridgeType(0x1d, 'MBC5+RUMBLE+RAM', 'mbc5', { hasRAM: true, hasRumble: true }),
    0x1e: cartridgeType(0x1e, 'MBC5+RUMBLE+RAM+BATTERY', 'mbc5', { hasRAM: true, hasBattery: true, hasRumble: true }),
    0x20: cartridgeType(0x20, 'MBC6', 'mbc6'),
    0x22: cartridgeType(0x22, 'MBC7+SENSOR+RUMBLE+RAM+BATTERY', 'mbc7', { hasRAM: true, hasBattery: true, hasRumble: true, hasSensor: true }),
    0xfc: cartridgeType(0xfc, 'POCKET CAMERA', 'camera'),
    0xfd: cartridgeType(0xfd, 'BANDAI TAMA5', 'tama5'),
    0xfe: cartridgeType(0xfe, 'HuC3', 'huc3'),
    0xff: cartridgeType(0xff, 'HuC1+RAM+BATTERY', 'huc1', { hasRAM: true, hasBattery: true }),
};

export const GAME_BOY_ROM_SIZES: Readonly<Record<number, number>> = {
    0x00: 32 * 1024,
    0x01: 64 * 1024,
    0x02: 128 * 1024,
    0x03: 256 * 1024,
    0x04: 512 * 1024,
    0x05: 1024 * 1024,
    0x06: 2 * 1024 * 1024,
    0x07: 4 * 1024 * 1024,
    0x08: 8 * 1024 * 1024,
    0x52: 72 * 16 * 1024,
    0x53: 80 * 16 * 1024,
    0x54: 96 * 16 * 1024,
};

export const GAME_BOY_RAM_SIZES: Readonly<Record<number, number>> = {
    0x00: 0,
    0x01: 0,
    0x02: 8 * 1024,
    0x03: 32 * 1024,
    0x04: 128 * 1024,
    0x05: 64 * 1024,
};

export type GameBoyCompatibility = 'dmg' | 'dual' | 'cgb';

export interface GameBoyHeaderOptions {
    readonly strict?: boolean;
}

export interface GameBoyCartridgeHeader {
    readonly platform: 'gb';
    readonly title: string;
    readonly manufacturerCode: string;
    readonly compatibility: GameBoyCompatibility;
    readonly cgbFlag: number;
    readonly sgbSupported: boolean;
    readonly licenseeCode: string;
    readonly oldLicenseeCode: number;
    readonly cartridgeType: GameBoyCartridgeType;
    readonly romSize: number;
    readonly romSizeCode: number;
    readonly ramSize: number;
    readonly ramSizeCode: number;
    readonly destination: 'japan' | 'overseas' | 'unknown';
    readonly version: number;
    readonly headerChecksum: number;
    readonly globalChecksum: number;
    readonly logoValid: boolean;
    readonly headerChecksumValid: boolean;
    readonly globalChecksumValid: boolean;
}

export class GameBoyHeaderError extends Error {

    constructor(message: string) {

        super(message);
        this.name = 'GameBoyHeaderError';
    }
}

function byteAt(data: Uint8Array, index: number): number {

    return data[index] ?? 0;
}

function decodeASCII(data: Uint8Array, start: number, end: number): string {

    let value = '';

    for (let index = start; index < end; index++) {
        const byte = byteAt(data, index);

        if (byte === 0) {
            break;
        }

        value += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '\ufffd';
    }

    return value.trimEnd();
}

function bytesEqual(data: Uint8Array, offset: number, expected: readonly number[]): boolean {

    return expected.every((value, index) => byteAt(data, offset + index) === value);
}

export function calculateGameBoyHeaderChecksum(rom: Uint8Array): number {

    let checksum = 0;

    for (let address = 0x0134; address <= 0x014c; address++) {
        checksum = (checksum - byteAt(rom, address) - 1) & 0xff;
    }

    return checksum;
}

export function calculateGameBoyGlobalChecksum(rom: Uint8Array): number {

    let checksum = 0;

    for (let address = 0; address < rom.length; address++) {
        if (address !== 0x014e && address !== 0x014f) {
            checksum = (checksum + byteAt(rom, address)) & 0xffff;
        }
    }

    return checksum;
}

export function parseGameBoyHeader(
    rom: Uint8Array,
    options: GameBoyHeaderOptions = {},
): GameBoyCartridgeHeader {

    if (rom.length < 0x0150) {
        throw new GameBoyHeaderError('A Game Boy ROM must contain the complete 0x150-byte cartridge header.');
    }

    const cgbFlag = byteAt(rom, 0x0143);
    const compatibility: GameBoyCompatibility = cgbFlag === 0xc0
        ? 'cgb'
        : ((cgbFlag >> 7) & 1) !== 0
            ? 'dual'
            : 'dmg';
    const cartridgeTypeCode = byteAt(rom, 0x0147);
    const cartridge = GAME_BOY_CARTRIDGE_TYPES[cartridgeTypeCode];
    const romSizeCode = byteAt(rom, 0x0148);
    const ramSizeCode = byteAt(rom, 0x0149);
    const romSize = GAME_BOY_ROM_SIZES[romSizeCode];
    const ramSize = GAME_BOY_RAM_SIZES[ramSizeCode];

    if (cartridge === undefined) {
        throw new GameBoyHeaderError(`Unsupported Game Boy cartridge type 0x${cartridgeTypeCode.toString(16).padStart(2, '0')}.`);
    }

    if (romSize === undefined) {
        throw new GameBoyHeaderError(`Unknown Game Boy ROM size code 0x${romSizeCode.toString(16).padStart(2, '0')}.`);
    }

    if (ramSize === undefined) {
        throw new GameBoyHeaderError(`Unknown Game Boy RAM size code 0x${ramSizeCode.toString(16).padStart(2, '0')}.`);
    }

    const headerChecksum = byteAt(rom, 0x014d);
    const globalChecksum = (byteAt(rom, 0x014e) << 8) | byteAt(rom, 0x014f);
    const logoValid = bytesEqual(rom, 0x0104, GAME_BOY_LOGO);
    const headerChecksumValid = calculateGameBoyHeaderChecksum(rom) === headerChecksum;
    const globalChecksumValid = calculateGameBoyGlobalChecksum(rom) === globalChecksum;

    if (options.strict !== false) {
        if (!logoValid) {
            throw new GameBoyHeaderError('The Game Boy cartridge logo is invalid.');
        }

        if (!headerChecksumValid) {
            throw new GameBoyHeaderError('The Game Boy cartridge header checksum is invalid.');
        }

        if (rom.length < romSize) {
            throw new GameBoyHeaderError(`The ROM is truncated: expected at least ${romSize} bytes, received ${rom.length}.`);
        }
    }

    const oldLicenseeCode = byteAt(rom, 0x014b);
    const destinationCode = byteAt(rom, 0x014a);

    return {
        platform: 'gb',
        title: decodeASCII(rom, 0x0134, compatibility === 'dmg' ? 0x0144 : 0x013f),
        manufacturerCode: compatibility === 'dmg' ? '' : decodeASCII(rom, 0x013f, 0x0143),
        compatibility,
        cgbFlag,
        sgbSupported: byteAt(rom, 0x0146) === 0x03 && oldLicenseeCode === 0x33,
        licenseeCode: oldLicenseeCode === 0x33 ? decodeASCII(rom, 0x0144, 0x0146) : oldLicenseeCode.toString(16).padStart(2, '0').toUpperCase(),
        oldLicenseeCode,
        cartridgeType: cartridge,
        romSize,
        romSizeCode,
        ramSize,
        ramSizeCode,
        destination: destinationCode === 0x00 ? 'japan' : (destinationCode === 0x01 ? 'overseas' : 'unknown'),
        version: byteAt(rom, 0x014c),
        headerChecksum,
        globalChecksum,
        logoValid,
        headerChecksumValid,
        globalChecksumValid,
    };
}
