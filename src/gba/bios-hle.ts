import type { ARM7TDMIBus } from './cpu/cpu.js';
import type { ARM7TDMIRegisters } from './cpu/registers.js';

const BIOS_SWI_DIV = 0x06;
const BIOS_SWI_DIV_ARM = 0x07;
const BIOS_SWI_SQRT = 0x08;
const BIOS_SWI_CPU_SET = 0x0b;
const BIOS_SWI_CPU_FAST_SET = 0x0c;

export class GBABIOSHLE {

    private readonly bus: ARM7TDMIBus;

    constructor(bus: ARM7TDMIBus) {

        this.bus = bus;
    }

    execute(number: number, registers: ARM7TDMIRegisters): number | undefined {

        switch (number) {
            case BIOS_SWI_DIV:
                return this.divide(registers, false);
            case BIOS_SWI_DIV_ARM:
                return this.divide(registers, true);
            case BIOS_SWI_SQRT:
                registers.write(0, Math.floor(Math.sqrt(registers.read(0) >>> 0)));
                return 3;
            case BIOS_SWI_CPU_SET:
                return this.cpuSet(registers, false);
            case BIOS_SWI_CPU_FAST_SET:
                return this.cpuSet(registers, true);
            default:
                return undefined;
        }
    }

    private divide(registers: ARM7TDMIRegisters, swapOperands: boolean): number {

        const numerator = this.signed(registers.read(swapOperands ? 1 : 0));
        const denominator = this.signed(registers.read(swapOperands ? 0 : 1));

        if (denominator === 0) {
            const quotient = numerator < 0 ? 1 : -1;

            registers.write(0, quotient);
            registers.write(1, numerator);
            registers.write(3, Math.abs(quotient));
            return 3;
        }

        const quotient = Math.trunc(numerator / denominator);
        const remainder = numerator - quotient * denominator;

        registers.write(0, quotient);
        registers.write(1, remainder);
        registers.write(3, Math.abs(quotient));

        return 3;
    }

    private cpuSet(registers: ARM7TDMIRegisters, fast: boolean): number {

        const control = registers.read(2);
        const fill = (control & 0x01000000) !== 0;
        const word = fast || (control & 0x04000000) !== 0;
        const width = word ? 4 : 2;
        const mask = word ? 0xfffffffc : 0xfffffffe;
        let count = control & 0x001fffff;
        let source = registers.read(0) & mask;
        let destination = registers.read(1) & mask;

        if (fast) {
            count = (count + 7) & ~7;
        }

        const fillValue = fill ? this.read(source, word) : 0;

        for (let index = 0; index < count; index++) {
            const value = fill ? fillValue : this.read(source, word);

            this.write(destination, value, word);
            destination = (destination + width) >>> 0;

            if (!fill) {
                source = (source + width) >>> 0;
            }
        }

        return 3 + count;
    }

    private read(address: number, word: boolean): number {

        return word
            ? this.bus.read32(address, 'nonsequential')
            : this.bus.read16(address, 'nonsequential');
    }

    private write(address: number, value: number, word: boolean): void {

        if (word) {
            this.bus.write32(address, value, 'nonsequential');
        } else {
            this.bus.write16(address, value, 'nonsequential');
        }
    }

    private signed(value: number): number {

        return value | 0;
    }
}
