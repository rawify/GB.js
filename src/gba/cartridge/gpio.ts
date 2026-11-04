export const GBA_GPIO_DATA_ADDRESS = 0x080000c4;
export const GBA_GPIO_DIRECTION_ADDRESS = 0x080000c6;
export const GBA_GPIO_CONTROL_ADDRESS = 0x080000c8;

const RTC_PIN_CLOCK = 0x01;
const RTC_PIN_DATA = 0x02;
const RTC_PIN_CHIP_SELECT = 0x04;
const RTC_COMMAND_MAGIC = 0x06;
const RTC_COMMAND_RESET = 0;
const RTC_COMMAND_DATE_TIME = 2;
const RTC_COMMAND_FORCE_IRQ = 3;
const RTC_COMMAND_CONTROL = 4;
const RTC_COMMAND_TIME = 6;
const RTC_CONTROL_24_HOUR = 0x40;

export interface GBARTCState {
    readonly control: number;
    readonly offsetMilliseconds: number;
}

export interface GBARTCOptions {
    readonly now?: () => number;
    readonly initialState?: GBARTCState;
    readonly onWrite?: (state: GBARTCState) => void;
}

export interface GBACartridgeGPIOOptions {
    readonly rtc?: GBARTCOptions;
    readonly requestInterrupt?: () => void;
}

export class GBACartridgeGPIO {

    readonly rtc: GBARTC;
    private direction = 0;
    private pinState = 0;
    private readEnabled = false;
    private writeLatch = 0;

    constructor(options: GBACartridgeGPIOOptions = {}) {

        this.rtc = new GBARTC(
            (pins) => this.outputPins(pins),
            options.requestInterrupt,
            options.rtc,
        );
    }

    readByte(address: number): number | undefined {

        const registerAddress = address & 0xfffffffe;

        if (!this.handles(registerAddress)) {
            return undefined;
        }

        const value = this.readEnabled ? this.readRegister(registerAddress) : 0;

        return (value >>> ((address & 1) * 8)) & 0xff;
    }

    write16(address: number, value: number): boolean {

        const registerAddress = address & 0xfffffffe;

        if (!this.handles(registerAddress)) {
            return false;
        }

        switch (registerAddress) {
            case GBA_GPIO_DATA_ADDRESS:
                this.writeLatch = value & 0x0f;
                this.applyOutputPins();
                break;
            case GBA_GPIO_DIRECTION_ADDRESS:
                this.direction = value & 0x0f;
                this.applyOutputPins();
                break;
            case GBA_GPIO_CONTROL_ADDRESS:
                this.readEnabled = (value & 1) !== 0;
                break;
        }

        return true;
    }

    reset(): void {

        this.direction = 0;
        this.pinState = 0;
        this.readEnabled = false;
        this.writeLatch = 0;
        this.rtc.resetProtocol();
    }

    private handles(address: number): boolean {

        return address === GBA_GPIO_DATA_ADDRESS
            || address === GBA_GPIO_DIRECTION_ADDRESS
            || address === GBA_GPIO_CONTROL_ADDRESS;
    }

    private readRegister(address: number): number {

        switch (address) {
            case GBA_GPIO_DATA_ADDRESS:
                return this.pinState;
            case GBA_GPIO_DIRECTION_ADDRESS:
                return this.direction;
            case GBA_GPIO_CONTROL_ADDRESS:
                return Number(this.readEnabled);
            default:
                return 0;
        }
    }

    private applyOutputPins(): void {

        this.pinState = (this.pinState & ~this.direction)
            | (this.writeLatch & this.direction);
        this.rtc.setPins(this.pinState);
    }

    private outputPins(pins: number): void {

        this.pinState = (this.pinState & this.direction)
            | (pins & ~this.direction & 0x0f);
    }
}

export class GBARTC {

    private bits = 0;
    private bitsRead = 0;
    private chipSelected = false;
    private clockHigh = true;
    private command = 0;
    private commandActive = false;
    private control = RTC_CONTROL_24_HOUR;
    private inputBytes: number[] = [];
    private offsetMilliseconds = 0;
    private outputBit = 1;
    private outputByteIndex = 0;
    private outputBytes: number[] = [];
    private readonly now: () => number;
    private readonly onWrite: ((state: GBARTCState) => void) | undefined;
    private readonly outputPins: (pins: number) => void;
    private readonly requestInterrupt: (() => void) | undefined;

    constructor(
        outputPins: (pins: number) => void,
        requestInterrupt?: () => void,
        options: GBARTCOptions = {},
    ) {

        this.outputPins = outputPins;
        this.requestInterrupt = requestInterrupt;
        this.now = options.now ?? Date.now;
        this.onWrite = options.onWrite;

        if (options.initialState !== undefined) {
            this.loadState(options.initialState);
        }
    }

    setPins(pins: number): void {

        const chipSelected = (pins & RTC_PIN_CHIP_SELECT) !== 0;
        const clockHigh = (pins & RTC_PIN_CLOCK) !== 0;

        if (!chipSelected) {
            this.abortTransfer();
            this.chipSelected = false;
            this.clockHigh = true;
            this.outputBit = 1;
            this.outputPins(RTC_PIN_DATA);
            return;
        }

        if (!this.chipSelected) {
            this.bits = 0;
            this.bitsRead = 0;
            this.commandActive = false;
            this.inputBytes = [];
            this.outputBytes = [];
            this.outputByteIndex = 0;
            this.outputBit = 1;
        }

        if (this.commandActive && this.isReadCommand()) {
            if (this.clockHigh && !clockHigh) {
                this.shiftOutputBit();
            }
        } else if (!this.clockHigh && clockHigh) {
            this.shiftInputBit((pins & RTC_PIN_DATA) !== 0 ? 1 : 0);
        }

        this.chipSelected = true;
        this.clockHigh = clockHigh;
        this.outputPins(this.outputBit === 0 ? 0 : RTC_PIN_DATA);
    }

    resetProtocol(): void {

        this.abortTransfer();
        this.chipSelected = false;
        this.clockHigh = true;
        this.outputBit = 1;
    }

    getState(): GBARTCState {

        return {
            control: this.control,
            offsetMilliseconds: this.offsetMilliseconds,
        };
    }

    loadState(state: GBARTCState): void {

        if (!Number.isFinite(state.offsetMilliseconds)) {
            throw new RangeError('GBA RTC offset must be finite.');
        }

        this.control = state.control & 0xff;
        this.offsetMilliseconds = Math.trunc(state.offsetMilliseconds);
        this.resetProtocol();
    }

    private shiftInputBit(bit: number): void {

        this.bits |= bit << this.bitsRead;
        this.bitsRead++;

        if (this.bitsRead < 8) {
            return;
        }

        const byte = this.bits & 0xff;

        this.bits = 0;
        this.bitsRead = 0;

        if (!this.commandActive) {
            this.beginCommand(byte);
        } else {
            this.processInputByte(byte);
        }
    }

    private shiftOutputBit(): void {

        if (this.outputBytes.length === 0) {
            this.outputBit = 1;
            return;
        }

        const byte = this.outputBytes[this.outputByteIndex] ?? 0xff;

        this.outputBit = (byte >>> this.bitsRead) & 1;
        this.bitsRead++;

        if (this.bitsRead === 8) {
            this.bitsRead = 0;
            this.outputByteIndex = (this.outputByteIndex + 1) % this.outputBytes.length;
        }
    }

    private beginCommand(serialByte: number): void {

        let commandByte = serialByte;

        if ((commandByte & 0x0f) !== RTC_COMMAND_MAGIC) {
            commandByte = reverseByte(commandByte);
        }

        const command = (commandByte >>> 4) & 0x07;

        if ((commandByte & 0x0f) !== RTC_COMMAND_MAGIC
            || !this.isSupportedCommand(command)) {
            this.commandActive = false;
            return;
        }

        this.command = commandByte;
        this.commandActive = true;
        this.inputBytes = [];
        this.outputByteIndex = 0;

        if (this.isReadCommand()) {
            this.outputBytes = this.readCommand(command);
        } else {
            this.outputBytes = [];
            this.executeImmediateCommand(command);
        }
    }

    private processInputByte(byte: number): void {

        const command = (this.command >>> 4) & 0x07;
        const byteCount = commandByteCount(command);

        this.inputBytes.push(byte);

        if (this.inputBytes.length < byteCount) {
            return;
        }

        switch (command) {
            case RTC_COMMAND_DATE_TIME:
                this.setDateTime(this.inputBytes);
                break;
            case RTC_COMMAND_CONTROL:
                this.control = this.inputBytes[0] ?? 0;
                break;
            case RTC_COMMAND_TIME:
                this.setTime(this.inputBytes);
                break;
        }

        this.inputBytes = [];
        this.onWrite?.(this.getState());
    }

    private executeImmediateCommand(command: number): void {

        if (command === RTC_COMMAND_RESET) {
            this.control = 0;
            this.onWrite?.(this.getState());
        } else if (command === RTC_COMMAND_FORCE_IRQ) {
            this.requestInterrupt?.();
        }
    }

    private readCommand(command: number): number[] {

        if (command === RTC_COMMAND_CONTROL) {
            return [this.control];
        }

        const dateTime = this.currentDateTime();

        if (command === RTC_COMMAND_DATE_TIME) {
            return dateTime;
        }

        if (command === RTC_COMMAND_TIME) {
            return dateTime.slice(4);
        }

        return [];
    }

    private currentDateTime(): number[] {

        const date = new Date(this.now() + this.offsetMilliseconds);
        const hours = date.getHours();
        const encodedHours = (this.control & RTC_CONTROL_24_HOUR) !== 0
            ? toBCD(hours)
            : toBCD(hours % 12) | (hours >= 12 ? 0x80 : 0);

        return [
            toBCD(date.getFullYear() % 100),
            toBCD(date.getMonth() + 1),
            toBCD(date.getDate()),
            toBCD(date.getDay()),
            encodedHours,
            toBCD(date.getMinutes()),
            toBCD(date.getSeconds()),
        ];
    }

    private setDateTime(bytes: number[]): void {

        const now = this.now();
        const current = new Date(now + this.offsetMilliseconds);
        const target = new Date(
            2000 + fromBCD(bytes[0] ?? 0),
            clamp(fromBCD(bytes[1] ?? 1), 1, 12) - 1,
            clamp(fromBCD(bytes[2] ?? 1), 1, 31),
            this.decodeHours(bytes[4] ?? 0),
            clamp(fromBCD(bytes[5] ?? 0), 0, 59),
            clamp(fromBCD(bytes[6] ?? 0), 0, 59),
            current.getMilliseconds(),
        );

        this.offsetMilliseconds = target.getTime() - now;
    }

    private setTime(bytes: number[]): void {

        const now = this.now();
        const target = new Date(now + this.offsetMilliseconds);

        target.setHours(
            this.decodeHours(bytes[0] ?? 0),
            clamp(fromBCD(bytes[1] ?? 0), 0, 59),
            clamp(fromBCD(bytes[2] ?? 0), 0, 59),
        );
        this.offsetMilliseconds = target.getTime() - now;
    }

    private decodeHours(value: number): number {

        if ((this.control & RTC_CONTROL_24_HOUR) !== 0) {
            return clamp(fromBCD(value & 0x3f), 0, 23);
        }

        return clamp(fromBCD(value & 0x7f), 0, 12) % 12
            + ((value & 0x80) !== 0 ? 12 : 0);
    }

    private isReadCommand(): boolean {

        return (this.command & 0x80) !== 0;
    }

    private isSupportedCommand(command: number): boolean {

        return command === RTC_COMMAND_RESET
            || command === RTC_COMMAND_DATE_TIME
            || command === RTC_COMMAND_FORCE_IRQ
            || command === RTC_COMMAND_CONTROL
            || command === RTC_COMMAND_TIME;
    }

    private abortTransfer(): void {

        this.bits = 0;
        this.bitsRead = 0;
        this.command = 0;
        this.commandActive = false;
        this.inputBytes = [];
        this.outputBytes = [];
        this.outputByteIndex = 0;
    }
}

export function hasGBARTC(rom: Uint8Array): boolean {

    const signature = 'SIIRTC_V';

    for (let offset = 0; offset <= rom.length - signature.length; offset++) {
        if (rom[offset] !== 0x53) {
            continue;
        }

        let matches = true;

        for (let index = 1; index < signature.length; index++) {
            if (rom[offset + index] !== signature.charCodeAt(index)) {
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

function commandByteCount(command: number): number {

    if (command === RTC_COMMAND_DATE_TIME) {
        return 7;
    }

    if (command === RTC_COMMAND_CONTROL) {
        return 1;
    }

    if (command === RTC_COMMAND_TIME) {
        return 3;
    }

    return 0;
}

function reverseByte(value: number): number {

    let reversed = 0;

    for (let index = 0; index < 8; index++) {
        reversed = (reversed << 1) | ((value >>> index) & 1);
    }

    return reversed;
}

function toBCD(value: number): number {

    return Math.floor(value / 10) * 0x10 + value % 10;
}

function fromBCD(value: number): number {

    return ((value >>> 4) & 0x0f) * 10 + (value & 0x0f);
}

function clamp(value: number, minimum: number, maximum: number): number {

    return Math.max(minimum, Math.min(maximum, value));
}
