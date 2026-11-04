import type { GBAClockedComponent } from '../scheduler/scheduler.js';
import { GBA_INTERRUPT, type GBAInterruptController } from './interrupts.js';

export const GBA_TIMER_COUNT = 4;
export const GBA_TIMER_CONTROL_MASK = 0x00c7;

const TIMER_PRESCALERS = [1, 64, 256, 1024] as const;
const TIMER_INTERRUPTS = [
    GBA_INTERRUPT.timer0,
    GBA_INTERRUPT.timer1,
    GBA_INTERRUPT.timer2,
    GBA_INTERRUPT.timer3,
] as const;

interface TimerState {
    reload: number;
    counter: number;
    control: number;
    pendingReload: number | undefined;
    pendingControl: number | undefined;
    reloadWriteDelay: number;
    controlWriteDelay: number;
}

export type GBATimerOverflowListener = (timer: number, overflows: number) => void;

export class GBATimers implements GBAClockedComponent {

    private readonly timers: TimerState[] = Array.from({ length: GBA_TIMER_COUNT }, () => ({
        reload: 0,
        counter: 0,
        control: 0,
        pendingReload: undefined,
        pendingControl: undefined,
        reloadWriteDelay: 0,
        controlWriteDelay: 0,
    }));
    private readonly interrupts: GBAInterruptController;
    private readonly overflowListener: GBATimerOverflowListener | undefined;
    private currentCycle = 0;
    private writesPending = false;
    private enabledMask = 0;

    constructor(
        interrupts: GBAInterruptController,
        overflowListener?: GBATimerOverflowListener,
    ) {

        this.interrupts = interrupts;
        this.overflowListener = overflowListener;
    }

    readCounter(index: number): number {

        return this.timer(index).counter;
    }

    readReload(index: number): number {

        const timer = this.timer(index);

        return timer.pendingReload ?? timer.reload;
    }

    readControl(index: number): number {

        return this.timer(index).control;
    }

    writeReload(index: number, value: number): void {

        const timer = this.timer(index);

        timer.pendingReload = value & 0xffff;
        timer.reloadWriteDelay = 1;
        this.writesPending = true;
    }

    writeControl(index: number, value: number): void {

        const timer = this.timer(index);
        const controlMask = index === 0
            ? GBA_TIMER_CONTROL_MASK & ~0x04
            : GBA_TIMER_CONTROL_MASK;

        timer.pendingControl = value & controlMask;
        timer.controlWriteDelay = 1;
        this.writesPending = true;
    }

    cyclesUntilNextEvent(maximumCycles: number): number | undefined {

        if (!this.writesPending && this.enabledMask === 1) {
            const timer = this.timers[0];

            if (timer !== undefined && (timer.control & 0x07) === 0) {
                const cycles = 0x10000 - timer.counter;

                return cycles <= maximumCycles ? cycles : undefined;
            }
        }

        let nextEvent: number | undefined;

        for (let index = 0; index < GBA_TIMER_COUNT; index++) {
            const timer = this.timer(index);

            if (this.writesPending) {
                const reloadDelay = timer.reloadWriteDelay;
                const controlDelay = timer.controlWriteDelay;

                if (reloadDelay > 0 && reloadDelay <= maximumCycles) {
                    nextEvent = nextEvent === undefined ? reloadDelay : Math.min(nextEvent, reloadDelay);
                }

                if (controlDelay > 0 && controlDelay <= maximumCycles) {
                    nextEvent = nextEvent === undefined ? controlDelay : Math.min(nextEvent, controlDelay);
                }
            }

            if (!this.enabled(timer) || this.cascade(timer)) {
                continue;
            }

            const prescaler = this.prescaler(timer);
            const increments = 0x10000 - timer.counter;
            let cycles = increments;

            if (prescaler !== 1) {
                const phase = this.currentCycle % prescaler;
                const firstPulse = phase === 0 ? prescaler : prescaler - phase;

                cycles = firstPulse + (increments - 1) * prescaler;
            }

            if (cycles <= maximumCycles) {
                nextEvent = nextEvent === undefined ? cycles : Math.min(nextEvent, cycles);
            }
        }

        return nextEvent;
    }

    tick(cycles: number, startCycle = this.currentCycle): void {

        if (!this.writesPending) {
            this.tickTimers(cycles, startCycle);
            this.currentCycle = startCycle + cycles;
            return;
        }

        let remainingCycles = cycles;
        let cycle = startCycle;

        while (remainingCycles > 0) {
            const writeBoundary = this.cyclesUntilWrite();
            const step = Math.min(remainingCycles, writeBoundary ?? remainingCycles);

            this.tickTimers(step, cycle);
            this.advanceWrites(step);

            cycle += step;
            remainingCycles -= step;
        }

        this.currentCycle = startCycle + cycles;
    }

    private tickTimers(cycles: number, startCycle: number): void {

        if (this.enabledMask === 1) {
            const timer = this.timers[0];

            if (timer !== undefined && (timer.control & 0x07) === 0) {
                this.increment(0, cycles);
                return;
            }
        }

        let previousOverflows = 0;

        for (let index = 0; index < GBA_TIMER_COUNT; index++) {
            const timer = this.timer(index);
            let increments = 0;

            if (this.enabled(timer)) {
                if (this.cascade(timer)) {
                    increments = previousOverflows;
                } else {
                    const prescaler = this.prescaler(timer);

                    increments = prescaler === 1
                        ? cycles
                        : Math.floor((startCycle + cycles) / prescaler)
                            - Math.floor(startCycle / prescaler);
                }
            }

            previousOverflows = this.increment(index, increments);
        }
    }

    reset(): void {

        for (const timer of this.timers) {
            timer.reload = 0;
            timer.counter = 0;
            timer.control = 0;
            timer.pendingReload = undefined;
            timer.pendingControl = undefined;
            timer.reloadWriteDelay = 0;
            timer.controlWriteDelay = 0;
        }

        this.currentCycle = 0;
        this.writesPending = false;
        this.enabledMask = 0;
    }

    private cyclesUntilWrite(): number | undefined {

        let cycles: number | undefined;

        for (const timer of this.timers) {
            const reloadDelay = timer.reloadWriteDelay;
            const controlDelay = timer.controlWriteDelay;

            if (reloadDelay > 0) {
                cycles = cycles === undefined ? reloadDelay : Math.min(cycles, reloadDelay);
            }

            if (controlDelay > 0) {
                cycles = cycles === undefined ? controlDelay : Math.min(cycles, controlDelay);
            }
        }

        return cycles;
    }

    private advanceWrites(cycles: number): void {

        for (let index = 0; index < this.timers.length; index++) {
            const timer = this.timer(index);

            timer.reloadWriteDelay = Math.max(0, timer.reloadWriteDelay - cycles);
            timer.controlWriteDelay = Math.max(0, timer.controlWriteDelay - cycles);

            if (timer.reloadWriteDelay === 0 && timer.pendingReload !== undefined) {
                timer.reload = timer.pendingReload;
                timer.pendingReload = undefined;
            }

            if (timer.controlWriteDelay === 0 && timer.pendingControl !== undefined) {
                const oldEnabled = this.enabled(timer);

                timer.control = timer.pendingControl;
                timer.pendingControl = undefined;

                if (!oldEnabled && this.enabled(timer)) {
                    timer.counter = timer.reload;
                }

                if (this.enabled(timer)) {
                    this.enabledMask |= 1 << index;
                } else {
                    this.enabledMask &= ~(1 << index);
                }
            }
        }

        this.writesPending = this.timers.some((timer) => (
            timer.pendingReload !== undefined || timer.pendingControl !== undefined
        ));
    }

    private increment(index: number, increments: number): number {

        const timer = this.timer(index);
        const incrementsUntilOverflow = 0x10000 - timer.counter;

        if (increments < incrementsUntilOverflow) {
            timer.counter = (timer.counter + increments) & 0xffff;
            return 0;
        }

        const period = 0x10000 - timer.reload;
        const afterFirstOverflow = increments - incrementsUntilOverflow;
        const overflows = 1 + Math.floor(afterFirstOverflow / period);

        timer.counter = timer.reload + (afterFirstOverflow % period);

        if ((timer.control & 0x40) !== 0) {
            this.interrupts.request(TIMER_INTERRUPTS[index] ?? 0);
        }

        this.overflowListener?.(index, overflows);

        return overflows;
    }

    private enabled(timer: TimerState): boolean {

        return (timer.control & 0x80) !== 0;
    }

    private cascade(timer: TimerState): boolean {

        return (timer.control & 0x04) !== 0;
    }

    private prescaler(timer: TimerState): number {

        return TIMER_PRESCALERS[timer.control & 0x03] ?? 1;
    }

    private timer(index: number): TimerState {

        const timer = this.timers[index];

        if (timer === undefined) {
            throw new RangeError(`GBA timer index ${index} is outside 0-3.`);
        }

        return timer;
    }
}
