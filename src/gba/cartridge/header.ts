export const GAME_BOY_ADVANCE_LOGO: readonly number[] = [
    0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a, 0x84, 0xe4, 0x09, 0xad,
    0x11, 0x24, 0x8b, 0x98, 0xc0, 0x81, 0x7f, 0x21, 0xa3, 0x52, 0xbe, 0x19, 0x93, 0x09, 0xce, 0x20,
    0x10, 0x46, 0x4a, 0x4a, 0xf8, 0x27, 0x31, 0xec, 0x58, 0xc7, 0xe8, 0x33, 0x82, 0xe3, 0xce, 0xbf,
    0x85, 0xf4, 0xdf, 0x94, 0xce, 0x4b, 0x09, 0xc1, 0x94, 0x56, 0x8a, 0xc0, 0x13, 0x72, 0xa7, 0xfc,
    0x9f, 0x84, 0x4d, 0x73, 0xa3, 0xca, 0x9a, 0x61, 0x58, 0x97, 0xa3, 0x27, 0xfc, 0x03, 0x98, 0x76,
    0x23, 0x1d, 0xc7, 0x61, 0x03, 0x04, 0xae, 0x56, 0xbf, 0x38, 0x84, 0x00, 0x40, 0xa7, 0x0e, 0xfd,
    0xff, 0x52, 0xfe, 0x03, 0x6f, 0x95, 0x30, 0xf1, 0x97, 0xfb, 0xc0, 0x85, 0x60, 0xd6, 0x80, 0x25,
    0xa9, 0x63, 0xbe, 0x03, 0x01, 0x4e, 0x38, 0xe2, 0xf9, 0xa2, 0x34, 0xff, 0xbb, 0x3e, 0x03, 0x44,
    0x78, 0x00, 0x90, 0xcb, 0x88, 0x11, 0x3a, 0x94, 0x65, 0xc0, 0x7c, 0x63, 0x87, 0xf0, 0x3c, 0xaf,
    0xd6, 0x25, 0xe4, 0x8b, 0x38, 0x0a, 0xac, 0x72, 0x21, 0xd4, 0xf8, 0x07,
];

export interface GameBoyAdvanceHeaderOptions {
    readonly strict?: boolean;
}

export interface GameBoyAdvanceCartridgeHeader {
    readonly platform: 'gba';
    readonly title: string;
    readonly gameCode: string;
    readonly makerCode: string;
    readonly unitCode: number;
    readonly deviceType: number;
    readonly version: number;
    readonly headerChecksum: number;
    readonly entryPointValid: boolean;
    readonly logoValid: boolean;
    readonly fixedValueValid: boolean;
    readonly reservedBytesValid: boolean;
    readonly headerChecksumValid: boolean;
}

export class GameBoyAdvanceHeaderError extends Error {

    constructor(message: string) {

        super(message);
        this.name = 'GameBoyAdvanceHeaderError';
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

export function calculateGameBoyAdvanceHeaderChecksum(rom: Uint8Array): number {

    let checksum = 0;

    for (let address = 0x00a0; address <= 0x00bc; address++) {
        checksum = (checksum - byteAt(rom, address)) & 0xff;
    }

    return (checksum - 0x19) & 0xff;
}

export function parseGameBoyAdvanceHeader(
    rom: Uint8Array,
    options: GameBoyAdvanceHeaderOptions = {},
): GameBoyAdvanceCartridgeHeader {

    if (rom.length < 0x00c0) {
        throw new GameBoyAdvanceHeaderError('A Game Boy Advance ROM must contain the complete 0xc0-byte cartridge header.');
    }

    const entryPointValid = byteAt(rom, 0x0003) === 0xea;
    const logoValid = bytesEqual(rom, 0x0004, GAME_BOY_ADVANCE_LOGO);
    const fixedValueValid = byteAt(rom, 0x00b2) === 0x96;
    const reservedBytesValid = rom.subarray(0x00b5, 0x00bc).every((value) => value === 0)
        && byteAt(rom, 0x00be) === 0
        && byteAt(rom, 0x00bf) === 0;
    const headerChecksum = byteAt(rom, 0x00bd);
    const headerChecksumValid = calculateGameBoyAdvanceHeaderChecksum(rom) === headerChecksum;

    if (options.strict !== false) {
        if (!entryPointValid) {
            throw new GameBoyAdvanceHeaderError('The GBA entry point is not an ARM branch instruction.');
        }

        if (!logoValid) {
            throw new GameBoyAdvanceHeaderError('The GBA cartridge logo is invalid.');
        }

        if (!fixedValueValid) {
            throw new GameBoyAdvanceHeaderError('The GBA fixed header byte is not 0x96.');
        }

        if (!headerChecksumValid) {
            throw new GameBoyAdvanceHeaderError('The GBA cartridge header checksum is invalid.');
        }
    }

    return {
        platform: 'gba',
        title: decodeASCII(rom, 0x00a0, 0x00ac),
        gameCode: decodeASCII(rom, 0x00ac, 0x00b0),
        makerCode: decodeASCII(rom, 0x00b0, 0x00b2),
        unitCode: byteAt(rom, 0x00b3),
        deviceType: byteAt(rom, 0x00b4),
        version: byteAt(rom, 0x00bc),
        headerChecksum,
        entryPointValid,
        logoValid,
        fixedValueValid,
        reservedBytesValid,
        headerChecksumValid,
    };
}
