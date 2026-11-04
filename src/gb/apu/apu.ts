import type { AudioBuffer, GameBoyColorRevision, GameBoyModel } from '../../types.js';

const GAME_BOY_CLOCK_HZ = 4194304;
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BUFFER_CAPACITY = 16384;
const DMG_CAPACITOR_CHARGE_FACTOR = 0.999958;
const CGB_CAPACITOR_CHARGE_FACTOR = 0.998943;
const DUTY_PATTERNS: readonly (readonly number[])[] = [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112] as const;
const APU_READ_MASKS = new Uint8Array([
    0x80, 0x3f, 0x00, 0xff, 0xbf,
    0xff, 0x3f, 0x00, 0xff, 0xbf,
    0x7f, 0xff, 0x9f, 0xff, 0xbf,
    0xff, 0xff, 0x00, 0x00, 0xbf,
    0x00, 0x00, 0x70,
]);

export interface DMGAPUOptions {
    readonly sampleRate?: number | undefined;
    readonly bufferCapacity?: number | undefined;
    readonly model?: GameBoyModel | undefined;
    readonly cgbRevision?: GameBoyColorRevision | undefined;
}

class VolumeEnvelope {

    volume = 0;
    private initialVolume = 0;
    private increase = false;
    private period = 0;
    private timer = 0;
    private clock = false;
    private shouldLock = false;
    private locked = false;
    private register = 0;

    reset(): void {

        this.volume = 0;
        this.initialVolume = 0;
        this.increase = false;
        this.period = 0;
        this.timer = 0;
        this.clock = false;
        this.shouldLock = false;
        this.locked = false;
        this.register = 0;
    }

    write(value: number, active: boolean, legacyWrites: boolean): boolean {

        const dacEnabled = (value & 0xf8) !== 0;

        if (dacEnabled && active) {
            if (legacyWrites) {
                this.applyWrite(0xff, this.register);
                this.applyWrite(value, 0xff);
            } else {
                this.applyWrite(value, this.register);
            }
        }

        this.initialVolume = value >> 4;
        this.increase = (value & 0x08) !== 0;
        this.period = value & 0x07;
        this.register = value;

        return dacEnabled;
    }

    trigger(): void {

        this.volume = this.initialVolume;
        this.timer = this.period;
        this.clock = false;
        this.shouldLock = false;
        this.locked = false;
    }

    prepareClock(active: boolean): void {

        if (!active || this.timer !== 0) {
            return;
        }

        this.timer = this.period;
        this.setClock(this.timer !== 0, this.increase, this.volume);
    }

    tick(clockCountdown: boolean): void {

        if (clockCountdown && !this.clock) {
            this.timer = (this.timer - 1) & 0x07;
        }

        if (!this.clock) {
            return;
        }

        this.setClock(false, false, 0);

        if (this.locked || this.period === 0) {
            return;
        }

        this.volume += this.increase ? 1 : -1;
    }

    private applyWrite(value: number, oldValue: number): void {

        if (this.clock) {
            this.timer = value & 0x07;
        }

        let shouldTick = (value & 0x07) !== 0
            && (oldValue & 0x07) === 0
            && !this.locked;
        const shouldInvert = ((value ^ oldValue) & 0x08) !== 0;

        if ((value & 0x0f) === 0x08
            && (oldValue & 0x0f) === 0x08
            && !this.locked) {
            shouldTick = true;
        }

        if (shouldInvert) {
            if ((value & 0x08) !== 0) {
                this.volume = (oldValue & 0x07) === 0 && !this.locked
                    ? this.volume ^ 0x0f
                    : (0x0e - this.volume) & 0x0f;
                shouldTick = false;
            } else {
                this.volume = (0x10 - this.volume) & 0x0f;
            }
        }

        if (shouldTick) {
            this.volume = (this.volume + ((value & 0x08) !== 0 ? 1 : -1)) & 0x0f;
        } else if ((value & 0x07) === 0 && this.clock) {
            this.setClock(false, false, 0);
        }
    }

    private setClock(clock: boolean, increase: boolean, volume: number): void {

        if (this.clock === clock) {
            return;
        }

        this.clock = clock;

        if (clock) {
            this.shouldLock = (volume === 0x0f && increase) || (volume === 0 && !increase);
        } else {
            this.locked ||= this.shouldLock;
        }
    }
}

class PulseChannel {

    enabled = false;
    private readonly hasSweep: boolean;
    private dacEnabled = false;
    private duty = 0;
    private dutyPosition = 0;
    private timer = 0;
    private timerJustReloaded = false;
    private triggerLowFrequencyDivider = 0;
    private pcmReadMask = 0x0f;
    private frequency = 0;
    private lengthCounter = 0;
    private lengthEnabled = false;
    private outputSuppressed = false;
    private readonly envelope = new VolumeEnvelope();
    private readonly legacyEnvelopeWrites: boolean;
    private readonly legacyLengthWrites: boolean;
    private sweepPeriod = 0;
    private sweepNegate = false;
    private sweepShift = 0;
    private sweepFrameCounter = 0;
    private sweepCalculationCountdown = 0;
    private sweepCalculationReloadDelay = 0;
    private sweepRestartHold = 0;
    private sweepInstantCalculationPending = false;
    private sweepUnshiftedCalculation = false;
    private sweepShadow = 0;
    private sweepAddend = 0;
    private sweepCompletedAddend = 0;
    private readonly legacySweepWrites: boolean;
    private readonly modernPulseTiming: boolean;

    constructor(
        hasSweep: boolean,
        legacyEnvelopeWrites: boolean,
        legacyLengthWrites: boolean,
        modernPulseTiming: boolean,
    ) {

        this.hasSweep = hasSweep;
        this.legacyEnvelopeWrites = legacyEnvelopeWrites;
        this.legacyLengthWrites = legacyLengthWrites;
        this.legacySweepWrites = legacyEnvelopeWrites;
        this.modernPulseTiming = modernPulseTiming;
    }

    get isDACEnabled(): boolean {

        return this.dacEnabled;
    }

    get pcmOutput(): number {

        return this.rawOutput() & this.pcmReadMask;
    }

    reset(): void {

        this.enabled = false;
        this.dacEnabled = false;
        this.duty = 0;
        this.dutyPosition = 0;
        this.timer = 0;
        this.timerJustReloaded = false;
        this.triggerLowFrequencyDivider = 0;
        this.pcmReadMask = 0x0f;
        this.frequency = 0;
        this.lengthCounter = 0;
        this.lengthEnabled = false;
        this.outputSuppressed = false;
        this.envelope.reset();
        this.sweepPeriod = 0;
        this.sweepNegate = false;
        this.sweepShift = 0;
        this.sweepFrameCounter = 0;
        this.sweepCalculationCountdown = 0;
        this.sweepCalculationReloadDelay = 0;
        this.sweepRestartHold = 0;
        this.sweepInstantCalculationPending = false;
        this.sweepUnshiftedCalculation = false;
        this.sweepShadow = 0;
        this.sweepAddend = 0;
        this.sweepCompletedAddend = 0;
    }

    writeSweep(value: number, lowFrequencyDivider: number, doubleSpeed: boolean): void {

        if (!this.hasSweep) {
            return;
        }

        if (this.sweepCalculationCountdown > 0
            || this.sweepCalculationReloadDelay > 0) {
            this.applySweepWriteGlitch(value, lowFrequencyDivider, doubleSpeed);
        }

        const negate = ((value >> 3) & 1) !== 0;
        const carry = this.legacySweepWrites || this.sweepNegate ? 1 : 0;

        if (!negate
            && this.sweepShadow + this.sweepCompletedAddend + carry > 0x07ff) {
            this.enabled = false;
        }

        this.sweepPeriod = (value >> 4) & 0x07;
        this.sweepNegate = negate;
        this.sweepShift = value & 0x07;
    }

    writeDutyLength(value: number): void {

        this.duty = value >> 6;
        this.writeLength(value);
    }

    writeLength(value: number): void {

        this.lengthCounter = 64 - (value & 0x3f);
    }

    writeEnvelope(value: number): void {

        this.dacEnabled = this.envelope.write(value, this.enabled, this.legacyEnvelopeWrites);

        if (!this.dacEnabled) {
            this.enabled = false;
        }
    }

    writeFrequencyLow(value: number): void {

        this.frequency = (this.frequency & 0x0700) | value;

        if (this.timerJustReloaded) {
            this.timer = this.period();
        }
    }

    writeControl(
        value: number,
        lowFrequencyDivider: number,
        extraLengthClock: boolean,
        doubleSpeed: boolean,
    ): void {

        const frequencyBeforeWrite = this.frequency;
        const triggered = ((value >> 7) & 1) !== 0;
        const frequencyDelta = 0x07ff - frequencyBeforeWrite;
        const modernSampleCountdown = Math.floor(this.timer / 2)
            - (this.triggerLowFrequencyDivider === 0 ? 1 : 0);
        const shouldStepDutyBack = this.modernPulseTiming
            ? Math.floor(modernSampleCountdown / 2) === frequencyDelta
            : Math.floor(this.timer / 4) === frequencyDelta
                && (Math.floor(this.timer / 2) & 1) !== 0
                && this.triggerLowFrequencyDivider !== 0;

        if (!triggered
            && doubleSpeed
            && this.enabled
            && frequencyBeforeWrite >> 8 === 0x07
            && (value & 0x07) !== 0x07
            && shouldStepDutyBack) {
            this.dutyPosition = (this.dutyPosition - 1) & 0x07;
            this.outputSuppressed = false;
        }

        if (!triggered
            && doubleSpeed
            && this.modernPulseTiming
            && this.enabled
            && frequencyBeforeWrite >> 8 === 0x07
            && (value & 0x07) !== 0x07
            && this.triggerLowFrequencyDivider !== 0
            && this.timer === 4) {
            this.timer += 2;
        }

        this.frequency = (this.frequency & 0x00ff) | ((value & 0x07) << 8);

        if (this.timerJustReloaded) {
            this.timer = this.period();
        }

        const lengthEnabled = ((value >> 6) & 1) !== 0;

        if (triggered) {
            if (this.hasSweep
                && this.enabled
                && this.sweepShift !== 0
                && (this.sweepCalculationReloadDelay > 0
                    || this.sweepCalculationCountdown > 0)) {
                this.frequency = frequencyBeforeWrite;
            }

            this.trigger(lowFrequencyDivider);
        }

        if ((lengthEnabled || this.legacyLengthWrites)
            && !this.lengthEnabled
            && extraLengthClock
            && this.lengthCounter > 0) {
            this.lengthCounter--;

            if (this.lengthCounter === 0) {
                if (triggered) {
                    this.lengthCounter = 63;
                } else {
                    this.enabled = false;
                }
            }
        }

        this.lengthEnabled = lengthEnabled;
    }

    cyclesUntilTimerEvent(): number {

        const timerEvent = this.enabled
            ? (this.timer > 0 ? this.timer : this.period())
            : Number.POSITIVE_INFINITY;
        const sweepEvent = this.cyclesUntilSweepEvent();

        return Math.min(timerEvent, sweepEvent);
    }

    advance(cycles: number): void {

        this.timerJustReloaded = false;
        this.pcmReadMask = 0x0f;
        this.advanceSweep(cycles);

        if (!this.enabled) {
            return;
        }

        const period = this.period();

        if (this.timer <= 0) {
            this.timer = period;
        }

        if (cycles < this.timer) {
            this.timer -= cycles;

            return;
        }

        const remaining = cycles - this.timer;
        const advances = 1 + Math.floor(remaining / period);
        const positionBeforeLastEdge = (this.dutyPosition + advances - 1) & 0x07;
        const pattern = DUTY_PATTERNS[this.duty] ?? DUTY_PATTERNS[0];
        const sampleBeforeLastEdge = this.outputSuppressed && advances === 1
            ? 0
            : (pattern?.[positionBeforeLastEdge] ?? 0) * this.envelope.volume;

        this.timer = period - (remaining % period);
        this.dutyPosition = (this.dutyPosition + advances) & 0x07;
        this.outputSuppressed = false;
        this.timerJustReloaded = remaining % period === 0;

        if (this.timerJustReloaded && sampleBeforeLastEdge === 0) {
            this.pcmReadMask = 0;
        }
    }

    clockLength(): void {

        if (!this.lengthEnabled || this.lengthCounter === 0) {
            return;
        }

        this.lengthCounter--;

        if (this.lengthCounter === 0) {
            this.enabled = false;
        }
    }

    prepareEnvelopeClock(): void {

        this.envelope.prepareClock(this.enabled);
    }

    clockEnvelope(clockCountdown: boolean): void {

        this.envelope.tick(clockCountdown);
    }

    clockSweep(lowFrequencyDivider: number): void {

        if (!this.hasSweep) {
            return;
        }

        this.sweepFrameCounter = (this.sweepFrameCounter + 1) & 0x07;
        this.triggerSweepCalculation(lowFrequencyDivider);
    }

    output(): number {

        if (!this.dacEnabled) {
            return 0;
        }

        return 1 - this.rawOutput() / 7.5;
    }

    rawOutput(): number {

        if (!this.enabled || !this.dacEnabled || this.outputSuppressed) {
            return 0;
        }

        const pattern = DUTY_PATTERNS[this.duty] ?? DUTY_PATTERNS[0];

        return (pattern?.[this.dutyPosition] ?? 0) * this.envelope.volume;
    }

    private trigger(lowFrequencyDivider: number): void {

        const wasEnabled = this.enabled;

        if (!wasEnabled) {
            this.outputSuppressed = true;
        }

        this.enabled = this.dacEnabled;

        if (this.lengthCounter === 0) {
            this.lengthCounter = 64;
            this.lengthEnabled = false;
        }

        this.timer = this.period()
            + (wasEnabled ? 6 : 10)
            - lowFrequencyDivider * 2;
        this.triggerLowFrequencyDivider = lowFrequencyDivider;
        this.timerJustReloaded = false;
        this.envelope.trigger();

        if (this.hasSweep) {
            this.sweepShadow = 0;
            this.sweepAddend = this.sweepShift === 0
                ? 0
                : this.frequency >> this.sweepShift;
            this.sweepCompletedAddend = 0;
            this.sweepFrameCounter = this.sweepPeriod ^ 0x07;
            this.sweepCalculationCountdown = this.sweepShift * 4;
            this.sweepCalculationReloadDelay = this.sweepShift === 0
                ? 0
                : (wasEnabled ? 8 : 6);
            this.sweepRestartHold = (4 - lowFrequencyDivider) * 4;
            this.sweepInstantCalculationPending = false;
            this.sweepUnshiftedCalculation = false;
        }
    }

    private triggerSweepCalculation(lowFrequencyDivider: number): void {

        if (this.sweepPeriod === 0 || this.sweepFrameCounter !== 0x07) {
            return;
        }

        if (this.sweepShift !== 0) {
            this.frequency = (
                this.sweepShadow
                + this.sweepAddend
                + (this.sweepNegate ? 1 : 0)
            ) & 0x07ff;
        }

        if (this.sweepRestartHold === 0) {
            this.sweepAddend = this.frequency >> this.sweepShift;
        }

        this.sweepCalculationCountdown = this.sweepShift * 4;
        this.sweepCalculationReloadDelay = (1 + lowFrequencyDivider) * 2;
        this.sweepInstantCalculationPending = this.sweepShift === 0;
        this.sweepUnshiftedCalculation = this.sweepShift === 0;
        this.sweepFrameCounter = this.sweepPeriod ^ 0x07;
    }

    private cyclesUntilSweepEvent(): number {

        if (!this.hasSweep) {
            return Number.POSITIVE_INFINITY;
        }

        const calculationEvent = this.sweepCalculationReloadDelay > 0
            ? this.sweepCalculationReloadDelay
            : this.sweepCalculationCountdown > 0
                && (this.sweepShift !== 0 || this.sweepUnshiftedCalculation)
                ? this.sweepCalculationCountdown
                : Number.POSITIVE_INFINITY;
        const holdEvent = this.sweepRestartHold > 0
            ? this.sweepRestartHold
            : Number.POSITIVE_INFINITY;

        return Math.min(calculationEvent, holdEvent);
    }

    private advanceSweep(cycles: number): void {

        this.sweepRestartHold = Math.max(0, this.sweepRestartHold - cycles);

        let calculationCycles = cycles;

        if (this.sweepCalculationReloadDelay > 0) {
            const consumed = Math.min(
                calculationCycles,
                this.sweepCalculationReloadDelay,
            );

            this.sweepCalculationReloadDelay -= consumed;
            calculationCycles -= consumed;

            if (this.sweepCalculationReloadDelay > 0) {
                return;
            }

            if (this.sweepInstantCalculationPending) {
                this.sweepInstantCalculationPending = false;
                this.completeSweepCalculation();
            }
        }

        if (this.sweepCalculationCountdown === 0
            || calculationCycles === 0
            || (this.sweepShift === 0 && !this.sweepUnshiftedCalculation)) {
            return;
        }

        this.sweepCalculationCountdown = Math.max(
            0,
            this.sweepCalculationCountdown - calculationCycles,
        );

        if (this.sweepCalculationCountdown === 0) {
            this.completeSweepCalculation();
        }
    }

    private completeSweepCalculation(): void {

        if (this.sweepRestartHold === 0) {
            this.sweepShadow = this.frequency;
        }

        if (this.sweepNegate) {
            this.sweepAddend ^= 0x07ff;
        }

        if (!this.sweepNegate
            && this.sweepShadow + this.sweepAddend > 0x07ff) {
            this.enabled = false;
        }

        this.sweepCompletedAddend = this.sweepAddend;
    }

    private applySweepWriteGlitch(
        value: number,
        lowFrequencyDivider: number,
        doubleSpeed: boolean,
    ): void {

        const newShift = value & 0x07;

        if (!this.legacySweepWrites) {
            if (this.sweepCalculationReloadDelay === 4) {
                this.sweepCalculationCountdown = newShift * 4;

                if (newShift === 0) {
                    this.sweepCalculationReloadDelay = 0;
                }
            }

            if (newShift !== 0
                && this.sweepShift === 0
                && lowFrequencyDivider === 0
                && this.sweepCalculationCountdown > 4) {
                this.sweepCalculationCountdown -= 4;
            }

            return;
        }

        if (this.sweepCalculationReloadDelay === 2
            && lowFrequencyDivider === 0) {
            if (doubleSpeed) {
                const corruption = [7, 7, 5, 7, 3, 3, 5, 7];
                const countdown = Math.ceil(this.sweepCalculationCountdown / 4) & 0x07;

                this.sweepCalculationCountdown = (corruption[countdown] ?? 7) * 4;
            }

            return;
        }

        if (this.sweepCalculationReloadDelay > 2) {
            if (doubleSpeed) {
                this.sweepCalculationCountdown = newShift * 4;
            }

            return;
        }

        if (this.sweepCalculationCountdown === 0) {
            return;
        }

        const shouldStep = this.sweepShift === 0
            ? (lowFrequencyDivider !== 0) !== doubleSpeed
            : doubleSpeed && this.sweepCalculationCountdown <= 4;

        if (!shouldStep) {
            return;
        }

        this.sweepCalculationCountdown -= 4;

        if (this.sweepCalculationCountdown <= 4) {
            this.sweepCalculationCountdown = 0;
            this.completeSweepCalculation();
        }
    }

    private period(): number {

        return (0x0800 - this.frequency) * 4;
    }
}

class WaveChannel {

    enabled = false;
    private dacEnabled = false;
    private timer = 0;
    private frequency = 0;
    private lengthCounter = 0;
    private lengthEnabled = false;
    private outputLevel = 0;
    private position = 0;
    private currentSampleByte = 0;
    private waveRAMJustRead = false;
    private readonly cgbHardware: boolean;
    private readonly legacyLengthWrites: boolean;
    private readonly waveRAM: Uint8Array;

    constructor(waveRAM: Uint8Array, cgbHardware: boolean, legacyLengthWrites: boolean) {

        this.waveRAM = waveRAM;
        this.cgbHardware = cgbHardware;
        this.legacyLengthWrites = legacyLengthWrites;
    }

    get isDACEnabled(): boolean {

        return this.dacEnabled;
    }

    reset(): void {

        this.enabled = false;
        this.dacEnabled = false;
        this.timer = 0;
        this.frequency = 0;
        this.lengthCounter = 0;
        this.lengthEnabled = false;
        this.outputLevel = 0;
        this.position = 0;
        this.currentSampleByte = 0;
        this.waveRAMJustRead = false;
    }

    writeDAC(value: number): void {

        this.dacEnabled = ((value >> 7) & 1) !== 0;

        if (!this.dacEnabled) {
            this.enabled = false;
        }
    }

    writeLength(value: number): void {

        this.lengthCounter = 256 - value;
    }

    writeOutputLevel(value: number): void {

        this.outputLevel = (value >> 5) & 0x03;
    }

    writeFrequencyLow(value: number): void {

        this.frequency = (this.frequency & 0x0700) | value;
    }

    writeControl(value: number, extraLengthClock: boolean): void {

        this.frequency = (this.frequency & 0x00ff) | ((value & 0x07) << 8);

        const lengthEnabled = ((value >> 6) & 1) !== 0;
        const triggered = ((value >> 7) & 1) !== 0;

        if (triggered) {
            const fetchPending = this.enabled && this.timer === 1;

            if (!this.cgbHardware && fetchPending) {
                const offset = ((this.position + 1) >> 1) & 0x0f;

                if (offset < 4) {
                    this.waveRAM[0] = this.waveRAM[offset] ?? 0;
                } else {
                    this.waveRAM.copyWithin(0, offset & ~3, (offset & ~3) + 4);
                }
            }

            this.enabled = this.dacEnabled;

            if (this.lengthCounter === 0) {
                this.lengthCounter = 256;
                this.lengthEnabled = false;
            }

            this.position = 0;
            this.timer = this.period() + 6;

            if (fetchPending) {
                this.currentSampleByte = this.waveRAM[0] ?? 0;
            }

            this.waveRAMJustRead = false;
        }

        if ((lengthEnabled || this.legacyLengthWrites)
            && !this.lengthEnabled
            && extraLengthClock
            && this.lengthCounter > 0) {
            this.lengthCounter--;

            if (this.lengthCounter === 0) {
                if (triggered) {
                    this.lengthCounter = 255;
                } else {
                    this.enabled = false;
                }
            }
        }

        this.lengthEnabled = lengthEnabled;
    }

    cyclesUntilTimerEvent(): number {

        if (!this.enabled) {
            return Number.POSITIVE_INFINITY;
        }

        return this.timer > 0 ? this.timer : this.period();
    }

    advance(cycles: number): void {

        this.waveRAMJustRead = false;

        if (!this.enabled) {
            return;
        }

        const period = this.period();

        if (this.timer <= 0) {
            this.timer = period;
        }

        if (cycles < this.timer) {
            this.timer -= cycles;

            return;
        }

        const remaining = cycles - this.timer;
        const advances = 1 + Math.floor(remaining / period);

        this.timer = period - (remaining % period);
        this.position = (this.position + advances) & 0x1f;
        this.currentSampleByte = this.waveRAM[this.position >> 1] ?? 0;
        this.waveRAMJustRead = remaining % period === 0;
    }

    clockLength(): void {

        if (!this.lengthEnabled || this.lengthCounter === 0) {
            return;
        }

        this.lengthCounter--;

        if (this.lengthCounter === 0) {
            this.enabled = false;
        }
    }

    output(): number {

        if (!this.dacEnabled) {
            return 0;
        }

        return 1 - this.rawOutput() / 7.5;
    }

    rawOutput(): number {

        if (!this.enabled || !this.dacEnabled || this.outputLevel === 0) {
            return 0;
        }

        const sample = (this.position & 1) === 0
            ? this.currentSampleByte >> 4
            : this.currentSampleByte & 0x0f;

        return sample >> (this.outputLevel - 1);
    }

    readWaveRAM(address: number): number {

        if (!this.enabled) {
            return this.waveRAM[address] ?? 0xff;
        }

        if (!this.cgbHardware && !this.waveRAMJustRead) {
            return 0xff;
        }

        return this.waveRAM[this.position >> 1] ?? 0xff;
    }

    writeWaveRAM(address: number, value: number): void {

        if (!this.enabled) {
            this.waveRAM[address] = value;

            return;
        }

        if (!this.cgbHardware && !this.waveRAMJustRead) {
            return;
        }

        this.waveRAM[this.position >> 1] = value;
    }

    private period(): number {

        return (0x0800 - this.frequency) * 2;
    }
}

class NoiseChannel {

    enabled = false;
    private dacEnabled = false;
    private timer = 0;
    private timerJustReloaded = false;
    private counter = 0;
    private alignment = 0;
    private backgroundCounterActive = false;
    private lengthCounter = 0;
    private lengthEnabled = false;
    private readonly envelope = new VolumeEnvelope();
    private readonly legacyEnvelopeWrites: boolean;
    private clockShift = 0;
    private widthMode = false;
    private divisorCode = 0;
    private lfsr = 0x7fff;
    private pcmReadMask = 0x0f;
    private readonly cgbHardware: boolean;
    private readonly modernNoiseTiming: boolean;

    constructor(legacyEnvelopeWrites: boolean, cgbHardware: boolean, modernNoiseTiming: boolean) {

        this.legacyEnvelopeWrites = legacyEnvelopeWrites;
        this.cgbHardware = cgbHardware;
        this.modernNoiseTiming = modernNoiseTiming;
    }

    get isDACEnabled(): boolean {

        return this.dacEnabled;
    }

    get pcmOutput(): number {

        return this.rawOutput() & this.pcmReadMask;
    }

    reset(): void {

        this.enabled = false;
        this.dacEnabled = false;
        this.timer = 0;
        this.timerJustReloaded = false;
        this.counter = 0;
        this.alignment = 0;
        this.backgroundCounterActive = false;
        this.lengthCounter = 0;
        this.lengthEnabled = false;
        this.envelope.reset();
        this.clockShift = 0;
        this.widthMode = false;
        this.divisorCode = 0;
        this.lfsr = 0x7fff;
        this.pcmReadMask = 0x0f;
    }

    writeLength(value: number): void {

        this.lengthCounter = 64 - (value & 0x3f);
    }

    writeEnvelope(value: number): void {

        this.dacEnabled = this.envelope.write(value, this.enabled, this.legacyEnvelopeWrites);

        if (!this.dacEnabled) {
            this.enabled = false;
        }
    }

    writePolynomial(value: number): void {

        if (this.timerJustReloaded) {
            const divisor = ((value & 0x07) << 2) || 2;
            const phase = (this.alignment >> 1) & 0x03;
            const adjustment = divisor === 2
                ? 0
                : (this.modernNoiseTiming ? [2, 1, 0, 3] : [2, 1, 4, 3])[phase] ?? 0;

            this.timer = (divisor + adjustment) * 2;
        }

        if (this.cgbHardware && !this.modernNoiseTiming) {
            const oldShift = this.clockShift;
            const newShift = value >> 4;
            const oldBit = (this.counter >> oldShift) & 1;
            const newBit = (this.counter >> newShift) & 1;
            const glitchBit = (this.counter >> 7) & 1;

            if (this.timerJustReloaded
                && oldBit === 0
                && newBit !== 0
                && glitchBit !== 0) {
                const previousCounter = (this.counter - 1) & 0x3fff;
                const previousOldBit = (previousCounter >> oldShift) & 1;
                const previousNewBit = (previousCounter >> newShift) & 1;
                const previousGlitchBit = (previousCounter >> 7) & 1;

                if (previousOldBit !== 0
                    && previousNewBit === 0
                    && previousGlitchBit !== 0) {
                    this.clockLFSR();
                }
            }

            this.applyLegacyPolynomialTransition(0xff);
            this.applyLegacyPolynomialTransition(value);

            return;
        }

        this.clockShift = value >> 4;
        this.widthMode = ((value >> 3) & 1) !== 0;
        this.divisorCode = value & 0x07;
    }

    writeControl(value: number, extraLengthClock: boolean): void {

        const lengthEnabled = ((value >> 6) & 1) !== 0;
        const triggered = ((value >> 7) & 1) !== 0;

        if (triggered) {
            const wasEnabled = this.enabled;

            this.prepareStart(wasEnabled);
            this.enabled = this.dacEnabled;

            if (this.lengthCounter === 0) {
                this.lengthCounter = 64;
                this.lengthEnabled = false;
            }

            this.lfsr = 0x7fff;
            this.envelope.trigger();
        }

        if (lengthEnabled
            && !this.lengthEnabled
            && extraLengthClock
            && this.lengthCounter > 0) {
            this.lengthCounter--;

            if (this.lengthCounter === 0) {
                if (triggered) {
                    this.lengthCounter = 63;
                } else {
                    this.enabled = false;
                }
            }
        }

        this.lengthEnabled = lengthEnabled;
    }

    cyclesUntilTimerEvent(): number {

        if (!this.enabled && !this.backgroundCounterActive) {
            return Number.POSITIVE_INFINITY;
        }

        return this.timer > 0 ? this.timer : this.counterPeriod();
    }

    advance(cycles: number, applyPCMReadGlitch: boolean): void {

        this.timerJustReloaded = false;
        this.pcmReadMask = 0x0f;

        if (!this.enabled && !this.backgroundCounterActive) {
            this.alignment = (this.alignment + cycles) & 0x07;

            return;
        }

        const period = this.counterPeriod();

        if (this.timer <= 0) {
            this.timer = period;
        }

        if (cycles < this.timer) {
            this.timer -= cycles;
            this.alignment = (this.alignment + cycles) & 0x07;

            return;
        }

        let remaining = cycles - this.timer;

        this.clockCounter(applyPCMReadGlitch && remaining === 0);

        while (remaining >= period) {
            remaining -= period;
            this.clockCounter(applyPCMReadGlitch && remaining === 0);
        }

        this.timer = period - remaining;
        this.timerJustReloaded = remaining === 0;
        this.alignment = (this.alignment + cycles) & 0x07;
    }

    clockLength(): void {

        if (!this.lengthEnabled || this.lengthCounter === 0) {
            return;
        }

        this.lengthCounter--;

        if (this.lengthCounter === 0) {
            this.enabled = false;
        }
    }

    prepareEnvelopeClock(): void {

        this.envelope.prepareClock(this.enabled);
    }

    clockEnvelope(clockCountdown: boolean): void {

        this.envelope.tick(clockCountdown);
    }

    output(): number {

        if (!this.dacEnabled) {
            return 0;
        }

        return 1 - this.rawOutput() / 7.5;
    }

    rawOutput(): number {

        if (!this.enabled || !this.dacEnabled) {
            return 0;
        }

        return ((~this.lfsr) & 1) * this.envelope.volume;
    }

    private clockLFSR(): void {

        const bit = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);

        this.lfsr = (this.lfsr >> 1) | (bit << 14);

        if (this.widthMode) {
            this.lfsr = (this.lfsr & ~(1 << 6)) | (bit << 6);
        }
    }

    private applyLegacyPolynomialTransition(value: number): void {

        const oldValue = (this.clockShift << 4)
            | (this.widthMode ? 0x08 : 0)
            | this.divisorCode;
        const oldShift = this.clockShift;

        this.clockShift = value >> 4;
        this.widthMode = ((value >> 3) & 1) !== 0;
        this.divisorCode = value & 0x07;

        if ((oldValue & 0xf0) === (value & 0xf0)) {
            return;
        }

        const effectiveCounter = this.timerJustReloaded
            ? this.counter | ((this.counter - 1) & 0x3fff)
            : this.counter;
        const oldBit = (effectiveCounter >> oldShift) & 1;
        const newBit = (effectiveCounter >> this.clockShift) & 1;
        const glitchShift = (((oldValue & 0x7f) | (value & 0x80)) >> 4);
        const glitchBit = (effectiveCounter >> glitchShift) & 1;

        if (oldBit === newBit && newBit !== glitchBit) {
            if (newBit === 0) {
                this.clockLFSR();
            }

            return;
        }

        if (oldBit === 0 && newBit !== 0) {
            const newWidthMode = this.widthMode;

            this.widthMode = true;
            this.clockLFSR();
            this.widthMode = newWidthMode;

            if ((value & 0xf0) <= 0x20
                && glitchBit !== 0
                && (effectiveCounter & 0x08) === 0) {
                this.clockLFSR();

                const outputMask = this.widthMode ? 0x4040 : 0x4000;
                const sourceMask = this.widthMode ? 0x2020 : 0x2000;

                this.lfsr &= ~outputMask;
                this.lfsr |= (this.lfsr & sourceMask) << 1;
            }

            return;
        }

        if ((value & 0xf0) <= 0x20
            && glitchBit === 0
            && newBit === 0
            && oldBit === 0
            && (effectiveCounter & 0x08) !== 0) {
            this.clockLFSR();
        }
    }

    private clockCounter(maskPCMRead: boolean): void {

        const mask = 1 << this.clockShift;
        const oldBit = (this.counter & mask) !== 0;

        this.counter = (this.counter + 1) & 0x3fff;

        if (!oldBit && (this.counter & mask) !== 0 && this.enabled) {
            if (maskPCMRead && this.rawOutput() === 0) {
                this.pcmReadMask = 0;
            }

            this.clockLFSR();
        }
    }

    private prepareStart(wasEnabled: boolean): void {

        if (!this.cgbHardware) {
            this.timer = this.samplePeriod();
            this.backgroundCounterActive = true;

            return;
        }

        const wasBackgroundCounting = this.backgroundCounterActive;
        const phase = (this.alignment >> 1) & 0x03;
        let countdown = this.divisorCode === 0 ? 6 : this.divisorCode * 4 + 6;

        this.backgroundCounterActive = true;

        if ((phase & 1) !== 0) {
            if (this.divisorCode === 0) {
                countdown += this.modernNoiseTiming && wasBackgroundCounting ? -1 : 1;
            } else if ((phase & 2) !== 0) {
                countdown += this.divisorCode === 1 && !wasEnabled ? 1 : -3;
            } else {
                countdown--;

                if (this.divisorCode === 1 && wasEnabled) {
                    countdown -= 4;
                }
            }
        } else if (this.divisorCode !== 0) {
            if ((phase & 2) !== 0) {
                countdown -= 2;
            } else if (this.divisorCode > 1 && this.modernNoiseTiming) {
                countdown -= 4;
            }
        }

        this.timer = countdown * 2;
        this.timerJustReloaded = false;
    }

    private counterPeriod(): number {

        return (((this.divisorCode << 2) || 2) * 2);
    }

    private samplePeriod(): number {

        return (NOISE_DIVISORS[this.divisorCode] ?? 8) << this.clockShift;
    }
}

export class DMGAPU {

    readonly sampleRate: number;
    readonly waveRAM = new Uint8Array(16);
    private readonly bufferCapacity: number;
    private readonly leftBuffer: Float32Array;
    private readonly rightBuffer: Float32Array;
    private readonly registers = new Uint8Array(0x17);
    private readonly pulse1: PulseChannel;
    private readonly pulse2: PulseChannel;
    private readonly wave: WaveChannel;
    private readonly noise: NoiseChannel;
    private readonly capacitorChargeFactor: number;
    private readonly legacyPCMReadGlitch: boolean;
    private doubleSpeed = false;
    private powered = false;
    private divider = 0;
    private pulseDivider = 0;
    private frameSequencerStep = 0;
    private sampleAccumulator = 0;
    private sampleCycles = 0;
    private sampleLeftIntegral = 0;
    private sampleRightIntegral = 0;
    private leftCapacitor = 0;
    private rightCapacitor = 0;
    private bufferReadIndex = 0;
    private bufferWriteIndex = 0;
    private bufferLength = 0;
    private droppedSampleCount = 0;

    constructor(options: DMGAPUOptions = {}) {

        const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
        const bufferCapacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
        const modernEnvelopeWrites = options.model === 'cgb'
            && (options.cgbRevision === 'd' || options.cgbRevision === 'e');
        const legacyLengthWrites = options.model === 'cgb'
            && (options.cgbRevision === '0'
                || options.cgbRevision === 'a'
                || options.cgbRevision === 'b');

        if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > GAME_BOY_CLOCK_HZ) {
            throw new RangeError(`Expected an integer audio sample rate from 1 to ${GAME_BOY_CLOCK_HZ}, received ${sampleRate}.`);
        }

        if (!Number.isInteger(bufferCapacity) || bufferCapacity <= 0) {
            throw new RangeError(`Expected a positive integer audio buffer capacity, received ${bufferCapacity}.`);
        }

        this.sampleRate = sampleRate;
        this.bufferCapacity = bufferCapacity;
        this.pulse1 = new PulseChannel(
            true,
            !modernEnvelopeWrites,
            legacyLengthWrites,
            modernEnvelopeWrites,
        );
        this.pulse2 = new PulseChannel(
            false,
            !modernEnvelopeWrites,
            legacyLengthWrites,
            modernEnvelopeWrites,
        );
        this.wave = new WaveChannel(this.waveRAM, options.model === 'cgb', legacyLengthWrites);
        this.noise = new NoiseChannel(
            !modernEnvelopeWrites,
            options.model === 'cgb',
            modernEnvelopeWrites,
        );
        this.legacyPCMReadGlitch = options.model === 'cgb'
            && options.cgbRevision !== 'd'
            && options.cgbRevision !== 'e';
        this.capacitorChargeFactor = options.model === 'cgb'
            ? CGB_CAPACITOR_CHARGE_FACTOR
            : DMG_CAPACITOR_CHARGE_FACTOR;
        this.leftBuffer = new Float32Array(bufferCapacity);
        this.rightBuffer = new Float32Array(bufferCapacity);
    }

    get isPowered(): boolean {

        return this.powered;
    }

    get activeChannels(): number {

        return (this.pulse1.enabled ? 0x01 : 0)
            | (this.pulse2.enabled ? 0x02 : 0)
            | (this.wave.enabled ? 0x04 : 0)
            | (this.noise.enabled ? 0x08 : 0);
    }

    get pcm12(): number {

        if (this.legacyPCMReadGlitch) {
            return this.pulse1.pcmOutput | (this.pulse2.pcmOutput << 4);
        }

        return this.pulse1.rawOutput() | (this.pulse2.rawOutput() << 4);
    }

    get pcm34(): number {

        const noiseOutput = this.legacyPCMReadGlitch
            ? this.noise.pcmOutput
            : this.noise.rawOutput();

        return this.wave.rawOutput() | (noiseOutput << 4);
    }

    get bufferedSamples(): number {

        return this.bufferLength;
    }

    get droppedSamples(): number {

        return this.droppedSampleCount;
    }

    read(address: number): number {

        if (address >= 0xff30 && address <= 0xff3f) {
            return this.wave.readWaveRAM(address - 0xff30);
        }

        if (address < 0xff10 || address > 0xff26) {
            return 0xff;
        }

        if (address === 0xff26) {
            return 0x70 | (this.powered ? 0x80 : 0) | this.activeChannels;
        }

        const offset = address - 0xff10;

        return (this.registers[offset] ?? 0) | (APU_READ_MASKS[offset] ?? 0xff);
    }

    write(address: number, value: number): void {

        if (address >= 0xff30 && address <= 0xff3f) {
            this.wave.writeWaveRAM(address - 0xff30, value);

            return;
        }

        if (address === 0xff26) {
            this.setPower(((value >> 7) & 1) !== 0);

            return;
        }

        if (address < 0xff10 || address > 0xff25) {
            return;
        }

        if (!this.powered) {
            this.writeLengthWhilePoweredOff(address, value);

            return;
        }

        this.registers[address - 0xff10] = value;

        switch (address) {
            case 0xff10:
                this.pulse1.writeSweep(
                    value,
                    this.lowFrequencyDivider(),
                    this.doubleSpeed,
                );
                break;
            case 0xff11:
                this.pulse1.writeDutyLength(value);
                break;
            case 0xff12:
                this.pulse1.writeEnvelope(value);
                break;
            case 0xff13:
                this.pulse1.writeFrequencyLow(value);
                break;
            case 0xff14:
                this.pulse1.writeControl(
                    value,
                    this.lowFrequencyDivider(),
                    this.shouldExtraLengthClock(),
                    this.doubleSpeed,
                );
                break;
            case 0xff16:
                this.pulse2.writeDutyLength(value);
                break;
            case 0xff17:
                this.pulse2.writeEnvelope(value);
                break;
            case 0xff18:
                this.pulse2.writeFrequencyLow(value);
                break;
            case 0xff19:
                this.pulse2.writeControl(
                    value,
                    this.lowFrequencyDivider(),
                    this.shouldExtraLengthClock(),
                    this.doubleSpeed,
                );
                break;
            case 0xff1a:
                this.wave.writeDAC(value);
                break;
            case 0xff1b:
                this.wave.writeLength(value);
                break;
            case 0xff1c:
                this.wave.writeOutputLevel(value);
                break;
            case 0xff1d:
                this.wave.writeFrequencyLow(value);
                break;
            case 0xff1e:
                this.wave.writeControl(value, this.shouldExtraLengthClock());
                break;
            case 0xff20:
                this.noise.writeLength(value);
                break;
            case 0xff21:
                this.noise.writeEnvelope(value);
                break;
            case 0xff22:
                this.noise.writePolynomial(value);
                break;
            case 0xff23:
                this.noise.writeControl(value, this.shouldExtraLengthClock());
                break;
        }
    }

    tick(cycles: number): void {

        let remainingCycles = cycles;

        while (remainingCycles > 0) {
            const dividerPhase = this.divider & 0x1fff;
            const cyclesToFrameSequencer = 0x2000 - dividerPhase;
            const cyclesToEnvelopeClock = dividerPhase < 0x1000
                ? 0x1000 - dividerPhase
                : 0x3000 - dividerPhase;
            const cyclesToSample = Math.ceil(
                (GAME_BOY_CLOCK_HZ - this.sampleAccumulator) / this.sampleRate,
            );
            const cyclesToChannelEvent = this.powered
                ? Math.min(
                    this.pulse1.cyclesUntilTimerEvent(),
                    this.pulse2.cyclesUntilTimerEvent(),
                    this.wave.cyclesUntilTimerEvent(),
                    this.noise.cyclesUntilTimerEvent(),
                )
                : Number.POSITIVE_INFINITY;
            const step = Math.min(
                remainingCycles,
                cyclesToFrameSequencer,
                cyclesToEnvelopeClock,
                cyclesToSample,
                cyclesToChannelEvent,
            );

            if (this.powered) {
                this.integrateAnalogOutput(step);
            }

            this.sampleCycles += step;

            if (this.powered) {
                this.advanceChannels(step);
                this.pulseDivider = (this.pulseDivider + step) & 0x03;
            }

            this.divider = (this.divider + step) & 0xffff;
            this.sampleAccumulator += step * this.sampleRate;
            remainingCycles -= step;

            if (step === cyclesToFrameSequencer && this.powered) {
                this.clockFrameSequencer();
            }

            if (step === cyclesToEnvelopeClock && this.powered) {
                this.prepareEnvelopeClocks();
            }

            if (this.sampleAccumulator >= GAME_BOY_CLOCK_HZ) {
                this.sampleAccumulator -= GAME_BOY_CLOCK_HZ;
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

    resetDivider(): void {

        if (this.powered && ((this.divider >> 12) & 1) !== 0) {
            this.clockFrameSequencer();
        }

        this.divider = 0;
    }

    setDoubleSpeed(doubleSpeed: boolean): void {

        this.doubleSpeed = doubleSpeed;
    }

    drainAudio(): AudioBuffer {

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

        this.powered = false;
        this.doubleSpeed = false;
        this.divider = 0;
        this.pulseDivider = 0;
        this.frameSequencerStep = 0;
        this.sampleAccumulator = 0;
        this.sampleCycles = 0;
        this.sampleLeftIntegral = 0;
        this.sampleRightIntegral = 0;
        this.leftCapacitor = 0;
        this.rightCapacitor = 0;
        this.registers.fill(0);
        this.waveRAM.fill(0);
        this.pulse1.reset();
        this.pulse2.reset();
        this.wave.reset();
        this.noise.reset();
        this.bufferReadIndex = 0;
        this.bufferWriteIndex = 0;
        this.bufferLength = 0;
        this.droppedSampleCount = 0;
    }

    private setPower(powered: boolean): void {

        if (powered === this.powered) {
            return;
        }

        this.powered = powered;
        this.frameSequencerStep = 0;

        if (!powered) {
            this.registers.fill(0);
            this.pulse1.reset();
            this.pulse2.reset();
            this.wave.reset();
            this.noise.reset();
        } else {
            this.pulseDivider = 0;
        }
    }

    private lowFrequencyDivider(): number {

        return 1 ^ ((this.pulseDivider >> 1) & 1);
    }

    private shouldExtraLengthClock(): boolean {

        return (this.frameSequencerStep & 1) !== 0;
    }

    private writeLengthWhilePoweredOff(address: number, value: number): void {

        switch (address) {
            case 0xff11:
                this.pulse1.writeLength(value);
                break;
            case 0xff16:
                this.pulse2.writeLength(value);
                break;
            case 0xff1b:
                this.wave.writeLength(value);
                break;
            case 0xff20:
                this.noise.writeLength(value);
                break;
        }
    }

    private advanceChannels(cycles: number): void {

        this.pulse1.advance(cycles);
        this.pulse2.advance(cycles);
        this.wave.advance(cycles);
        this.noise.advance(cycles, this.legacyPCMReadGlitch && !this.doubleSpeed);
    }

    private clockFrameSequencer(): void {

        const clockEnvelopeCountdown = this.frameSequencerStep === 6;

        this.pulse1.clockEnvelope(clockEnvelopeCountdown);
        this.pulse2.clockEnvelope(clockEnvelopeCountdown);
        this.noise.clockEnvelope(clockEnvelopeCountdown);

        if ((this.frameSequencerStep & 1) === 0) {
            this.pulse1.clockLength();
            this.pulse2.clockLength();
            this.wave.clockLength();
            this.noise.clockLength();
        }

        if (this.frameSequencerStep === 2 || this.frameSequencerStep === 6) {
            this.pulse1.clockSweep(this.lowFrequencyDivider());
        }

        this.frameSequencerStep = (this.frameSequencerStep + 1) & 0x07;
    }

    private prepareEnvelopeClocks(): void {

        this.pulse1.prepareEnvelopeClock();
        this.pulse2.prepareEnvelopeClock();
        this.noise.prepareEnvelopeClock();
    }

    private mix(): [number, number] {

        const routing = this.registers[0x15] ?? 0;
        const volume = this.registers[0x14] ?? 0;
        const outputs = [
            this.pulse1.output(),
            this.pulse2.output(),
            this.wave.output(),
            this.noise.output(),
        ];
        let left = 0;
        let right = 0;

        for (let channel = 0; channel < outputs.length; channel++) {
            const output = outputs[channel] ?? 0;

            if (((routing >> channel) & 1) !== 0) {
                right += output;
            }

            if (((routing >> (channel + 4)) & 1) !== 0) {
                left += output;
            }
        }

        const leftVolume = ((volume >> 4) & 0x07) + 1;
        const rightVolume = (volume & 0x07) + 1;

        return [left * leftVolume / 32, right * rightVolume / 32];
    }

    private integrateAnalogOutput(cycles: number): void {

        const dacsEnabled = this.pulse1.isDACEnabled
            || this.pulse2.isDACEnabled
            || this.wave.isDACEnabled
            || this.noise.isDACEnabled;

        if (!dacsEnabled) {
            return;
        }

        const [left, right] = this.mix();
        const decay = this.capacitorChargeFactor ** cycles;
        const integralFactor = (1 - decay) / (1 - this.capacitorChargeFactor);
        const leftDifference = left - this.leftCapacitor;
        const rightDifference = right - this.rightCapacitor;

        this.sampleLeftIntegral += leftDifference * integralFactor;
        this.sampleRightIntegral += rightDifference * integralFactor;
        this.leftCapacitor = left - leftDifference * decay;
        this.rightCapacitor = right - rightDifference * decay;
    }

    private pushSample(left: number, right: number): void {

        if (this.bufferLength === this.bufferCapacity) {
            this.bufferReadIndex = (this.bufferReadIndex + 1) % this.bufferCapacity;
            this.droppedSampleCount++;
        } else {
            this.bufferLength++;
        }

        this.leftBuffer[this.bufferWriteIndex] = Math.max(-1, Math.min(1, left));
        this.rightBuffer[this.bufferWriteIndex] = Math.max(-1, Math.min(1, right));
        this.bufferWriteIndex = (this.bufferWriteIndex + 1) % this.bufferCapacity;
    }
}
