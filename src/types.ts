export type GameBoyModel = 'dmg' | 'cgb';
export type GameBoyColorRevision = '0' | 'a' | 'b' | 'c' | 'd' | 'e';
export type GameBoyAdvanceModel = 'gba';
export type HardwareModel = GameBoyModel | GameBoyAdvanceModel;

export type Button
    = | 'a'
    | 'b'
    | 'select'
    | 'start'
    | 'right'
    | 'left'
    | 'up'
    | 'down'
    | 'l'
    | 'r';

export interface FrameBuffer {
    readonly width: number;
    readonly height: number;
    /** Row-major pixels encoded as 0xAARRGGBB. */
    readonly pixels: Uint32Array;
}

export interface AudioBuffer {
    /** Samples per second for both normalized PCM channels. */
    readonly sampleRate: number;
    /** Left-channel PCM samples in the range -1 through 1. */
    readonly left: Float32Array;
    /** Right-channel PCM samples aligned one-to-one with `left`. */
    readonly right: Float32Array;
}

export interface EmulatorCore {
    readonly model: HardwareModel;
    readonly frame: FrameBuffer;
    loadROM(rom: Uint8Array): void;
    reset(): void;
    runFrame(): number;
    setButton(button: Button, pressed: boolean): void;
}
