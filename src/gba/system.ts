import { GBABus, type GBABusOptions } from './bus/bus.js';
import { GBABIOSHLE } from './bios-hle.js';
import { ARM7TDMI } from './cpu/cpu.js';
import { GBA_INTERRUPT } from './peripherals/interrupts.js';
import { GBAScheduler } from './scheduler/scheduler.js';
import type { AudioBuffer, Button, FrameBuffer } from '../types.js';

export type GameBoyAdvanceSystemOptions = GBABusOptions;

type GBAPowerState = 'running' | 'halt' | 'stop';

const GBA_STOP_WAKE_INTERRUPTS = GBA_INTERRUPT.serial
    | GBA_INTERRUPT.keypad
    | GBA_INTERRUPT.gamePak;

export class GameBoyAdvanceSystem {

    readonly model = 'gba' as const;
    readonly scheduler = new GBAScheduler();
    readonly bus: GBABus;
    readonly cpu: ARM7TDMI;
    readonly frame: FrameBuffer;
    private powerState: GBAPowerState = 'running';

    constructor(options: GameBoyAdvanceSystemOptions) {

        this.bus = new GBABus(options);
        this.frame = this.bus.frame;

        const biosHLE = options.bootROM === undefined ? new GBABIOSHLE(this.bus) : undefined;

        this.cpu = new ARM7TDMI(
            this.bus,
            biosHLE === undefined
                ? undefined
                : (number, registers) => biosHLE.execute(number, registers),
        );
        this.bus.interrupts.setLineListener((pending) => this.cpu.setIRQPending(pending));
        this.scheduler.register(this.bus.ppu);
        this.scheduler.register(this.bus.apu.schedulerClock);
        this.scheduler.register(this.bus.timers);
        this.scheduler.register(this.bus.serial);
        this.cpu.reset(options.bootROM === undefined ? 0x08000000 : 0x00000000);
    }

    get cycles(): number {

        return this.scheduler.cycles;
    }

    get isHalted(): boolean {

        return this.powerState === 'halt';
    }

    get isStopped(): boolean {

        return this.powerState === 'stop';
    }

    runCycles(cycles: number): number {

        if (!Number.isSafeInteger(cycles) || cycles < 0) {
            throw new RangeError('GBA run cycles must be a non-negative safe integer.');
        }

        const startCycle = this.scheduler.cycles;

        while (this.scheduler.cycles - startCycle < cycles) {
            if (this.step() === 0) {
                break;
            }
        }

        return this.scheduler.cycles - startCycle;
    }

    setButton(button: Button, pressed: boolean): void {

        this.bus.setButton(button, pressed);
    }

    drainAudio(): AudioBuffer {

        return this.bus.apu.drainAudio();
    }

    step(): number {

        this.consumeLowPowerRequest();

        if (this.powerState === 'stop') {
            if ((this.bus.interrupts.pending & GBA_STOP_WAKE_INTERRUPTS) === 0) {
                return 0;
            }

            this.powerState = 'running';
        }

        let cycles = this.serviceDMA();

        if (this.powerState === 'halt') {
            if (this.bus.interrupts.pending === 0) {
                const haltCycles = this.scheduler.cyclesUntilNextEvent(1232);

                this.bus.idle(haltCycles);
                this.cpu.stall(haltCycles);
                this.scheduler.advance(haltCycles);

                return cycles + haltCycles;
            }

            this.powerState = 'running';
        }

        const cpuCycles = this.cpu.step();

        this.scheduler.advance(cpuCycles);
        cycles += cpuCycles;
        cycles += this.serviceDMA();

        this.consumeLowPowerRequest();

        return cycles;
    }

    reset(): void {

        this.bus.reset();
        this.scheduler.reset();
        this.powerState = 'running';
        this.cpu.reset(this.bus.bootROM === undefined ? 0x08000000 : 0x00000000);
    }

    private consumeLowPowerRequest(): void {

        this.powerState = this.bus.consumeLowPowerRequest() ?? this.powerState;
    }

    private serviceDMA(): number {

        let totalCycles = 0;

        while (this.bus.dma.hasPending) {
            const cycles = this.bus.dma.runPending();

            this.bus.idle(cycles);
            this.cpu.stall(cycles);
            this.scheduler.advance(cycles);
            totalCycles += cycles;
        }

        return totalCycles;
    }
}
