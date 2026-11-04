import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GBA_INTERRUPT,
    GBA_KEY_CONTROL_ADDRESS,
    GBA_KEY_INPUT_ADDRESS,
    GBABus,
    GameBoyAdvanceSystem,
} from '../../dist/index.mjs';

describe('GBA keypad', () => {

    it('maps all ten active-low buttons through KEYINPUT', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });
        const buttons = ['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'r', 'l'];

        assert.equal(bus.read16(GBA_KEY_INPUT_ADDRESS), 0x03ff);

        for (let bit = 0; bit < buttons.length; bit++) {
            bus.setButton(buttons[bit], true);
            assert.equal(bus.read16(GBA_KEY_INPUT_ADDRESS), 0x03ff & ~(1 << bit));
            bus.setButton(buttons[bit], false);
        }

        assert.equal(bus.read16(GBA_KEY_INPUT_ADDRESS), 0x03ff);
    });

    it('keeps KEYINPUT read-only and masks KEYCNT', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_KEY_INPUT_ADDRESS, 0);
        bus.write16(GBA_KEY_CONTROL_ADDRESS, 0xffff);

        assert.equal(bus.read16(GBA_KEY_INPUT_ADDRESS), 0x03ff);
        assert.equal(bus.read16(GBA_KEY_CONTROL_ADDRESS), 0xc3ff);

        bus.reset();

        assert.equal(bus.read16(GBA_KEY_INPUT_ADDRESS), 0x03ff);
        assert.equal(bus.read16(GBA_KEY_CONTROL_ADDRESS), 0);
    });

    it('requests OR-mode keypad IRQ only on a false-to-true condition', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_KEY_CONTROL_ADDRESS, 0x4003);
        bus.setButton('a', true);

        assert.equal(bus.interrupts.requested, GBA_INTERRUPT.keypad);

        bus.interrupts.acknowledge(GBA_INTERRUPT.keypad);
        bus.setButton('a', true);
        bus.setButton('b', true);

        assert.equal(bus.interrupts.requested, 0);

        bus.setButton('a', false);
        bus.setButton('b', false);
        bus.setButton('b', true);

        assert.equal(bus.interrupts.requested, GBA_INTERRUPT.keypad);
    });

    it('requires every selected button in AND mode', () => {

        const bus = new GBABus({ rom: new Uint8Array(0x100) });

        bus.write16(GBA_KEY_CONTROL_ADDRESS, 0xc003);
        bus.setButton('a', true);

        assert.equal(bus.interrupts.requested, 0);

        bus.setButton('b', true);

        assert.equal(bus.interrupts.requested, GBA_INTERRUPT.keypad);
    });

    it('evaluates held buttons when KEYCNT enables the condition', () => {

        const system = new GameBoyAdvanceSystem({ rom: new Uint8Array(0x100) });

        system.setButton('l', true);
        system.bus.write16(GBA_KEY_CONTROL_ADDRESS, 0x0200);

        assert.equal(system.bus.interrupts.requested, 0);

        system.bus.write8(GBA_KEY_CONTROL_ADDRESS + 1, 0x42);

        assert.equal(system.bus.interrupts.requested, GBA_INTERRUPT.keypad);
        assert.equal(system.bus.read16(GBA_KEY_INPUT_ADDRESS), 0x01ff);
    });
});
