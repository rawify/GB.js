const FRAME_SEQUENCER_PERIOD = 32768;
const DUTY_PATTERNS: readonly (readonly number[])[] = [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112] as const;

class PSGEnvelope {

    volume = 0;
    private initialVolume = 0;
    private increase = false;
    private period = 0;
    private timer = 0;

    write(value: number): boolean {

        this.initialVolume = (value >> 4) & 0x0f;
        this.increase = (value & 0x08) !== 0;
        this.period = value & 0x07;

        return (value & 0xf8) !== 0;
    }

    trigger(): void {

        this.volume = this.initialVolume;
        this.timer = this.period === 0 ? 8 : this.period;
    }

    clock(): void {

        if (this.period === 0) {
            return;
        }

        this.timer--;

        if (this.timer > 0) {
            return;
        }

        this.timer = this.period;

        if (this.increase && this.volume < 0x0f) {
            this.volume++;
        } else if (!this.increase && this.volume > 0) {
            this.volume--;
        }
    }

    reset(): void {

        this.volume = 0;
        this.initialVolume = 0;
        this.increase = false;
        this.period = 0;
        this.timer = 0;
    }
}

class PSGPulseChannel {

    enabled = false;
    private readonly hasSweep: boolean;
    private readonly envelope = new PSGEnvelope();
    private dacEnabled = false;
    private duty = 0;
    private dutyPosition = 0;
    private frequency = 0;
    private timer = 0;
    private lengthCounter = 0;
    private lengthEnabled = false;
    private sweepPeriod = 0;
    private sweepNegate = false;
    private sweepShift = 0;
    private sweepTimer = 0;
    private sweepEnabled = false;
    private sweepNegateUsed = false;
    private sweepShadow = 0;

    constructor(hasSweep: boolean) {

        this.hasSweep = hasSweep;
    }

    get level(): number {

        if (!this.enabled || !this.dacEnabled) {
            return 0;
        }

        const pattern = DUTY_PATTERNS[this.duty] ?? DUTY_PATTERNS[0];

        return (pattern?.[this.dutyPosition] ?? 0) * this.envelope.volume;
    }

    get output(): number {

        return this.enabled && this.dacEnabled ? this.level / 7.5 - 1 : 0;
    }

    writeSweep(value: number): void {

        if (!this.hasSweep) {
            return;
        }

        const negate = (value & 0x08) !== 0;

        if (this.sweepNegateUsed && !negate) {
            this.enabled = false;
        }

        this.sweepPeriod = (value >> 4) & 0x07;
        this.sweepNegate = negate;
        this.sweepShift = value & 0x07;
    }

    writeDutyLength(value: number): void {

        this.duty = (value >> 6) & 0x03;
        this.lengthCounter = 64 - (value & 0x3f);
    }

    writeEnvelope(value: number): void {

        this.dacEnabled = this.envelope.write(value);

        if (!this.dacEnabled) {
            this.enabled = false;
        }
    }

    writeFrequencyLow(value: number): void {

        this.frequency = (this.frequency & 0x0700) | value;
    }

    writeControl(value: number, extraLengthClock: boolean): void {

        this.frequency = (this.frequency & 0x00ff) | ((value & 0x07) << 8);

        const lengthEnabled = (value & 0x40) !== 0;
        const triggered = (value & 0x80) !== 0;

        if (triggered) {
            this.trigger();
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

    cyclesUntilEvent(): number {

        return this.enabled ? Math.max(1, this.timer) : Number.POSITIVE_INFINITY;
    }

    tick(cycles: number): void {

        if (!this.enabled) {
            return;
        }

        if (this.timer <= 0) {
            this.timer = this.period();
        }

        if (cycles < this.timer) {
            this.timer -= cycles;
            return;
        }

        const period = this.period();
        const remaining = cycles - this.timer;
        const advances = 1 + Math.floor(remaining / period);

        this.dutyPosition = (this.dutyPosition + advances) & 0x07;
        this.timer = period - (remaining % period);
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

    clockEnvelope(): void {

        this.envelope.clock();
    }

    clockSweep(): void {

        if (!this.hasSweep || !this.sweepEnabled) {
            return;
        }

        this.sweepTimer--;

        if (this.sweepTimer > 0) {
            return;
        }

        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;

        if (this.sweepPeriod === 0 || this.sweepShift === 0) {
            return;
        }

        const frequency = this.sweepFrequency();

        if (frequency > 0x07ff) {
            this.enabled = false;
            return;
        }

        this.sweepShadow = frequency;
        this.frequency = frequency;

        if (this.sweepFrequency() > 0x07ff) {
            this.enabled = false;
        }
    }

    reset(): void {

        this.enabled = false;
        this.envelope.reset();
        this.dacEnabled = false;
        this.duty = 0;
        this.dutyPosition = 0;
        this.frequency = 0;
        this.timer = 0;
        this.lengthCounter = 0;
        this.lengthEnabled = false;
        this.sweepPeriod = 0;
        this.sweepNegate = false;
        this.sweepShift = 0;
        this.sweepTimer = 0;
        this.sweepEnabled = false;
        this.sweepNegateUsed = false;
        this.sweepShadow = 0;
    }

    private trigger(): void {

        this.enabled = this.dacEnabled;

        if (this.lengthCounter === 0) {
            this.lengthCounter = 64;
            this.lengthEnabled = false;
        }

        this.timer = this.period();
        this.envelope.trigger();

        if (!this.hasSweep) {
            return;
        }

        this.sweepShadow = this.frequency;
        this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
        this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
        this.sweepNegateUsed = false;

        if (this.sweepShift !== 0 && this.sweepFrequency() > 0x07ff) {
            this.enabled = false;
        }
    }

    private sweepFrequency(): number {

        const delta = this.sweepShadow >> this.sweepShift;

        if (this.sweepNegate) {
            this.sweepNegateUsed = true;
            return this.sweepShadow - delta;
        }

        return this.sweepShadow + delta;
    }

    private period(): number {

        return Math.max(16, (0x0800 - this.frequency) * 16);
    }
}

class PSGWaveChannel {

    readonly waveRAM = new Uint8Array(32);
    enabled = false;
    private dacEnabled = false;
    private dimension = false;
    private bankNumber = 0;
    private position = 0;
    private frequency = 0;
    private timer = 0;
    private lengthCounter = 0;
    private lengthEnabled = false;
    private volumeCode = 0;
    private forceVolume = false;

    get level(): number {

        if (!this.enabled || !this.dacEnabled) {
            return 0;
        }

        const bank = this.playbackBank();
        const bankPosition = this.position & 0x1f;
        const byte = this.waveRAM[bank * 16 + (bankPosition >> 1)] ?? 0;
        const sample = (bankPosition & 1) === 0 ? byte >> 4 : byte & 0x0f;

        if (this.forceVolume) {
            return Math.floor(sample * 3 / 4);
        }

        if (this.volumeCode === 0) {
            return 0;
        }

        return sample >> (this.volumeCode - 1);
    }

    get output(): number {

        if (!this.enabled
            || !this.dacEnabled
            || (!this.forceVolume && this.volumeCode === 0)) {
            return 0;
        }

        return this.level / 7.5 - 1;
    }

    writeBankControl(value: number): void {

        this.dimension = (value & 0x20) !== 0;
        this.bankNumber = (value >> 6) & 1;
        this.dacEnabled = (value & 0x80) !== 0;

        if (!this.dacEnabled) {
            this.enabled = false;
        }
    }

    writeLength(value: number): void {

        this.lengthCounter = 256 - (value & 0xff);
    }

    writeVolume(value: number): void {

        this.volumeCode = (value >> 5) & 0x03;
        this.forceVolume = (value & 0x80) !== 0;
    }

    writeFrequencyLow(value: number): void {

        this.frequency = (this.frequency & 0x0700) | value;
    }

    writeControl(value: number, extraLengthClock: boolean): void {

        this.frequency = (this.frequency & 0x00ff) | ((value & 0x07) << 8);

        const lengthEnabled = (value & 0x40) !== 0;
        const triggered = (value & 0x80) !== 0;

        if (triggered) {
            this.trigger();
        }

        if (lengthEnabled
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

    readWaveByte(index: number): number {

        return this.waveRAM[this.cpuBank() * 16 + (index & 0x0f)] ?? 0;
    }

    writeWaveByte(index: number, value: number): void {

        this.waveRAM[this.cpuBank() * 16 + (index & 0x0f)] = value & 0xff;
    }

    cyclesUntilEvent(): number {

        return this.enabled ? Math.max(1, this.timer) : Number.POSITIVE_INFINITY;
    }

    tick(cycles: number): void {

        if (!this.enabled) {
            return;
        }

        if (this.timer <= 0) {
            this.timer = this.period();
        }

        if (cycles < this.timer) {
            this.timer -= cycles;
            return;
        }

        const period = this.period();
        const remaining = cycles - this.timer;
        const advances = 1 + Math.floor(remaining / period);
        const sampleCount = this.dimension ? 64 : 32;

        this.position = (this.position + advances) % sampleCount;
        this.timer = period - (remaining % period);
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

    reset(clearWaveRAM: boolean): void {

        this.enabled = false;
        this.dacEnabled = false;
        this.dimension = false;
        this.bankNumber = 0;
        this.position = 0;
        this.frequency = 0;
        this.timer = 0;
        this.lengthCounter = 0;
        this.lengthEnabled = false;
        this.volumeCode = 0;
        this.forceVolume = false;

        if (clearWaveRAM) {
            this.waveRAM.fill(0);
        }
    }

    private trigger(): void {

        this.enabled = this.dacEnabled;

        if (this.lengthCounter === 0) {
            this.lengthCounter = 256;
            this.lengthEnabled = false;
        }

        this.position = 0;
        this.timer = this.period();
    }

    private cpuBank(): number {

        return this.playbackBank() ^ 1;
    }

    private playbackBank(): number {

        return this.dimension
            ? (this.bankNumber + (this.position >> 5)) & 1
            : this.bankNumber;
    }

    private period(): number {

        return Math.max(8, (0x0800 - this.frequency) * 8);
    }
}

class PSGNoiseChannel {

    enabled = false;
    private readonly envelope = new PSGEnvelope();
    private dacEnabled = false;
    private timer = 0;
    private lengthCounter = 0;
    private lengthEnabled = false;
    private divisorCode = 0;
    private widthMode = false;
    private shift = 0;
    private lfsr = 0x7fff;

    get level(): number {

        if (!this.enabled || !this.dacEnabled) {
            return 0;
        }

        return ((~this.lfsr) & 1) * this.envelope.volume;
    }

    get output(): number {

        return this.enabled && this.dacEnabled ? this.level / 7.5 - 1 : 0;
    }

    writeLength(value: number): void {

        this.lengthCounter = 64 - (value & 0x3f);
    }

    writeEnvelope(value: number): void {

        this.dacEnabled = this.envelope.write(value);

        if (!this.dacEnabled) {
            this.enabled = false;
        }
    }

    writePolynomial(value: number): void {

        this.divisorCode = value & 0x07;
        this.widthMode = (value & 0x08) !== 0;
        this.shift = (value >> 4) & 0x0f;
    }

    writeControl(value: number, extraLengthClock: boolean): void {

        const lengthEnabled = (value & 0x40) !== 0;
        const triggered = (value & 0x80) !== 0;

        if (triggered) {
            this.trigger();
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

    cyclesUntilEvent(): number {

        return this.enabled ? Math.max(1, this.timer) : Number.POSITIVE_INFINITY;
    }

    tick(cycles: number): void {

        if (!this.enabled) {
            return;
        }

        if (this.timer <= 0) {
            this.timer = this.period();
        }

        if (cycles < this.timer) {
            this.timer -= cycles;
            return;
        }

        const period = this.period();
        const remaining = cycles - this.timer;
        const advances = 1 + Math.floor(remaining / period);

        for (let advance = 0; advance < advances; advance++) {
            const feedback = (this.lfsr ^ (this.lfsr >> 1)) & 1;

            this.lfsr = (this.lfsr >> 1) | (feedback << 14);

            if (this.widthMode) {
                this.lfsr = (this.lfsr & ~(1 << 6)) | (feedback << 6);
            }
        }

        this.timer = period - (remaining % period);
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

    clockEnvelope(): void {

        this.envelope.clock();
    }

    reset(): void {

        this.enabled = false;
        this.envelope.reset();
        this.dacEnabled = false;
        this.timer = 0;
        this.lengthCounter = 0;
        this.lengthEnabled = false;
        this.divisorCode = 0;
        this.widthMode = false;
        this.shift = 0;
        this.lfsr = 0x7fff;
    }

    private trigger(): void {

        this.enabled = this.dacEnabled;

        if (this.lengthCounter === 0) {
            this.lengthCounter = 64;
            this.lengthEnabled = false;
        }

        this.lfsr = 0x7fff;
        this.timer = this.period();
        this.envelope.trigger();
    }

    private period(): number {

        if (this.shift >= 14) {
            return Number.POSITIVE_INFINITY;
        }

        const divisor = NOISE_DIVISORS[this.divisorCode] ?? NOISE_DIVISORS[0];

        return divisor * (1 << this.shift) * 4;
    }
}

export class GBAPSG {

    private readonly registers = new Uint8Array(0x22);
    private readonly pulse1 = new PSGPulseChannel(true);
    private readonly pulse2 = new PSGPulseChannel(false);
    private readonly wave = new PSGWaveChannel();
    private readonly noise = new PSGNoiseChannel();
    private powered = false;
    private frameSequencerStep = 0;
    private frameSequencerCycles = FRAME_SEQUENCER_PERIOD;

    get activeChannels(): number {

        return (this.pulse1.enabled ? 0x01 : 0)
            | (this.pulse2.enabled ? 0x02 : 0)
            | (this.wave.enabled ? 0x04 : 0)
            | (this.noise.enabled ? 0x08 : 0);
    }

    readByte(offset: number): number {

        if (offset >= 0x90 && offset < 0xa0) {
            return this.wave.readWaveByte(offset - 0x90);
        }

        const value = this.registers[offset - 0x60] ?? 0;

        switch (offset) {
            case 0x60:
                return value & 0x7f;
            case 0x62:
            case 0x68:
                return value & 0xc0;
            case 0x63:
            case 0x69:
            case 0x73:
            case 0x79:
            case 0x7c:
            case 0x81:
                return value;
            case 0x80:
                return value & 0x77;
            case 0x70:
                return value & 0xe0;
            case 0x65:
            case 0x6d:
            case 0x75:
            case 0x7d:
                return value & 0x40;
            default:
                return 0;
        }
    }

    writeByte(offset: number, value: number): void {

        if (offset >= 0x90 && offset < 0xa0) {
            this.wave.writeWaveByte(offset - 0x90, value);
            return;
        }

        if (!this.powered || offset < 0x60 || offset > 0x81) {
            return;
        }

        const byte = value & 0xff;
        const register = offset - 0x60;

        switch (offset) {
            case 0x60:
                this.registers[register] = byte & 0x7f;
                this.pulse1.writeSweep(byte);
                return;
            case 0x62:
                this.registers[register] = byte;
                this.pulse1.writeDutyLength(byte);
                return;
            case 0x63:
                this.registers[register] = byte;
                this.pulse1.writeEnvelope(byte);
                return;
            case 0x64:
                this.pulse1.writeFrequencyLow(byte);
                return;
            case 0x65:
                this.registers[register] = byte & 0x40;
                this.pulse1.writeControl(byte, this.shouldExtraLengthClock());
                return;
            case 0x68:
                this.registers[register] = byte;
                this.pulse2.writeDutyLength(byte);
                return;
            case 0x69:
                this.registers[register] = byte;
                this.pulse2.writeEnvelope(byte);
                return;
            case 0x6c:
                this.pulse2.writeFrequencyLow(byte);
                return;
            case 0x6d:
                this.registers[register] = byte & 0x40;
                this.pulse2.writeControl(byte, this.shouldExtraLengthClock());
                return;
            case 0x70:
                this.registers[register] = byte & 0xe0;
                this.wave.writeBankControl(byte);
                return;
            case 0x72:
                this.wave.writeLength(byte);
                return;
            case 0x73:
                this.registers[register] = byte & 0xe0;
                this.wave.writeVolume(byte);
                return;
            case 0x74:
                this.wave.writeFrequencyLow(byte);
                return;
            case 0x75:
                this.registers[register] = byte & 0x40;
                this.wave.writeControl(byte, this.shouldExtraLengthClock());
                return;
            case 0x78:
                this.noise.writeLength(byte);
                return;
            case 0x79:
                this.registers[register] = byte;
                this.noise.writeEnvelope(byte);
                return;
            case 0x7c:
                this.registers[register] = byte;
                this.noise.writePolynomial(byte);
                return;
            case 0x7d:
                this.registers[register] = byte & 0x40;
                this.noise.writeControl(byte, this.shouldExtraLengthClock());
                return;
            case 0x80:
                this.registers[register] = byte & 0x77;
                return;
            case 0x81:
                this.registers[register] = byte;
        }
    }

    setPowered(powered: boolean): void {

        if (this.powered === powered) {
            return;
        }

        this.powered = powered;

        if (!powered) {
            this.clearState();
        }
    }

    cyclesUntilNextEvent(maximumCycles: number): number | undefined {

        if (!this.powered) {
            return undefined;
        }

        if (this.activeChannels === 0) {
            return Math.min(maximumCycles, this.frameSequencerCycles);
        }

        const cycles = Math.min(
            maximumCycles,
            this.frameSequencerCycles,
            this.pulse1.cyclesUntilEvent(),
            this.pulse2.cyclesUntilEvent(),
            this.wave.cyclesUntilEvent(),
            this.noise.cyclesUntilEvent(),
        );

        return Number.isFinite(cycles) ? cycles : undefined;
    }

    tick(cycles: number): void {

        if (!this.powered) {
            return;
        }

        if (this.activeChannels === 0 && cycles < this.frameSequencerCycles) {
            this.frameSequencerCycles -= cycles;
            return;
        }

        let remainingCycles = cycles;

        while (remainingCycles > 0) {
            const step = Math.min(
                remainingCycles,
                this.frameSequencerCycles,
                this.pulse1.cyclesUntilEvent(),
                this.pulse2.cyclesUntilEvent(),
                this.wave.cyclesUntilEvent(),
                this.noise.cyclesUntilEvent(),
            );

            this.pulse1.tick(step);
            this.pulse2.tick(step);
            this.wave.tick(step);
            this.noise.tick(step);
            this.frameSequencerCycles -= step;
            remainingCycles -= step;

            if (this.frameSequencerCycles === 0) {
                this.clockFrameSequencer();
                this.frameSequencerCycles = FRAME_SEQUENCER_PERIOD;
            }
        }
    }

    output(): readonly [number, number] {

        if (!this.powered) {
            return [0, 0];
        }

        const controlLow = (this.registers[0x20] ?? 0) | ((this.registers[0x21] ?? 0) << 8);
        const outputs = [
            this.pulse1.output,
            this.pulse2.output,
            this.wave.output,
            this.noise.output,
        ];
        let left = 0;
        let right = 0;

        for (let channel = 0; channel < outputs.length; channel++) {
            const output = outputs[channel] ?? 0;

            if ((controlLow & (0x0100 << channel)) !== 0) {
                right += output;
            }

            if ((controlLow & (0x1000 << channel)) !== 0) {
                left += output;
            }
        }

        left *= (((controlLow >> 4) & 0x07) + 1) / 32;
        right *= ((controlLow & 0x07) + 1) / 32;

        return [left, right];
    }

    channelLevel(index: number): number {

        if (index === 0) {
            return this.pulse1.level;
        }

        if (index === 1) {
            return this.pulse2.level;
        }

        if (index === 2) {
            return this.wave.level;
        }

        if (index === 3) {
            return this.noise.level;
        }

        return 0;
    }

    reset(): void {

        this.powered = false;
        this.clearState(true);
    }

    private clockFrameSequencer(): void {

        if ((this.frameSequencerStep & 1) === 0) {
            this.pulse1.clockLength();
            this.pulse2.clockLength();
            this.wave.clockLength();
            this.noise.clockLength();
        }

        if (this.frameSequencerStep === 2 || this.frameSequencerStep === 6) {
            this.pulse1.clockSweep();
        }

        if (this.frameSequencerStep === 7) {
            this.pulse1.clockEnvelope();
            this.pulse2.clockEnvelope();
            this.noise.clockEnvelope();
        }

        this.frameSequencerStep = (this.frameSequencerStep + 1) & 0x07;
    }

    private clearState(clearWaveRAM = false): void {

        this.registers.fill(0);
        this.pulse1.reset();
        this.pulse2.reset();
        this.wave.reset(clearWaveRAM);
        this.noise.reset();
        this.frameSequencerStep = 0;
        this.frameSequencerCycles = FRAME_SEQUENCER_PERIOD;
    }

    private shouldExtraLengthClock(): boolean {

        return (this.frameSequencerStep & 1) !== 0;
    }
}
