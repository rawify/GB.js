# Architecture

GB.js is a headless emulator package. Browser rendering,
Web Audio, filesystem persistence, keyboard mapping, and animation loops are
adapters owned by applications, not by the emulation cores.

## Hardware boundaries

Game Boy and Game Boy Color share an SM83/LR35902 instruction core and much of
their memory, timer, cartridge, audio, and pixel-processing behavior. CGB mode
extends that core with double speed, banked VRAM and WRAM, color palettes,
attribute maps, VRAM DMA, infrared I/O, and different object-priority rules.

Game Boy Advance is not an extension of the Game Boy CPU. It has a separate
ARM7TDMI core, a 32-bit address space, ARM and Thumb instruction sets, a
pipeline and prefetch unit, wait-state controlled cartridge access, four DMA
channels, four timers, a distinct interrupt controller, six display modes, and
additional direct-sound channels. The `gb` and `gba` trees therefore share
public contracts and utilities only.

```text
src/
  index.ts                 Public package facade and ROM detection
  types.ts                 Frontend-neutral buffers and controls
  gb/
    cartridge/             Header parsing, MBCs, RTC and persistent RAM
    cpu/                   SM83 registers, decoder and interrupt sequencing
    bus/                   DMG/CGB address map and access restrictions
    ppu/                   Dot-based LCD pipeline and palettes
    apu/                   Four-channel PSG and sample resampling
    peripherals/           Timer, joypad, serial, DMA and CGB extensions
  gba/
    cartridge/             Header parsing and save-device detection
    cpu/                   ARM7TDMI ARM/Thumb pipeline
    bus/                   Regions, WAITCNT, open bus and ROM prefetch
    peripherals/           DMA, timers, keypad, PPU, audio and interrupts
    scheduler/             Shared cycle domain and event boundaries
```

## Execution contract

Each CPU instruction advances a master scheduler. Peripherals consume the same
monotonic cycle domain, so an instruction cannot update the timer, DMA, PPU,
and APU in an arbitrary order. Public execution is deterministic and driven by
`step()`, `runCycles()`, or `runFrame()`; it never reads wall-clock time.

External effects use injected interfaces:

- persistent RAM and RTC data are byte buffers plus an injectable clock;
- video is an owned packed 32-bit framebuffer;
- audio is a deterministic, bounded stream of normalized stereo PCM blocks;
- serial/link communication uses a synchronous bit endpoint for internally
  clocked devices and explicit external clock edges for linked bus instances;
- rumble, motion, solar, and camera hardware use optional device adapters.

Save states are versioned binary snapshots. They are separate from cartridge
save data and include every timing latch needed for deterministic continuation.

The bundled browser demo transfers drained PCM blocks to a persistent
`AudioWorkletNode`. Its processor pulls stereo frames from a bounded ring
buffer, briefly prebuffers after startup or underrun, and discards the oldest
frames on overflow to keep audio latency bounded. Browsers without
AudioWorklet support fall back to scheduled `AudioBufferSourceNode` blocks.

## Correctness gates

Feature completion is measured rather than inferred from commercial games.

### DMG

- all base and CB-prefixed opcodes, flags, conditional timings, interrupts,
  delayed EI, HALT bug, STOP, and invalid-opcode behavior;
- Mooneye acceptance CPU, interrupt, timer, DMA and MBC tests;
- Mooneye LCD-on timing plus read/write-specific VRAM and OAM contention;
- DMG LCDC object-fetch aborts with CGB non-abort behavior;
- fetched-byte Wave RAM output, DMG fetch-window contention, and DMG retrigger
  corruption, with unrestricted access while Channel 3 is inactive;
- sample-visible NRx2 writes for both pulse channels and noise, including
  envelope-clock phasing, trigger reset, DAC disable, and the CGB-D boundary;
- pulse startup suppression and phase-sensitive restart delays, frame-phase
  length-enable clocks, delayed sweep calculations, restart hold, deferred
  overflow shutdown, revision-specific NR10 writes, normal/double-speed pulse
  frequency-write boundaries, timer-edge box resampling, and model-specific
  stereo AC-coupling high-pass filters;
- CGB0–C transient PCM12/PCM34 edge masking and a free-running Channel 4 frequency
  counter with CGB-E startup alignment, NR43 changes, CGB0–C intermediate-write
  glitches, width transitions, and LFSR retrigger reset;
- MSB-first internal and external serial transfers, disconnected-line input,
  transfer cancel/restart, linked-bus exchange, and completion interrupts;
- Blargg CPU, instruction timing, memory timing and sound suites;
- dmg-acid2, Mealybug Tearoom and SameSuite PPU/APU cases.

### CGB

- all DMG gates in both normal and double-speed operation;
- CGB palettes, attributes, WRAM/VRAM banking, KEY0/KEY1, OPRI and HDMA;
- explicit CGB0/A/B/C/D/E profiles for Extra-OAM and RP decoding, fetcher-Y
  latching, tile-select conflicts, first-HBlank buses, line-153 LY/LYC timing,
  and halted-DMA OAM search behavior;
- physical-CGB Wave RAM aliasing to the currently playing byte, including DMG
  compatibility mode and normal/double-speed APU clock conversion;
- model-aware unmapped I/O behavior and eight-bit IE storage;
- CGB0/CGB BIOS handoff, post-boot registers and hardware I/O, with original
  firmware required for revision-specific DIV phase checks;
- cgb-acid2, Mooneye CGB tests, SameSuite and MagenTests.

### GBA

The current GBA foundation maps BIOS, EWRAM, IWRAM, I/O, palette RAM, VRAM,
OAM, all three Game Pak windows, serial EEPROM, SRAM, and Flash save space,
and exposes an open-bus latch. A deterministic master scheduler splits advances
at component event boundaries and applies a stable priority order.

The executable ARM7TDMI core owns ARM and Thumb pipelines, all architectural
register banks, CPSR/SPSR state, condition evaluation, the ARMv4T instruction
families, unaligned word rotation, exception entry, and nonsequential versus
sequential bus access classification. Reset, Undefined, SWI, Prefetch Abort,
Data Abort, IRQ, and FIQ use their banked modes and vector refills. A reusable
sparse-memory test bus records access width, address, value, and sequence type.
Instruction-internal cycles are modeled, including register-controlled shifts
and operand-dependent multiplies. The bus adds physical-width costs and
`WAITCNT` first/second access timing to those core cycles. An address-bound
eight-halfword Game Pak prefetch queue fills while the cartridge bus is idle
and is consumed only by sequential instruction fetches. ROM data accesses,
branches to another bus region, and `WAITCNT` changes invalidate the stream.
DMA stalls also fill that queue when the cartridge bus is free; a DMA Game Pak
access invalidates it.

When no BIOS is supplied, an optional SWI dispatcher handles `Div`, `DivArm`,
`Sqrt`, `CpuSet`, and `CpuFastSet` directly against CPU registers and the normal
timed bus API. ARM and Thumb immediates normalize to the same BIOS call number.
Unsupported calls retain the architectural Supervisor exception path. The
dispatcher is absent whenever a real BIOS is supplied, so firmware execution
and timing remain untouched.

The interrupt controller owns the fourteen GBA source flags, enable mask, and
master enable latch. `IF` is write-one-to-clear; `IE` and `IME` gate a level
IRQ line connected directly to the ARM7TDMI. Requests remain latched while any
enable layer, including the CPSR I bit, blocks exception entry. Timers, DMA,
PPU timing, and the keypad request their assigned sources through this
controller. SIO normal-mode completion requests the serial source.

The bus-owned keypad maps host button changes to the ten active-low `KEYINPUT`
bits. `KEYCNT` selects buttons, OR/AND matching, and IRQ enable. The keypad
requests its interrupt on a false-to-true transition of the enabled match,
including register writes that activate a condition already satisfied by held
buttons. Input is asynchronous to the scheduler and resets to all buttons
released.

The scheduler-owned GBA SIO block applies mode-specific read/write masks across
normal, multiplayer, UART, general-purpose, and Joy Bus register views. Normal
8-bit and 32-bit transfers shift MSB-first through an optional synchronous bit
endpoint. Internal clocks run at 256 kHz or 2 MHz after a ten-cycle startup
delay; external transfers advance only through explicit `clockNormal()` edges.
Completion clears the start bit and optionally requests the serial interrupt.
Disconnected internal input reads high. Multiplayer, UART, and Joy Bus register
surfaces are present, while their protocol engines remain future work.

Four timers are one scheduler component. Each timer has a write-only reload
latch behind its live counter read, selectable 1/64/256/1024-cycle prescaling,
start/stop state, and an overflow IRQ. Reload and control writes become
effective one master cycle after the bus write. Direct timers consume
prescaler pulses aligned to the global scheduler clock rather than restarting
divider phase when enabled. Timers 1-3 can instead increment on each overflow
of their predecessor. The scheduler splits at pending writes and the earliest
direct timer overflow; reload, cascading, and `IF` assertion therefore occur
at deterministic master-cycle boundaries. CPU bus writes are still committed
at instruction granularity, so finer ARM bus-phase effects remain a future
conformance layer.

The four DMA channels are synchronous bus masters serviced in fixed DMA0 to
DMA3 priority before the next CPU opcode. Enabling a channel latches its source
and destination; each trigger reads the current count register. Transfers
support channel-specific address/count masks, all address modes, 16/32-bit
widths, repeat and destination reload, completion IRQs, and physical bus/
`WAITCNT` stall costs. Immediate DMA is integrated into `step()`. VBlank,
HBlank, DMA3 special, and forced four-word Direct Sound FIFO trigger contracts
are exposed. The PPU clock drives display DMA automatically. Timer 0/1
overflows consume Direct Sound samples; reaching the FIFO refill threshold
requests only the DMA channel targeting that FIFO. BIOS read protection,
cartridge lockup cases, and display-capture DMA are not yet gates. DMA source
and destination timing uses the same PPU video-bus cursor as CPU accesses.
`POSTFLG` exposes BIOS completion state. `HALTCNT` HALT suspends instruction
execution while scheduler events and DMA continue; any source selected in
`IE` wakes the CPU even when `IME` or the CPSR IRQ mask prevents exception
entry. `HALTCNT` STOP freezes CPU and scheduler clocks, including PPU, APU,
timers, and DMA. Only enabled keypad, Game Pak, or serial requests leave STOP;
`runCycles()` returns without advancing emulated time while the system remains
stopped.

Cartridges containing an `EEPROM_` signature map a serial save device into the
wait-state-2 Game Pak window. DMA3 transfer counts distinguish the 6-bit and
14-bit address commands used by 512-byte and 8-KiB EEPROMs. Commands transfer
one bit per halfword access and reads return four dummy bits followed by one
64-bit block. `SRAM_` and `SRAM_F_` signatures select a mirrored 32-KiB store
on the eight-bit save bus. `FLASH_` and `FLASH512_` select 64-KiB Flash, while
`FLASH1M_` selects two switchable 64-KiB banks. Flash supports manufacturer and
device identification, byte programming, 4-KiB sector erase, chip erase, and
bank switching. The bus accepts a size-checked initial save image and reports
completed writes and erase operations through a host callback; reset preserves
stored data while restoring protocol state.

Cartridges containing the Nintendo SDK `SIIRTC_V` signature expose GPIO data,
direction, and read-enable registers at ROM addresses `080000C4h` through
`080000C8h`. The attached RTC samples serial command/data bits on rising SCK
edges and presents read data on falling edges. It supports reset, control,
date/time, time-only, and forced Game Pak IRQ commands, LSB-first and reversed
command encodings, BCD values, 12/24-hour modes, and an injectable wall clock.
Control and clock-offset state can be restored independently of transient GPIO
protocol state; the browser demo persists that state per cartridge.

The APU owns two 32-byte Direct Sound FIFOs, masked `SOUNDCNT_H`, `SOUNDCNT_X`,
and `SOUNDBIAS` state, and a bounded stereo output ring. FIFO writes preserve
little-endian bus order; reads return the bus's open-bus value. Timer-selected consumption sign-extends each sample,
while independent volume and left/right routing bits feed deterministic
sample-rate conversion in the master scheduler domain. FIFO reset bits do not
latch. `drainAudio()` returns normalized aligned channels and empties the
output ring; overflow retains the newest samples and increments a diagnostic
counter. The final DAC stage applies the 10-bit bias and saturation before
9/8/7/6-bit PWM quantization and holds samples for 512/256/128/64 master cycles.
Master power-off resets the PSG and low mixer-volume bits but preserves Direct
Sound routing, FIFO contents, and `SOUNDBIAS`. The legacy PSG runs in the same master-cycle domain. Pulse 1/2 use
duty generators, 64-step lengths, volume envelopes, and Channel 1 frequency
sweep. Wave audio uses a 256-step length, selectable 32/64-sample playback,
two CPU-visible banks, and normal or forced volume scaling. Noise uses the
selectable divisor, shift, and 15/7-bit LFSR modes; unused shifts 14/15 do not
clock the LFSR. A 512 Hz frame sequencer clocks length, sweep, and envelopes,
including phase-sensitive extra length clocks and maximum-minus-one trigger
reloads. Sweep pace zero disables periodic calculations. The PSG registers
apply their documented masks. `SOUNDCNT_L` supplies independent left/right
channel routing and master levels; the `SOUNDCNT_H` PSG ratio is applied before
PSG and Direct Sound are mixed. `SOUNDCNT_X` powers the PSG and reports live
channel status. Sub-cycle register writes and analog output filtering remain
outside the current gate.

The PPU timing component emits 240 visible pixels over 960 cycles, but measured
internal rendering continues until the HBlank boundary at cycle 1007 of each
1232-cycle scanline. It wraps after 228 lines, and VBlank is active on lines
160-226.
These boundaries update read-only `DISPSTAT` flags and `VCOUNT`, request the
three enabled display IRQs, and trigger HBlank/VBlank DMA in the same scheduler
slice. The VCOUNT comparison is eight bits and its match flag is live.
`DISPCNT` owns display mode, bitmap page, HBlank-free access, OBJ mapping,
forced blank, layer enables, and window enables; its CGB-mode bit is read-only.
The bus uses the selected mode to move the OBJ VRAM byte-write boundary from
`0x06010000` to `0x06014000` in bitmap modes. OAM reads and 16/32-bit writes are
accepted only during forced blank, VBlank, or HBlank with interval-free access;
locked reads use open bus and writes are discarded. An instruction-local bus
cursor stalls CPU and DMA accesses around mode-specific BG VRAM and compositor
palette fetches. A one-line-ahead OBJ schedule starts at cycle 40, scans OAM in
index order, separates OAM and OBJ VRAM slots, accounts for regular and affine
fetch costs and horizontal clipping, and applies the shortened HBlank-free
budget.

The PPU owns a stable 240 by 160 `FrameBuffer` encoded as `0xAARRGGBB`. At the
1007-cycle HBlank edge it publishes the completed visible scanline before
requesting HBlank DMA. Mode 3 maps 240 by 160 direct RGB555 VRAM, Mode 4 maps
240 by 160 palette indices from either `0xA000`-byte page, and Mode 5 maps the
selected 160 by 128 direct-color page over backdrop outside its smaller area.
BG2 disable selects backdrop and forced blank selects white. Signed 8.8 BG2/BG3
matrix parameters transform each screen pixel from signed 20.8 reference
points. Separate internal references advance by `PB/PD` at each scanline and
reload when software completes a reference high-halfword write or the frame
wraps. Control-register overflow selects transparent clipping or coordinate
wrap. Objects decode OAM shape, size, position, tile, palette, mapping, and
priority attributes. All square, horizontal, and vertical dimensions use
4-bpp palette banks or 8-bpp OBJ palette entries, with color zero transparent.
Regular objects support X/Y flip. Affine objects select one of 32 signed 8.8
matrices stored in OAM and transform about the normal or double-size field
center. 1D mapping follows object width while 2D mapping uses a 32-tile row;
bitmap modes reserve OBJ tile indices below 512. Per-pixel BG priority metadata
lets OBJ win equal-priority BG ties, while lower priority values and then lower
OAM indices win between objects. WIN0/WIN1 use wrapped horizontal and vertical
bounds; WININ and WINOUT select BG0-BG3 and OBJ visibility per region.
Nontransparent regular or affine OBJ-window pixels select the OBJ-window mask,
below WIN0/WIN1 priority. A two-layer pixel compositor retains the top and
next visible BG/OBJ/backdrop candidates. `BLDCNT` target masks apply alpha,
brightness increase, or brightness decrease using clamped `BLDALPHA`/`BLDY`
coefficients. Semi-transparent OBJ force alpha when a selected second target is
available; each window region gates all color effects. `MOSAIC` supplies
independent 1-16 pixel BG and OBJ block dimensions. Text BGs quantize screen
coordinates before scrolling, affine and bitmap BGs adjust their transform to
the block origin, and regular/affine OBJ quantize local field coordinates
before flip or matrix mapping. Pixel-phased register changes are not yet
rendered.

Mode 0 composes four text backgrounds and Mode 1 composes BG0/BG1. Each text
layer maps 32 by 32-tile screen blocks into 256/512-pixel dimensions, selects
one of four character blocks and 32 screen blocks, and applies 9-bit horizontal
and vertical scroll. Tile entries provide 10-bit indices, X/Y flip, and 4-bpp
palette banks; 8-bpp tiles address the full BG palette. Color zero is
transparent. Lower priority values win, followed by lower BG number on ties.
Mode 1 adds affine BG2 to its text layers; Mode 2 composes affine BG2/BG3.
Affine maps contain one-byte tile indices and 8-bpp tiles, with square 128,
256, 512, or 1024-pixel dimensions. Their transparent pixels participate in
the same priority and BG-number tie-breaking as text layers.

- ARM and Thumb instruction, exception, mode-banking and pipeline tests
  currently provide the executable CPU gate;
- memory timing, unaligned access, open bus, WAITCNT and CPU-prefetch tests;
- IE/IF/IME masking, acknowledgement, reset, ARM IRQ entry, POSTFLG, HALTCNT
  HALT wake, STOP clock-freeze, and restricted STOP wake tests;
- delayed timer reload/control writes, global prescaler phase, cascade,
  overflow-IRQ, and reset tests;
- DMA register masks, latches, triggers, addressing, priority, stalls, prefetch,
  video-bus arbitration, FIFO mode, completion-IRQ, and reset tests;
- PPU scanline/HBlank/VBlank boundaries, DISPSTAT/VCOUNT, display-IRQ, automatic
  display-DMA, DISPCNT, BG/OBJ/PRAM fetch arbitration, OBJ VRAM boundaries, OAM
  gating, and reset tests;
- bitmap mode 3-5 direct/palette color, page selection, geometry, backdrop,
  forced-blank, BG2-enable, affine matrix/reference arithmetic, clipping/wrap,
  reference latching, and exact HBlank publication tests;
- Mode-0 BG0-BG3 and Mode-1 BG0/BG1 text control, scroll, screen-block sizes,
  4/8-bpp tiles, flips, palettes, transparency, and priority tests;
- Mode-1 BG2 and Mode-2 BG2/BG3 affine register, map-size, matrix, reference,
  wrap/clipping, transparency, and mixed-layer priority tests;
- regular and affine OBJ shape/size, coordinate wrap, disable, flip, 4/8-bpp
  palette, transparency, OAM matrices, double-size fields, 1D/2D mapping,
  bitmap VRAM boundary, and BG/OAM priority tests;
- WIN0/WIN1 bounds and wrap, region priority, BG/OBJ masks, OBJ-window
  transparency, and tile/bitmap layer tests;
- BLDCNT/BLDALPHA/BLDY masks and reset, first/second target ordering, alpha,
  brightness, coefficient clamping, semi-transparent OBJ, and window gates;
- MOSAIC register/reset and horizontal/vertical text, affine bitmap, regular
  OBJ, and affine OBJ sampling tests;
- KEYINPUT active-low mapping, KEYCNT masks, OR/AND IRQ conditions, transition
  behavior, held-button enable, public system input, and reset tests;
- Direct Sound register masks, FIFO order/capacity/reset, timer selection,
  signed samples, DMA refill isolation, stereo routing, resampling, bounded
  buffering, master-power preservation, bias clipping, all four PWM modes,
  public drain, option validation, and reset tests;
- PSG power/read masks, pulse period, duty, length, sweep, envelope, Wave RAM
  banking and playback, noise LFSR and unused shifts, phase-sensitive length
  triggers, asymmetric stereo routing and levels, MMIO status, and public PCM
  output tests;
- BIOS-call and save-device tests;
- pixel-phased graphics tests;
- sub-cycle PSG register and analog output-filter tests.

The package must not advertise a platform as complete while its corresponding
gate has known unexplained failures. Test ROMs and Nintendo BIOS images are not
published in the npm package.

APU register and Wave RAM accesses used by timing-sensitive instructions are
timestamped at their SM83 machine-cycle boundaries. SameSuite's
sub-instruction-phased `channel_3_wave_ram_locked_write` case is a passing
gate. CGB-E SameSuite gates also cover active envelope-speed writes and the
Channel 1/2 trigger and APU-power alignment phases, active low-frequency writes,
and Channel 4 startup, frequency-change, and fast-retrigger paths. Channel 4
frequency alignment, 15-bit/7-bit polynomial transitions, and complete restart
state are compared byte-for-byte. Delayed sweep overflow, NR10 restart state,
and restart hold are covered by dedicated SameSuite gates. CGB0–C NR43
intermediate writes and the CGB0–C versus CGB-D/E double-speed pulse-frequency
boundaries have dedicated revision gates. A few duty-phase boundaries in
broader sweep PCM vectors remain outside the verified set.

## References and licensing

Hardware behavior is grounded primarily in Pan Docs, Gekkio's Game Boy
technical reference, AntonioND's cycle-accurate Game Boy documentation,
GBATEK, and ARM7TDMI documentation.

The supplied emulator repositories are comparison material:

- `juchi/gameboy.js`, `Chaosteil/geebee`, and `geaz/emu-gameboy` are MIT;
- `jgilchrist/gbemu` is BSD-3-Clause;
- `roblouie/gameboy-emulator` has no clear repository license and must not be
  copied;
- mGBA is MPL-2.0 and is used only to cross-check behavior and edge cases.

Implementation in this repository is original MIT-licensed code. Any future
third-party code inclusion requires a documented compatible license and
attribution before merge.