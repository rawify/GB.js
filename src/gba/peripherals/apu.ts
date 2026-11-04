import type { AudioBuffer } from '../../types.js';
import type { GBAClockedComponent } from '../scheduler/scheduler.js';
import { GBAPSG } from './psg.js';

export const GAME_BOY_ADVANCE_AUDIO_CLOCK_HZ = 16777216;
export const GBA_SOUND_CONTROL_HIGH_MASK = 0x770f;
export const GBA_SOUND_BIAS_MASK = 0xc3fe;

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BUFFER_CAPACITY = 16384;
const FIFO_CAPACITY = 32;
const PSG_VOLUME_RATIOS = [0.25, 0.5, 1, 0.25] as const;

export interface GBAAudioDMA {
    requestSoundFIFO(address: number): void;
}

export interface GBAAPUOptions {
    readonly sampleRate?: number;
    readonly bufferCapacity?: number;
}

class DirectSoundFIFO {

    readonly data = new Uint8Array(FIFO_CAPACITY);
    sample = 0;
    private readIndex = 0;
    private writeIndex = 0;
    private length = 0;

    get level(): number {

        return this.length;
    }

    write(value: number): void {

        if (this.length >= FIFO_CAPACITY) {
            return;
        }

        this.data[this.writeIndex] = value & 0xff;
        this.writeIndex = (this.writeIndex + 1) % FIFO_CAPACITY;
        this.length++;
    }

    consume(): void {

        if (this.length === 0) {
            this.sample = 0;
            return;
        }

        this.sample = (this.data[this.readIndex] ?? 0) << 24 >> 24;
        this.readIndex = (this.readIndex + 1) % FIFO_CAPACITY;
        this.length--;
    }

    reset(): void {

        this.data.fill(0);
        this.sample = 0;
        this.readIndex = 0;
        this.writeIndex = 0;
        this.length = 0;
    }
}

export class GBAAPU implements GBAClockedComponent {

    readonly sampleRate: number;
    readonly psg = new GBAPSG();
    readonly schedulerClock: GBAClockedComponent = {
        tick: (cycles) => {

            this.pendingCycles += cycles;
        },
    };
    private readonly dma: GBAAudioDMA;
    private readonly bufferCapacity: number;
    private readonly leftBuffer: Float32Array;
    private readonly rightBuffer: Float32Array;
    private readonly fifos = [new DirectSoundFIFO(), new DirectSoundFIFO()] as const;
    private soundControlHigh = 0;
    private soundControlX = 0;
    private soundBias = 0x0200;
    private sampleAccumulator = 0;
    private sampleCycles = 0;
    private sampleLeftIntegral = 0;
    private sampleRightIntegral = 0;
    private pwmClock = 0;
    private pwmLeft = 0;
    private pwmRight = 0;
    private pwmSampleValid = false;
    private pendingCycles = 0;
    private bufferReadIndex = 0;
    private bufferWriteIndex = 0;
    private bufferLength = 0;
    private droppedSampleCount = 0;

    constructor(dma: GBAAudioDMA, options: GBAAPUOptions = {}) {

        const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
        const bufferCapacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;

        if (!Number.isInteger(sampleRate)
            || sampleRate <= 0
            || sampleRate > GAME_BOY_ADVANCE_AUDIO_CLOCK_HZ) {
            throw new RangeError(`Expected an integer audio sample rate from 1 to ${GAME_BOY_ADVANCE_AUDIO_CLOCK_HZ}, received ${sampleRate}.`);
        }

        if (!Number.isInteger(bufferCapacity) || bufferCapacity <= 0) {
            throw new RangeError(`Expected a positive integer audio buffer capacity, received ${bufferCapacity}.`);
        }

        this.dma = dma;
        this.sampleRate = sampleRate;
        this.bufferCapacity = bufferCapacity;
        this.leftBuffer = new Float32Array(bufferCapacity);
        this.rightBuffer = new Float32Array(bufferCapacity);
    }

    get bufferedSamples(): number {

        this.synchronize();
        return this.bufferLength;
    }

    get droppedSamples(): number {

        this.synchronize();
        return this.droppedSampleCount;
    }

    readControlHigh(): number {

        return this.soundControlHigh;
    }

    readPSGByte(offset: number): number {

        this.synchronize();
        return this.psg.readByte(offset);
    }

    readControlX(): number {

        this.synchronize();
        return this.soundControlX | this.psg.activeChannels;
    }

    readBias(): number {

        return this.soundBias;
    }

    fifoLevel(index: number): number {

        return this.fifo(index).level;
    }

    fifoSample(index: number): number {

        return this.fifo(index).sample;
    }

    writeControlHigh(value: number): void {

        this.synchronize();

        if ((value & 0x0800) !== 0) {
            this.fifos[0].reset();
        }

        if ((value & 0x8000) !== 0) {
            this.fifos[1].reset();
        }

        this.soundControlHigh = value & GBA_SOUND_CONTROL_HIGH_MASK;
    }

    writePSGByte(offset: number, value: number): void {

        this.synchronize();
        this.psg.writeByte(offset, value);
    }

    writeControlX(value: number): void {

        this.synchronize();
        this.soundControlX = value & 0x0080;
        this.psg.setPowered((this.soundControlX & 0x80) !== 0);

        if (this.soundControlX === 0) {
            this.soundControlHigh &= 0x7700;
        }
    }

    writeBias(value: number): void {

        this.synchronize();
        this.soundBias = value & GBA_SOUND_BIAS_MASK;
    }

    writeFIFO(index: number, value: number): void {

        this.synchronize();
        this.fifo(index).write(value);
    }

    onTimerOverflow(timer: number, overflows = 1): void {

        if (timer !== 0 && timer !== 1) {
            return;
        }

        this.synchronize();

        for (let overflow = 0; overflow < overflows; overflow++) {
            for (let index = 0; index < this.fifos.length; index++) {
                if (this.fifoTimer(index) !== timer) {
                    continue;
                }

                const fifo = this.fifo(index);

                fifo.consume();

                if (fifo.level <= 16) {
                    this.dma.requestSoundFIFO(index === 0 ? 0x040000a0 : 0x040000a4);
                }
            }
        }
    }

    tick(cycles: number): void {

        this.synchronize();
        this.advance(cycles);
    }

    drainAudio(): AudioBuffer {

        this.synchronize();

        const left = new Float32Array(this.bufferLength);
        const right = new Float32Array(this.bufferLength);

        for (let index = 0; index < this.bufferLength; index++) {
            const sourceIndex = (this.bufferReadIndex + index) % this.bufferCapacity;

            left[index] = this.leftBuffer[sourceIndex] ?? 0;
            right[index] = this.rightBuffer[sourceIndex] ?? 0;
        }

        this.bufferReadIndex = this.bufferWriteIndex;
        this.bufferLength = 0;

        return {
            sampleRate: this.sampleRate,
            left,
            right,
        };
    }

    reset(): void {

        this.soundControlHigh = 0;
        this.soundControlX = 0;
        this.soundBias = 0x0200;
        this.psg.reset();
        this.sampleAccumulator = 0;
        this.sampleCycles = 0;
        this.sampleLeftIntegral = 0;
        this.sampleRightIntegral = 0;
        this.pwmClock = 0;
        this.pwmLeft = 0;
        this.pwmRight = 0;
        this.pwmSampleValid = false;
        this.pendingCycles = 0;
        this.bufferReadIndex = 0;
        this.bufferWriteIndex = 0;
        this.bufferLength = 0;
        this.droppedSampleCount = 0;

        for (const fifo of this.fifos) {
            fifo.reset();
        }
    }

    private synchronize(): void {

        const cycles = this.pendingCycles;

        if (cycles === 0) {
            return;
        }

        this.pendingCycles = 0;
        this.advance(cycles);
    }

    private advance(cycles: number): void {

        let remainingCycles = cycles;

        while (remainingCycles > 0) {
            if (!this.pwmSampleValid) {
                this.latchPWMSample();
            }

            const cyclesToSample = Math.ceil(
                (GAME_BOY_ADVANCE_AUDIO_CLOCK_HZ - this.sampleAccumulator) / this.sampleRate,
            );
            const cyclesToPSGEvent = this.psg.cyclesUntilNextEvent(remainingCycles)
                ?? remainingCycles;
            const pwmPeriod = this.pwmPeriod();
            const cyclesToPWMEvent = pwmPeriod - (this.pwmClock & (pwmPeriod - 1));
            const step = Math.min(
                remainingCycles,
                cyclesToSample,
                cyclesToPSGEvent,
                cyclesToPWMEvent,
            );

            this.sampleLeftIntegral += this.pwmLeft * step;
            this.sampleRightIntegral += this.pwmRight * step;
            this.sampleCycles += step;
            this.sampleAccumulator += step * this.sampleRate;
            this.psg.tick(step);
            this.pwmClock = (this.pwmClock + step) & 0x01ff;
            remainingCycles -= step;

            if ((this.pwmClock & (pwmPeriod - 1)) === 0) {
                this.latchPWMSample();
            }

            if (this.sampleAccumulator >= GAME_BOY_ADVANCE_AUDIO_CLOCK_HZ) {
                this.sampleAccumulator -= GAME_BOY_ADVANCE_AUDIO_CLOCK_HZ;
                this.pushSample(
                    this.sampleLeftIntegral / this.sampleCycles,
                    this.sampleRightIntegral / this.sampleCycles,
                );
                this.sampleCycles = 0;
                this.sampleLeftIntegral = 0;
                this.sampleRightIntegral = 0;
            }
        }
    }

    private output(): readonly [number, number] {

        if ((this.soundControlX & 0x80) === 0) {
            return [0, 0];
        }

        const [psgLeft, psgRight] = this.psg.output();
        const psgRatio = PSG_VOLUME_RATIOS[this.soundControlHigh & 0x03] ?? 0.25;
        let left = psgLeft * psgRatio;
        let right = psgRight * psgRatio;

        for (let index = 0; index < this.fifos.length; index++) {
            const shift = index === 0 ? 0 : 4;
            const sample = this.fifo(index).sample / 128;
            const volume = (this.soundControlHigh & (0x04 << index)) !== 0 ? 1 : 0.5;

            if ((this.soundControlHigh & (0x0100 << shift)) !== 0) {
                right += sample * volume;
            }

            if ((this.soundControlHigh & (0x0200 << shift)) !== 0) {
                left += sample * volume;
            }
        }

        return [this.applyBias(left), this.applyBias(right)];
    }

    private applyBias(sample: number): number {

        const bias = this.soundBias & 0x03ff;
        const resolution = this.soundBias >>> 14;
        const discardedBits = resolution + 1;
        const quantizationMask = (1 << discardedBits) - 1;
        const mixedSample = Math.round(sample * 512);
        const biasedSample = Math.max(0, Math.min(0x03ff, mixedSample + bias));
        const quantizedSample = biasedSample & ~quantizationMask;

        return (quantizedSample - bias) / 512;
    }

    private pwmPeriod(): number {

        return 0x0200 >> (this.soundBias >>> 14);
    }

    private latchPWMSample(): void {

        [this.pwmLeft, this.pwmRight] = this.output();
        this.pwmSampleValid = true;
    }

    private pushSample(left: number, right: number): void {

        if (this.bufferLength >= this.bufferCapacity) {
            this.bufferReadIndex = (this.bufferReadIndex + 1) % this.bufferCapacity;
            this.bufferLength--;
            this.droppedSampleCount++;
        }

        this.leftBuffer[this.bufferWriteIndex] = left;
        this.rightBuffer[this.bufferWriteIndex] = right;
        this.bufferWriteIndex = (this.bufferWriteIndex + 1) % this.bufferCapacity;
        this.bufferLength++;
    }

    private fifoTimer(index: number): number {

        return (this.soundControlHigh >> (index === 0 ? 10 : 14)) & 1;
    }

    private fifo(index: number): DirectSoundFIFO {

        const fifo = this.fifos[index];

        if (fifo === undefined) {
            throw new RangeError(`GBA Direct Sound FIFO index ${index} is outside 0-1.`);
        }

        return fifo;
    }
}
