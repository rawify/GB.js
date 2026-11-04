import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GBAScheduler } from '../../dist/index.mjs';

describe('GBA scheduler', () => {

    it('advances components in stable priority order at event boundaries', () => {

        const scheduler = new GBAScheduler();
        const calls = [];
        let eventPending = true;
        const later = {
            tick: (cycles, startCycle) => calls.push(['later', cycles, startCycle]),
        };
        const earlier = {
            cyclesUntilNextEvent: () => eventPending ? 3 : undefined,
            tick(cycles, startCycle) {

                calls.push(['earlier', cycles, startCycle]);
                eventPending = false;
            },
        };

        scheduler.register(later, 10);
        scheduler.register(earlier, 0);
        scheduler.advance(7);

        assert.equal(scheduler.cycles, 7);
        assert.deepEqual(calls, [
            ['earlier', 3, 0],
            ['later', 3, 0],
            ['earlier', 4, 3],
            ['later', 4, 3],
        ]);
    });

    it('supports unregistering and resetting without resetting components', () => {

        const scheduler = new GBAScheduler();
        let componentCycles = 0;
        const component = {
            tick: (cycles) => {

                componentCycles += cycles;
            },
        };
        const unregister = scheduler.register(component);

        scheduler.advance(5);
        unregister();
        scheduler.advance(2);
        scheduler.reset();

        assert.equal(componentCycles, 5);
        assert.equal(scheduler.cycles, 0);
    });

    it('rejects invalid cycles, duplicate components and recursive advances', () => {

        const scheduler = new GBAScheduler();
        const component = {
            tick: () => scheduler.advance(1),
        };

        scheduler.register(component);

        assert.throws(() => scheduler.register(component), /registered twice/);
        assert.throws(() => scheduler.advance(-1), /non-negative safe integer/);
        assert.throws(() => scheduler.advance(1), /cannot advance recursively/);
        assert.equal(scheduler.cycles, 0);
    });

    it('rejects absolute cycle counters outside the safe integer range', () => {

        const scheduler = new GBAScheduler();

        scheduler.advance(Number.MAX_SAFE_INTEGER);

        assert.throws(() => scheduler.advance(1), /exceeds the safe integer range/);
        assert.equal(scheduler.cycles, Number.MAX_SAFE_INTEGER);
    });
});
