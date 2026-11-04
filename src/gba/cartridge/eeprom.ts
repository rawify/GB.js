const EEPROM_BLOCK_SIZE = 8;
const EEPROM_SMALL_SIZE = 512;
const EEPROM_LARGE_SIZE = 8192;
const EEPROM_READ_DUMMY_BITS = 4;

export class GBAEEPROM {

    readonly data = new Uint8Array(EEPROM_LARGE_SIZE).fill(0xff);
    private addressBits = 6;
    private commandBits: number[] = [];
    private outputBits: number[] = [];
    private outputIndex = 0;
    private size = EEPROM_SMALL_SIZE;
    private readonly onWrite: ((data: Uint8Array) => void) | undefined;

    constructor(onWrite?: (data: Uint8Array) => void) {

        this.onWrite = onWrite;
    }

    get byteLength(): number {

        return this.size;
    }

    beginTransfer(count: number): void {

        if (count === 9 || count === 73) {
            this.addressBits = 6;
            this.size = EEPROM_SMALL_SIZE;
        } else if (count === 17 || count === 81) {
            this.addressBits = 14;
            this.size = EEPROM_LARGE_SIZE;
        }

        this.commandBits = [];
    }

    readBit(): number {

        if (this.outputIndex >= this.outputBits.length) {
            return 1;
        }

        return this.outputBits[this.outputIndex++] ?? 1;
    }

    writeBit(value: number): void {

        const bit = value & 1;

        if (this.commandBits.length === 0 && bit === 0) {
            return;
        }

        this.commandBits.push(bit);
        if (this.commandBits.length < 2) {
            return;
        }

        const read = this.commandBits[1] === 1;
        const commandLength = 2
            + this.addressBits
            + (read ? 0 : EEPROM_BLOCK_SIZE * 8)
            + 1;

        if (this.commandBits.length < commandLength) {
            return;
        }

        const block = this.readBits(2, this.addressBits)
            % (this.size / EEPROM_BLOCK_SIZE);
        const offset = block * EEPROM_BLOCK_SIZE;

        if (read) {
            this.outputBits = Array(EEPROM_READ_DUMMY_BITS).fill(0);

            for (let byte = 0; byte < EEPROM_BLOCK_SIZE; byte++) {
                const data = this.data[offset + byte] ?? 0xff;

                for (let bitIndex = 7; bitIndex >= 0; bitIndex--) {
                    this.outputBits.push((data >>> bitIndex) & 1);
                }
            }

            this.outputIndex = 0;
        } else {
            const dataOffset = 2 + this.addressBits;

            for (let byte = 0; byte < EEPROM_BLOCK_SIZE; byte++) {
                this.data[offset + byte] = this.readBits(dataOffset + byte * 8, 8);
            }

            this.onWrite?.(this.dump());
        }

        this.commandBits = [];
    }

    load(data: Uint8Array): void {

        if (data.length !== EEPROM_SMALL_SIZE && data.length !== EEPROM_LARGE_SIZE) {
            throw new RangeError('GBA EEPROM data must be 512 or 8192 bytes.');
        }

        this.data.fill(0xff);
        this.data.set(data);
        this.size = data.length;
    }

    dump(): Uint8Array {

        return this.data.slice(0, this.size);
    }

    resetProtocol(): void {

        this.commandBits = [];
        this.outputBits = [];
        this.outputIndex = 0;
    }

    private readBits(offset: number, length: number): number {

        let value = 0;

        for (let index = 0; index < length; index++) {
            value = (value << 1) | (this.commandBits[offset + index] ?? 0);
        }

        return value;
    }
}

export function hasGBAEEPROM(rom: Uint8Array): boolean {

    const signature = [0x45, 0x45, 0x50, 0x52, 0x4f, 0x4d, 0x5f];

    for (let offset = 0; offset <= rom.length - signature.length; offset++) {
        let matches = true;

        for (let index = 0; index < signature.length; index++) {
            if (rom[offset + index] !== signature[index]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            return true;
        }
    }

    return false;
}
