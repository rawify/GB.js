import type { GBAClockedComponent } from '../scheduler/scheduler.js';
import { GBA_INTERRUPT, type GBAInterruptController } from './interrupts.js';

export const GBA_SIO_DATA_32_ADDRESS = 0x04000120;
export const GBA_SIO_CONTROL_ADDRESS = 0x04000128;
export const GBA_SIO_DATA_8_ADDRESS = 0x0400012a;
export const GBA_SIO_MODE_CONTROL_ADDRESS = 0x04000134;
export const GBA_JOY_BUS_CONTROL_ADDRESS = 0x04000140;
export const GBA_JOY_BUS_RECEIVE_ADDRESS = 0x04000150;
export const GBA_JOY_BUS_TRANSMIT_ADDRESS = 0x04000154;
export const GBA_JOY_BUS_STATUS_ADDRESS = 0x04000158;

export interface GBASerialEndpoint {
    exchangeBit(outgoingBit: 0 | 1): 0 | 1;
}

const SIO_START = 0x0080;
const SIO_IRQ = 0x4000;
const SIO_MODE_MASK = 0x3000;
const SIO_NORMAL_MASK = 0x7083;
const SIO_UART_MASK = 0x70a3;
const SIO_INTERNAL_START_DELAY = 10;

export class GBASerial implements GBAClockedComponent {

    private readonly interrupts: GBAInterruptController;
    private readonly endpoint: GBASerialEndpoint | undefined;
    private readonly multiplayerData = new Uint16Array(4);
    private data32 = 0;
    private data8 = 0xffff;
    private multiplayerSend = 0xffff;
    private control = 0;
    private modeControl = 0;
    private joyControl = 0;
    private joyReceive = 0;
    private joyTransmit = 0;
    private joyStatus = 0;
    private transferPending = false;
    private transferActive = false;
    private transferCycles = 0;
    private bitsRemaining = 0;
    private outgoingData = 0;
    private incomingData = 0;

    constructor(interrupts: GBAInterruptController, endpoint?: GBASerialEndpoint) {

        this.interrupts = interrupts;
        this.endpoint = endpoint;
    }

    readByte(offset: number): number {

        const halfword = offset & ~1;
        const value = this.readHalfword(halfword);

        return (value >>> ((offset & 1) * 8)) & 0xff;
    }

    writeByte(offset: number, value: number): void {

        const halfword = offset & ~1;
        const previous = this.readWritableHalfword(halfword);
        const next = (offset & 1) === 0
            ? (previous & 0xff00) | (value & 0xff)
            : (previous & 0x00ff) | ((value & 0xff) << 8);

        this.writeHalfword(halfword, next);
    }

    cyclesUntilNextEvent(maximumCycles: number): number | undefined {

        if (!this.internalTransfer()) {
            return undefined;
        }

        const cycles = this.clockPeriod() - this.transferCycles;

        return cycles <= maximumCycles ? cycles : undefined;
    }

    tick(cycles: number): void {

        this.beginPendingTransfer();

        if (!this.internalTransfer()) {
            return;
        }

        this.transferCycles += cycles;

        while (this.transferActive && this.transferCycles >= this.clockPeriod()) {
            const outgoingBit = this.outgoingBit();
            const inputBit = (this.endpoint?.exchangeBit(outgoingBit) ?? 1) & 1;

            this.transferCycles -= this.clockPeriod();
            this.shiftNormalBit(inputBit as 0 | 1);
        }
    }

    clockNormal(inputBit: 0 | 1): 0 | 1 {

        this.beginPendingTransfer();

        if (!this.transferActive || (this.control & 0x0001) !== 0) {
            return 1;
        }

        const outgoingBit = this.outgoingBit();

        this.shiftNormalBit(inputBit);

        return outgoingBit;
    }

    reset(): void {

        this.multiplayerData.fill(0);
        this.data32 = 0;
        this.data8 = 0xffff;
        this.multiplayerSend = 0xffff;
        this.control = 0;
        this.modeControl = 0;
        this.joyControl = 0;
        this.joyReceive = 0;
        this.joyTransmit = 0;
        this.joyStatus = 0;
        this.cancelTransfer();
    }

    private readHalfword(offset: number): number {

        if (offset >= 0x120 && offset <= 0x126) {
            return this.readDataHalfword(offset);
        }

        switch (offset) {
            case 0x128:
                return this.readControl();
            case 0x12a:
                return this.communicationMode() === 3 ? 0 : this.readSendData();
            case 0x134:
                return this.readModeControl();
            case 0x140:
                return this.joyControl & 0x0040;
            case 0x150:
                return this.joyReceive & 0xffff;
            case 0x152:
                return this.joyReceive >>> 16;
            case 0x158:
                return this.joyStatus & 0x000f;
            default:
                return 0;
        }
    }

    private readWritableHalfword(offset: number): number {

        switch (offset) {
            case 0x120:
                return this.data32 & 0xffff;
            case 0x122:
                return this.data32 >>> 16;
            case 0x128:
                return this.control;
            case 0x12a:
                return this.communicationMode() === 2 ? this.multiplayerSend : this.data8;
            case 0x134:
                return this.modeControl;
            case 0x140:
                return this.joyControl;
            case 0x154:
                return this.joyTransmit & 0xffff;
            case 0x156:
                return this.joyTransmit >>> 16;
            case 0x158:
                return this.joyStatus;
            default:
                return 0;
        }
    }

    private writeHalfword(offset: number, value: number): void {

        const maskedValue = value & 0xffff;

        if (offset === 0x120 && this.communicationMode() === 1) {
            this.data32 = (this.data32 & 0xffff0000) | maskedValue;
            return;
        }

        if (offset === 0x122 && this.communicationMode() === 1) {
            this.data32 = (this.data32 & 0x0000ffff) | (maskedValue << 16);
            return;
        }

        switch (offset) {
            case 0x128:
                this.writeControl(maskedValue);
                return;
            case 0x12a:
                if (this.communicationMode() === 2) {
                    this.multiplayerSend = maskedValue;
                } else if (this.communicationMode() !== 3) {
                    this.data8 = maskedValue;
                }
                return;
            case 0x134:
                this.modeControl = maskedValue & 0xc1ff;
                return;
            case 0x140:
                this.joyControl = maskedValue & 0x0040;
                return;
            case 0x154:
                this.joyTransmit = (this.joyTransmit & 0xffff0000) | maskedValue;
                return;
            case 0x156:
                this.joyTransmit = (this.joyTransmit & 0x0000ffff) | (maskedValue << 16);
                return;
            case 0x158:
                this.joyStatus &= ~maskedValue;
        }
    }

    private readDataHalfword(offset: number): number {

        const mode = this.communicationMode();

        if (mode === 1 && offset <= 0x122) {
            return offset === 0x120 ? this.data32 & 0xffff : this.data32 >>> 16;
        }

        if (mode === 2) {
            return this.multiplayerData[(offset - 0x120) >> 1] ?? 0;
        }

        return 0;
    }

    private readSendData(): number {

        return this.communicationMode() === 2 ? this.multiplayerSend : this.data8;
    }

    private readControl(): number {

        const writableMask = this.communicationMode() === 3 ? SIO_UART_MASK : SIO_NORMAL_MASK;

        return (this.control & writableMask) | 0x0f0c;
    }

    private readModeControl(): number {

        switch (this.modeControl & 0xc000) {
            case 0x8000:
                return this.modeControl & 0x81ff;
            case 0xc000:
                return this.modeControl & 0xc1fc;
            default:
                return (this.communicationMode() === 0 || this.communicationMode() === 1)
                    ? 0x01f5
                    : 0x01ff;
        }
    }

    private writeControl(value: number): void {

        const previous = this.control;
        const mode = (value & SIO_MODE_MASK) >>> 12;
        const writableMask = mode === 3 ? SIO_UART_MASK : SIO_NORMAL_MASK;

        this.control = value & writableMask;

        if ((this.control & SIO_START) === 0) {
            this.cancelTransfer();
        } else if ((previous & SIO_START) === 0
            || (previous & (SIO_MODE_MASK | 0x0003)) !== (this.control & (SIO_MODE_MASK | 0x0003))) {
            this.transferPending = true;
            this.transferActive = false;
            this.transferCycles = 0;
        }
    }

    private beginPendingTransfer(): void {

        if (!this.transferPending) {
            return;
        }

        this.transferPending = false;

        const mode = this.communicationMode();

        if (mode > 1) {
            return;
        }

        this.transferActive = true;
        this.transferCycles = (this.control & 0x0001) !== 0 ? -SIO_INTERNAL_START_DELAY : 0;
        this.bitsRemaining = mode === 0 ? 8 : 32;
        this.outgoingData = mode === 0 ? this.data8 & 0xff : this.data32;
        this.incomingData = 0;
    }

    private internalTransfer(): boolean {

        this.beginPendingTransfer();

        return this.transferActive && (this.control & 0x0001) !== 0;
    }

    private clockPeriod(): number {

        return (this.control & 0x0002) === 0 ? 64 : 8;
    }

    private outgoingBit(): 0 | 1 {

        return ((this.outgoingData >>> (this.bitsRemaining - 1)) & 1) as 0 | 1;
    }

    private shiftNormalBit(inputBit: 0 | 1): void {

        this.incomingData = ((this.incomingData << 1) | inputBit) >>> 0;
        this.bitsRemaining--;

        if (this.bitsRemaining !== 0) {
            return;
        }

        if (this.communicationMode() === 0) {
            this.data8 = (this.data8 & 0xff00) | (this.incomingData & 0xff);
        } else {
            this.data32 = this.incomingData;
        }

        this.control &= ~SIO_START;
        this.transferActive = false;
        this.transferCycles = 0;

        if ((this.control & SIO_IRQ) !== 0) {
            this.interrupts.request(GBA_INTERRUPT.serial);
        }
    }

    private cancelTransfer(): void {

        this.transferPending = false;
        this.transferActive = false;
        this.transferCycles = 0;
        this.bitsRemaining = 0;
        this.outgoingData = 0;
        this.incomingData = 0;
    }

    private communicationMode(): number {

        return (this.control & SIO_MODE_MASK) >>> 12;
    }
}
