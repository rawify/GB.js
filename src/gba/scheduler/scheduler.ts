export interface GBAClockedComponent {
    tick(cycles: number, startCycle: number): void;
    cyclesUntilNextEvent?(maximumCycles: number): number | undefined;
}

interface ScheduledComponent {
    readonly component: GBAClockedComponent;
    readonly priority: number;
    readonly sequence: number;
}

export class GBAScheduler {

    private readonly components: ScheduledComponent[] = [];
    private readonly eventComponents: ScheduledComponent[] = [];
    private cycleCount = 0;
    private nextSequence = 0;
    private advancing = false;

    get cycles(): number {

        return this.cycleCount;
    }

    cyclesUntilNextEvent(maximumCycles: number): number {

        if (!Number.isSafeInteger(maximumCycles) || maximumCycles <= 0) {
            throw new RangeError('A GBA scheduler event horizon must be a positive safe integer.');
        }

        return this.nextSlice(maximumCycles);
    }

    register(component: GBAClockedComponent, priority = 0): () => void {

        if (this.advancing) {
            throw new Error('GBA scheduler components cannot change while time is advancing.');
        }

        if (!Number.isSafeInteger(priority)) {
            throw new RangeError('A GBA scheduler priority must be a safe integer.');
        }

        if (this.components.some((entry) => entry.component === component)) {
            throw new Error('A GBA scheduler component cannot be registered twice.');
        }

        const entry = {
            component,
            priority,
            sequence: this.nextSequence++,
        };

        this.components.push(entry);
        this.components.sort((left, right) => (
            left.priority - right.priority || left.sequence - right.sequence
        ));

        if (component.cyclesUntilNextEvent !== undefined) {
            this.eventComponents.push(entry);
            this.eventComponents.sort((left, right) => (
                left.priority - right.priority || left.sequence - right.sequence
            ));
        }

        return () => this.unregister(component);
    }

    unregister(component: GBAClockedComponent): void {

        if (this.advancing) {
            throw new Error('GBA scheduler components cannot change while time is advancing.');
        }

        const index = this.components.findIndex((entry) => entry.component === component);

        if (index >= 0) {
            this.components.splice(index, 1);
        }

        const eventIndex = this.eventComponents.findIndex((entry) => entry.component === component);

        if (eventIndex >= 0) {
            this.eventComponents.splice(eventIndex, 1);
        }
    }

    advance(cycles: number): void {

        if (!Number.isSafeInteger(cycles) || cycles < 0) {
            throw new RangeError('GBA scheduler cycles must be a non-negative safe integer.');
        }

        if (!Number.isSafeInteger(this.cycleCount + cycles)) {
            throw new RangeError('GBA scheduler time exceeds the safe integer range.');
        }

        if (cycles === 0) {
            return;
        }

        if (this.advancing) {
            throw new Error('GBA scheduler time cannot advance recursively.');
        }

        this.advancing = true;

        try {
            let remainingCycles = cycles;

            while (remainingCycles > 0) {
                const slice = this.nextSlice(remainingCycles);
                const startCycle = this.cycleCount;

                for (let index = 0; index < this.components.length; index++) {
                    this.components[index]?.component.tick(slice, startCycle);
                }

                this.cycleCount += slice;
                remainingCycles -= slice;
            }
        } finally {
            this.advancing = false;
        }
    }

    reset(): void {

        if (this.advancing) {
            throw new Error('GBA scheduler time cannot reset while it is advancing.');
        }

        this.cycleCount = 0;
    }

    private nextSlice(maximumCycles: number): number {

        let slice = maximumCycles;

        for (let index = 0; index < this.eventComponents.length; index++) {
            const eventCycles = this.eventComponents[index]?.component.cyclesUntilNextEvent?.(slice);

            if (eventCycles === undefined) {
                continue;
            }

            if (!Number.isSafeInteger(eventCycles) || eventCycles <= 0) {
                throw new RangeError('A GBA component event must be a positive safe-integer cycle distance.');
            }

            slice = Math.min(slice, eventCycles);
        }

        return slice;
    }

}
