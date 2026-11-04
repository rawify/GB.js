import { GBA_INTERRUPT, type GBAInterruptController } from './interrupts.js';

export const GBA_DMA_COUNT = 4;
export const GBA_DMA_REGISTER_STRIDE = 12;

export type GBADMATrigger = 'vblank' | 'hblank' | 'special';

type DMAAccess = 'nonsequential' | 'sequential';
type DMAWidth = 16 | 32;

export interface GBADMABus {
    beginDMATransfer?(source: number, destination: number, width: DMAWidth, count: number): void;
    accessCycles(address: number, width: DMAWidth, access?: DMAAccess): number;
    dmaAccessCycles?(
        address: number,
        width: DMAWidth,
        access: DMAAccess,
        cycleOffset: number,
    ): number;
    read16(address: number, access?: DMAAccess): number;
    read32(address: number, access?: DMAAccess): number;
    write16(address: number, value: number, access?: DMAAccess): void;
    write32(address: number, value: number, access?: DMAAccess): void;
}

interface DMAChannel {
    source: number;
    destination: number;
    count: number;
    control: number;
    internalSource: number;
    internalDestination: number;
    initialDestination: number;
    pending: boolean;
}

const DMA_INTERRUPTS = [
    GBA_INTERRUPT.dma0,
    GBA_INTERRUPT.dma1,
    GBA_INTERRUPT.dma2,
    GBA_INTERRUPT.dma3,
] as const;

export class GBADMA {

    private readonly channels: DMAChannel[] = Array.from({ length: GBA_DMA_COUNT }, () => ({
        source: 0,
        destination: 0,
        count: 0,
        control: 0,
        internalSource: 0,
        internalDestination: 0,
        initialDestination: 0,
        pending: false,
    }));
    private readonly bus: GBADMABus;
    private readonly interrupts: GBAInterruptController;
    private busLatch = 0;
    private pendingMask = 0;

    constructor(bus: GBADMABus, interrupts: GBAInterruptController) {

        this.bus = bus;
        this.interrupts = interrupts;
    }

    get hasPending(): boolean {

        return this.pendingMask !== 0;
    }

    readByte(index: number, register: number): number {

        const channel = this.channel(index);

        if (register < 8) {
            return 0;
        }

        if (register < 10) {
            return (channel.count >>> ((register - 8) * 8)) & 0xff;
        }

        return (channel.control >>> ((register - 10) * 8)) & 0xff;
    }

    writeByte(index: number, register: number, value: number): void {

        const channel = this.channel(index);
        const byte = value & 0xff;

        if (register < 4) {
            const shift = register * 8;

            channel.source = this.maskSource(
                index,
                (channel.source & ~(0xff << shift)) | (byte << shift),
            );
            return;
        }

        if (register < 8) {
            const shift = (register - 4) * 8;

            channel.destination = this.maskDestination(
                index,
                (channel.destination & ~(0xff << shift)) | (byte << shift),
            );
            return;
        }

        if (register < 10) {
            const shift = (register - 8) * 8;

            channel.count = this.maskCount(
                index,
                (channel.count & ~(0xff << shift)) | (byte << shift),
            );
            return;
        }

        const shift = (register - 10) * 8;
        const control = this.maskControl(
            index,
            (channel.control & ~(0xff << shift)) | (byte << shift),
        );

        this.writeControl(index, control);
    }

    trigger(trigger: GBADMATrigger): void {

        const timing = trigger === 'vblank' ? 1 : trigger === 'hblank' ? 2 : 3;

        for (let index = 0; index < this.channels.length; index++) {
            const channel = this.channel(index);
            const specialAllowed = trigger !== 'special'
                || index === 3
                || this.isSoundFIFO(index, channel);

            if (specialAllowed && this.enabled(channel) && this.startTiming(channel) === timing) {
                this.setPending(index, true);
            }
        }
    }

    requestSoundFIFO(address: number): void {

        const destination = address >>> 0;

        for (let index = 1; index <= 2; index++) {
            const channel = this.channel(index);

            if (this.enabled(channel)
                && this.isSoundFIFO(index, channel)
                && channel.internalDestination === destination) {
                this.setPending(index, true);
            }
        }
    }

    runPending(): number {

        let cycles = 0;

        while (this.pendingMask !== 0) {
            const index = (this.pendingMask & 1) !== 0
                ? 0
                : (this.pendingMask & 2) !== 0
                    ? 1
                    : (this.pendingMask & 4) !== 0 ? 2 : 3;

            cycles += this.transfer(index);
        }

        return cycles;
    }

    reset(): void {

        for (const channel of this.channels) {
            channel.source = 0;
            channel.destination = 0;
            channel.count = 0;
            channel.control = 0;
            channel.internalSource = 0;
            channel.internalDestination = 0;
            channel.initialDestination = 0;
            channel.pending = false;
        }

        this.busLatch = 0;
        this.pendingMask = 0;
    }

    private writeControl(index: number, control: number): void {

        const channel = this.channel(index);
        const wasEnabled = this.enabled(channel);

        channel.control = control;

        if (wasEnabled && !this.enabled(channel)) {
            this.setPending(index, false);
            return;
        }

        if (!wasEnabled && this.enabled(channel)) {
            channel.internalSource = channel.source;
            channel.internalDestination = channel.destination;
            channel.initialDestination = channel.destination;
            this.setPending(index, this.startTiming(channel) === 0);
        }
    }

    private transfer(index: number): number {

        const channel = this.channel(index);
        const specialSound = this.isSoundFIFO(index, channel);
        const width: DMAWidth = specialSound || (channel.control & 0x0400) !== 0 ? 32 : 16;
        const count = specialSound ? 4 : this.transferCount(index, channel);
        const sourceMode = (channel.control >> 7) & 0x03;
        const destinationMode = specialSound ? 2 : (channel.control >> 5) & 0x03;
        let sourceStep = this.addressStep(sourceMode, width);
        const destinationStep = this.addressStep(destinationMode, width);
        let source = this.align(channel.internalSource, width);
        let destination = this.align(channel.internalDestination, width);
        let cycles = 2;

        if (this.isGamePakROM(source)) {
            sourceStep = width / 8;
        }

        this.setPending(index, false);
        this.bus.beginDMATransfer?.(source, destination, width, count);

        for (let transfer = 0; transfer < count; transfer++) {
            const access: DMAAccess = transfer === 0 ? 'nonsequential' : 'sequential';
            const sourceReadable = source >= 0x02000000;
            const value = sourceReadable
                ? width === 32
                    ? this.bus.read32(source, access)
                    : this.bus.read16(source, access)
                : width === 32
                    ? this.busLatch
                    : this.busLatch & 0xffff;

            if (sourceReadable) {
                this.busLatch = width === 32 ? value : value | (value << 16);
            }

            if (width === 32) {
                this.bus.write32(destination, value, access);
            } else {
                this.bus.write16(destination, value, access);
            }

            cycles += this.accessCycles(source, width, access, cycles);
            cycles += this.accessCycles(destination, width, access, cycles);
            source = this.maskSource(index, source + sourceStep);
            destination = this.maskDestination(index, destination + destinationStep);
        }

        channel.internalSource = source;
        channel.internalDestination = destination;

        if ((channel.control & 0x4000) !== 0) {
            this.interrupts.request(DMA_INTERRUPTS[index] ?? 0);
        }

        const repeat = (channel.control & 0x0200) !== 0 && this.startTiming(channel) !== 0;

        if (!repeat) {
            channel.control &= ~0x8000;
        } else if (destinationMode === 3) {
            channel.internalDestination = channel.initialDestination;
        }

        return cycles;
    }

    private accessCycles(
        address: number,
        width: DMAWidth,
        access: DMAAccess,
        cycleOffset: number,
    ): number {

        return this.bus.dmaAccessCycles?.(address, width, access, cycleOffset)
            ?? this.bus.accessCycles(address, width, access);
    }

    private transferCount(index: number, channel: DMAChannel): number {

        if (channel.count !== 0) {
            return channel.count;
        }

        return index === 3 ? 0x10000 : 0x4000;
    }

    private isSoundFIFO(index: number, channel: DMAChannel): boolean {

        if ((index !== 1 && index !== 2) || this.startTiming(channel) !== 3) {
            return false;
        }

        return channel.internalDestination === 0x040000a0
            || channel.internalDestination === 0x040000a4;
    }

    private addressStep(mode: number, width: DMAWidth): number {

        if (mode === 1) {
            return -width / 8;
        }

        if (mode === 2) {
            return 0;
        }

        return width / 8;
    }

    private isGamePakROM(address: number): boolean {

        const region = address >>> 24;

        return region >= 0x08 && region <= 0x0d;
    }

    private align(address: number, width: DMAWidth): number {

        return (address & (width === 32 ? 0xfffffffc : 0xfffffffe)) >>> 0;
    }

    private enabled(channel: DMAChannel): boolean {

        return (channel.control & 0x8000) !== 0;
    }

    private startTiming(channel: DMAChannel): number {

        return (channel.control >> 12) & 0x03;
    }

    private maskSource(index: number, value: number): number {

        return (value & (index === 0 ? 0x07ffffff : 0x0fffffff)) >>> 0;
    }

    private maskDestination(index: number, value: number): number {

        return (value & (index === 3 ? 0x0fffffff : 0x07ffffff)) >>> 0;
    }

    private maskCount(index: number, value: number): number {

        return value & (index === 3 ? 0xffff : 0x3fff);
    }

    private maskControl(index: number, value: number): number {

        return value & (index === 3 ? 0xffe0 : 0xf7e0);
    }

    private setPending(index: number, pending: boolean): void {

        const channel = this.channel(index);

        channel.pending = pending;

        if (pending) {
            this.pendingMask |= 1 << index;
        } else {
            this.pendingMask &= ~(1 << index);
        }
    }

    private channel(index: number): DMAChannel {

        const channel = this.channels[index];

        if (channel === undefined) {
            throw new RangeError(`GBA DMA channel ${index} is outside 0-3.`);
        }

        return channel;
    }
}
