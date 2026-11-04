import { ARM7TDMI, ARM_STATUS } from '../../dist/index.mjs';

class ARMTestBus {

    constructor() {

        this.bytes = new Map();
        this.accesses = [];
    }

    load16(address, values) {

        values.forEach((value, index) => this.store16(address + index * 2, value));
    }

    load32(address, values) {

        values.forEach((value, index) => this.store32(address + index * 4, value));
    }

    read8(address, access = 'nonsequential') {

        this.accesses.push(['read8', address >>> 0, access]);
        return this.bytes.get(address >>> 0) ?? 0;
    }

    read16(address, access = 'nonsequential') {

        const aligned = (address & 0xfffffffe) >>> 0;

        this.accesses.push(['read16', aligned, access]);
        return this.peek16(aligned);
    }

    read32(address, access = 'nonsequential') {

        const aligned = (address & 0xfffffffc) >>> 0;

        this.accesses.push(['read32', aligned, access]);
        return this.peek32(aligned);
    }

    write8(address, value, access = 'nonsequential') {

        this.accesses.push(['write8', address >>> 0, value & 0xff, access]);
        this.bytes.set(address >>> 0, value & 0xff);
    }

    write16(address, value, access = 'nonsequential') {

        const aligned = (address & 0xfffffffe) >>> 0;

        this.accesses.push(['write16', aligned, value & 0xffff, access]);
        this.store16(aligned, value);
    }

    write32(address, value, access = 'nonsequential') {

        const aligned = (address & 0xfffffffc) >>> 0;

        this.accesses.push(['write32', aligned, value >>> 0, access]);
        this.store32(aligned, value);
    }

    peek16(address) {

        return (this.bytes.get(address) ?? 0)
            | ((this.bytes.get(address + 1) ?? 0) << 8);
    }

    peek32(address) {

        return (
            (this.bytes.get(address) ?? 0)
            | ((this.bytes.get(address + 1) ?? 0) << 8)
            | ((this.bytes.get(address + 2) ?? 0) << 16)
            | ((this.bytes.get(address + 3) ?? 0) << 24)
        ) >>> 0;
    }

    clearAccesses() {

        this.accesses.length = 0;
    }

    store16(address, value) {

        this.bytes.set(address >>> 0, value & 0xff);
        this.bytes.set((address + 1) >>> 0, (value >>> 8) & 0xff);
    }

    store32(address, value) {

        this.store16(address, value);
        this.store16(address + 2, value >>> 16);
    }
}

export function createARMHarness(program, options = {}) {

    const startAddress = options.startAddress ?? 0x08000000;
    const thumb = options.thumb ?? false;
    const bus = new ARMTestBus();

    if (thumb) {
        bus.load16(startAddress, program);
    } else {
        bus.load32(startAddress, program);
    }

    const cpu = new ARM7TDMI(bus);

    cpu.reset(startAddress);

    if (thumb) {
        cpu.registers.setStatusBits(ARM_STATUS.thumb, true);
        cpu.branch(startAddress, true);
    }

    bus.clearAccesses();

    return { bus, cpu };
}
