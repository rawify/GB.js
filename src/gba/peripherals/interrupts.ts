export const GBA_INTERRUPT = {
    vblank: 0x0001,
    hblank: 0x0002,
    vcount: 0x0004,
    timer0: 0x0008,
    timer1: 0x0010,
    timer2: 0x0020,
    timer3: 0x0040,
    serial: 0x0080,
    dma0: 0x0100,
    dma1: 0x0200,
    dma2: 0x0400,
    dma3: 0x0800,
    keypad: 0x1000,
    gamePak: 0x2000,
} as const;

export type GBAInterrupt = typeof GBA_INTERRUPT[keyof typeof GBA_INTERRUPT];

export const GBA_INTERRUPT_MASK = 0x3fff;

export class GBAInterruptController {

    private interruptEnable = 0;
    private interruptFlags = 0;
    private masterEnable = false;
    private lineHigh = false;
    private lineListener: ((pending: boolean) => void) | undefined;

    get enabled(): number {

        return this.interruptEnable;
    }

    set enabled(value: number) {

        this.interruptEnable = value & GBA_INTERRUPT_MASK;
        this.updateLine();
    }

    get requested(): number {

        return this.interruptFlags;
    }

    get masterEnabled(): boolean {

        return this.masterEnable;
    }

    set masterEnabled(enabled: boolean) {

        this.masterEnable = enabled;
        this.updateLine();
    }

    get irqLine(): boolean {

        return this.lineHigh;
    }

    get pending(): number {

        return this.interruptEnable & this.interruptFlags;
    }

    setLineListener(listener: ((pending: boolean) => void) | undefined): void {

        this.lineListener = listener;
        listener?.(this.lineHigh);
    }

    request(interrupts: number): void {

        this.interruptFlags |= interrupts & GBA_INTERRUPT_MASK;
        this.updateLine();
    }

    acknowledge(interrupts: number): void {

        this.interruptFlags &= ~(interrupts & GBA_INTERRUPT_MASK);
        this.updateLine();
    }

    reset(): void {

        this.interruptEnable = 0;
        this.interruptFlags = 0;
        this.masterEnable = false;
        this.updateLine();
    }

    private updateLine(): void {

        const lineHigh = this.masterEnable && this.pending !== 0;

        if (lineHigh === this.lineHigh) {
            return;
        }

        this.lineHigh = lineHigh;
        this.lineListener?.(lineHigh);
    }
}
