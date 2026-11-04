import type { Button } from '../../types.js';
import { GBA_INTERRUPT, type GBAInterruptController } from './interrupts.js';

export const GBA_KEY_INPUT_MASK = 0x03ff;
export const GBA_KEY_CONTROL_WRITABLE_MASK = 0xc3ff;

const BUTTON_BITS: Readonly<Partial<Record<Button, number>>> = {
    a: 0,
    b: 1,
    select: 2,
    start: 3,
    right: 4,
    left: 5,
    up: 6,
    down: 7,
    r: 8,
    l: 9,
};

export class GBAKeypad {

    private readonly interrupts: GBAInterruptController;
    private pressed = 0;
    private control = 0;
    private irqCondition = false;

    constructor(interrupts: GBAInterruptController) {

        this.interrupts = interrupts;
    }

    readInput(): number {

        return (~this.pressed) & GBA_KEY_INPUT_MASK;
    }

    readControl(): number {

        return this.control;
    }

    writeControl(value: number): void {

        this.control = value & GBA_KEY_CONTROL_WRITABLE_MASK;
        this.updateIRQ();
    }

    setButton(button: Button, pressed: boolean): void {

        const bit = BUTTON_BITS[button];

        if (bit === undefined) {
            return;
        }

        if (pressed) {
            this.pressed |= 1 << bit;
        } else {
            this.pressed &= ~(1 << bit);
        }

        this.updateIRQ();
    }

    reset(): void {

        this.pressed = 0;
        this.control = 0;
        this.irqCondition = false;
    }

    private updateIRQ(): void {

        const selected = this.control & GBA_KEY_INPUT_MASK;
        const pressed = this.pressed & selected;
        const andMode = (this.control & 0x8000) !== 0;
        const condition = selected !== 0
            && (andMode ? pressed === selected : pressed !== 0);
        const irqActive = condition && (this.control & 0x4000) !== 0;

        if (irqActive && !this.irqCondition) {
            this.interrupts.request(GBA_INTERRUPT.keypad);
        }

        this.irqCondition = irqActive;
    }
}
