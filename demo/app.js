import {
    DMGBus,
    GAME_BOY_ADVANCE_CYCLES_PER_FRAME,
    GameBoyAdvanceSystem,
    SM83CPU,
    createGameBoyCartridge,
    detectROM,
    hasGBARTC,
} from '../dist/index.mjs';

const FRAME_DURATION = 1000 / 59.7275;
const MAX_FRAMES_PER_TICK = 3;
const MAX_INSTRUCTIONS_PER_FRAME = 1_000_000;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_START_LEAD = 0.05;
const AUDIO_RING_CAPACITY = 16_384;
const AUDIO_RING_START_THRESHOLD = Math.round(AUDIO_SAMPLE_RATE * 0.15);
const AUDIO_WORKLET_VERSION = 9;
const GBA_BIOS_SIZE = 0x4000;
const GAMEPAD_AXIS_THRESHOLD = 0.5;
const gamepadButtonMap = new Map([
    [0, 'a'],
    [1, 'b'],
    [4, 'l'],
    [5, 'r'],
    [8, 'select'],
    [9, 'start'],
    [12, 'up'],
    [13, 'down'],
    [14, 'left'],
    [15, 'right'],
]);
const playerHost = document.querySelector('gb-emulator');
const queryRoot = playerHost?.shadowRoot ?? document;
const stateRoot = queryRoot.querySelector('.gb-player') ?? document.body;
const elements = {
    body: stateRoot,
    canvas: queryRoot.querySelector('#screen'),
    device: queryRoot.querySelector('#device'),
    playerStage: queryRoot.querySelector('#player-stage'),
    dropZone: queryRoot.querySelector('#drop-zone'),
    dropOverlay: queryRoot.querySelector('#drop-overlay'),
    fileInput: queryRoot.querySelector('#rom-input'),
    openButton: queryRoot.querySelector('#open-button'),
    pauseButton: queryRoot.querySelector('#pause-button'),
    pauseIcon: queryRoot.querySelector('#pause-icon'),
    pauseLabel: queryRoot.querySelector('#pause-label'),
    resetButton: queryRoot.querySelector('#reset-button'),
    soundButton: queryRoot.querySelector('#sound-button'),
    soundIcon: queryRoot.querySelector('#sound-icon'),
    soundLabel: queryRoot.querySelector('#sound-label'),
    importSaveButton: queryRoot.querySelector('#import-save-button'),
    exportSaveButton: queryRoot.querySelector('#export-save-button'),
    saveInput: queryRoot.querySelector('#save-input'),
    fullscreenButton: queryRoot.querySelector('#fullscreen-button'),
    screenMessage: queryRoot.querySelector('#screen-message'),
    statusText: queryRoot.querySelector('#status-text'),
    gameTitle: queryRoot.querySelector('#game-title'),
    gameSubtitle: queryRoot.querySelector('#game-subtitle'),
    deviceLabel: queryRoot.querySelector('#device-label'),
    modelChip: queryRoot.querySelector('#model-chip'),
    facts: queryRoot.querySelector('#rom-facts'),
    factSystem: queryRoot.querySelector('#fact-system'),
    factCartridge: queryRoot.querySelector('#fact-cartridge'),
    factSize: queryRoot.querySelector('#fact-size'),
    factHeader: queryRoot.querySelector('#fact-header'),
    cartridgeManagerButton: queryRoot.querySelector('#cartridge-manager-button'),
    cartridgeManager: queryRoot.querySelector('#cartridge-manager'),
    managerSubtitle: queryRoot.querySelector('#manager-subtitle'),
    managerROMFacts: queryRoot.querySelector('#manager-rom-facts'),
    managerSaveFacts: queryRoot.querySelector('#manager-save-facts'),
    managerBackupButton: queryRoot.querySelector('#manager-backup-button'),
    managerRestoreButton: queryRoot.querySelector('#manager-restore-button'),
    managerTransferStatus: queryRoot.querySelector('#manager-transfer-status'),
    frameRate: queryRoot.querySelector('#frame-rate'),
    runtimeNote: queryRoot.querySelector('#runtime-note'),
};
const context = elements.canvas.getContext('2d', { alpha: false });
let imageData = context.createImageData(160, 144);
const pressedButtons = new Set();
const inputSources = new Map([
    ['keyboard', new Set()],
    ['pointer', new Set()],
    ['gamepad', new Set()],
]);
const keyboardMap = new Map([
    ['ArrowUp', 'up'],
    ['KeyW', 'up'],
    ['ArrowDown', 'down'],
    ['KeyS', 'down'],
    ['ArrowLeft', 'left'],
    ['KeyA', 'left'],
    ['ArrowRight', 'right'],
    ['KeyD', 'right'],
    ['KeyZ', 'a'],
    ['KeyX', 'b'],
    ['Enter', 'start'],
    ['ShiftLeft', 'select'],
    ['ShiftRight', 'select'],
    ['KeyQ', 'l'],
    ['KeyE', 'r'],
]);
let romBytes = null;
let gbaBIOS = null;
let detectedROM = null;
let runtime = null;
let animationFrame = 0;
let lastAnimationTime = 0;
let frameAccumulator = 0;
let framesSinceSample = 0;
let fpsSampleTime = 0;
let audioUnderrunsSinceSample = 0;
let audioGeneration = 0;
let paused = false;
let soundEnabled = true;
let audioContext = null;
let audioInitialization = null;
let audioWorkletNode = null;
let audioWorkletState = 'unavailable';
let gbaHighPass = null;
let audioNextTime = 0;
let dragDepth = 0;
let saveTimer = 0;
let romFileName = '';

function formatBytes(bytes) {

    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
    }

    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function setStatus(state, message) {

    elements.body.dataset.state = state;
    elements.statusText.textContent = message;
    elements.statusText.title = '';
}

function setScreenMessage(title, detail) {

    elements.screenMessage.replaceChildren();

    const heading = document.createElement('strong');
    const copy = document.createElement('span');

    heading.textContent = title;
    copy.textContent = detail;
    elements.screenMessage.append(heading, copy);
    elements.screenMessage.hidden = false;
}

function getSaveKey(header) {

    const checksum = header.platform === 'gba'
        ? `${header.gameCode}:${header.headerChecksum.toString(16).padStart(2, '0')}`
        : header.globalChecksum.toString(16).padStart(4, '0');

    return `gbjs:save:${header.title}:${checksum}`;
}

function getRTCKey(header) {

    return `${getSaveKey(header)}:rtc`;
}

function encodeBytes(bytes) {

    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }

    return btoa(binary);
}

function decodeBytes(value) {

    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}

function persistSave(cartridge) {

    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {

        try {
            storeSave(cartridge);
        } catch (error) {
            console.warn('Could not persist cartridge RAM.', error);
        }
    }, 250);
}

function storeSave(cartridge) {

    localStorage.setItem(getSaveKey(cartridge.header), encodeBytes(cartridge.dumpRAM()));
}

function hasStoredSave(header) {

    try {
        return localStorage.getItem(getSaveKey(header)) !== null;
    } catch {
        return false;
    }
}

function loadSave(cartridge) {

    if (cartridge.ram.length === 0) {
        return;
    }

    try {
        const value = localStorage.getItem(getSaveKey(cartridge.header));

        if (value !== null) {
            cartridge.loadRAM(decodeBytes(value));
        }
    } catch (error) {
        console.warn('Could not restore cartridge RAM.', error);
    }
}

function persistRTC(header, state) {

    try {
        localStorage.setItem(getRTCKey(header), JSON.stringify(state));
    } catch (error) {
        console.warn('Could not persist cartridge RTC.', error);
    }
}

function loadRTC(header) {

    try {
        const value = localStorage.getItem(getRTCKey(header));

        if (value === null) {
            return undefined;
        }

        const state = JSON.parse(value);

        if (typeof state?.control !== 'number'
            || typeof state?.offsetMilliseconds !== 'number'
            || !Number.isFinite(state.offsetMilliseconds)) {
            throw new TypeError('Stored RTC state is invalid.');
        }

        return {
            control: state.control,
            offsetMilliseconds: state.offsetMilliseconds,
        };
    } catch (error) {
        console.warn('Could not restore cartridge RTC.', error);
        return undefined;
    }
}

function initializePostBoot(cpu, bus, model) {

    if (model === 'cgb') {
        cpu.registers.af = 0x1180;
        cpu.registers.bc = 0x0000;
        cpu.registers.de = 0xff56;
        cpu.registers.hl = 0x000d;
    } else {
        cpu.registers.af = 0x01b0;
        cpu.registers.bc = 0x0013;
        cpu.registers.de = 0x00d8;
        cpu.registers.hl = 0x014d;
    }

    cpu.registers.sp = 0xfffe;
    cpu.registers.pc = 0x0100;
    bus.write(0xff40, 0x91);
}

function createRuntime(bytes, model) {

    if (model === 'gba') {
        let cartridge;
        const rtcDetected = hasGBARTC(bytes);
        const rtcState = rtcDetected ? loadRTC(detectedROM.header) : undefined;
        const system = new GameBoyAdvanceSystem({
            rom: bytes,
            ...(gbaBIOS === null ? {} : { bootROM: gbaBIOS }),
            ...(rtcDetected
                ? {
                    rtc: {
                        ...(rtcState === undefined ? {} : { initialState: rtcState }),
                        onWrite: (state) => persistRTC(detectedROM.header, state),
                    },
                }
                : {}),
            audioSampleRate: AUDIO_SAMPLE_RATE,
            audioBufferCapacity: 4096,
            onSaveWrite: () => persistSave(cartridge),
        });
        const saveDevice = system.bus.eeprom ?? system.bus.save;

        if (saveDevice !== undefined) {
            cartridge = {
                header: detectedROM.header,
                saveType: system.bus.eeprom !== undefined
                    ? 'EEPROM'
                    : {
                        sram: 'SRAM',
                        flash512: 'Flash 512K',
                        flash1m: 'Flash 1M',
                    }[system.bus.save.type],
                get ram() {

                    return saveDevice.data.subarray(0, saveDevice.byteLength);
                },
                dumpRAM: () => saveDevice.dump(),
                loadRAM: (data) => saveDevice.load(data),
            };
            loadSave(cartridge);
        } else {
            cartridge = null;
        }

        return {
            model,
            cartridge,
            frame: system.frame,
            runFrame: () => {

                const targetCycle = (
                    Math.floor(system.cycles / GAME_BOY_ADVANCE_CYCLES_PER_FRAME) + 1
                ) * GAME_BOY_ADVANCE_CYCLES_PER_FRAME;
                let instructions = 0;

                while (system.cycles < targetCycle
                    && instructions < MAX_INSTRUCTIONS_PER_FRAME) {
                    system.step();
                    instructions++;
                }

                if (instructions === MAX_INSTRUCTIONS_PER_FRAME) {
                    throw new Error('The emulator did not reach the next video frame.');
                }
            },
            drainAudio: () => system.drainAudio(),
            setRenderingEnabled: (enabled) => system.bus.ppu.setRenderingEnabled(enabled),
            setButton: (button, pressed) => system.setButton(button, pressed),
        };
    }

    let cartridge;

    cartridge = createGameBoyCartridge(bytes, {
        onRAMWrite: () => persistSave(cartridge),
    });
    loadSave(cartridge);

    const bus = new DMGBus({
        cartridge,
        model,
        audioSampleRate: AUDIO_SAMPLE_RATE,
        audioBufferCapacity: 4096,
        framePalette: model === 'dmg'
            ? [0xffd9e6a2, 0xffa8ba72, 0xff627747, 0xff26351f]
            : undefined,
    });
    const cpu = new SM83CPU(bus);

    initializePostBoot(cpu, bus, model);
    cartridge.saveType = cartridge.ram.length === 0
        ? 'None'
        : (cartridge.header.cartridgeType.hasBattery ? 'Battery-backed RAM' : 'Cartridge RAM');

    return {
        model,
        cartridge,
        frame: bus.frame,
        runFrame: () => {

            const targetFrame = bus.completedFrames + 1;
            let instructions = 0;

            while (bus.completedFrames < targetFrame && instructions < MAX_INSTRUCTIONS_PER_FRAME) {
                cpu.step();
                instructions++;

                if (cpu.isLocked) {
                    throw new Error('The CPU entered a locked state. This ROM may use unsupported hardware.');
                }
            }

            if (instructions === MAX_INSTRUCTIONS_PER_FRAME) {
                throw new Error('The emulator did not reach the next video frame.');
            }
        },
        drainAudio: () => bus.drainAudio(),
        setRenderingEnabled: () => {},
        setButton: (button, pressed) => bus.setButton(button, pressed),
    };
}

function configureVideo(frame) {

    elements.canvas.width = frame.width;
    elements.canvas.height = frame.height;
    imageData = context.createImageData(frame.width, frame.height);
    context.imageSmoothingEnabled = false;
}

function updateROMDetails(detected, file) {

    const { header, model } = detected;
    const systemNames = {
        dmg: 'Game Boy',
        cgb: 'Game Boy Color',
        gba: 'Game Boy Advance',
    };

    elements.body.dataset.model = model;
    elements.gameTitle.textContent = header.title || file.name.replace(/\.[^.]+$/, '') || 'Untitled ROM';
    elements.gameSubtitle.textContent = file.name;
    elements.deviceLabel.textContent = systemNames[model].toUpperCase();
    elements.modelChip.textContent = model.toUpperCase();
    elements.factSystem.textContent = systemNames[model];
    elements.factSize.textContent = formatBytes(file.size);
    elements.factHeader.textContent = header.headerChecksumValid ? 'Valid checksum' : 'Checksum mismatch';
    elements.factCartridge.textContent = header.platform === 'gb'
        ? header.cartridgeType.name
        : (header.gameCode ? `Game code ${header.gameCode}` : 'GBA cartridge');
    elements.facts.hidden = false;
    elements.cartridgeManagerButton.hidden = false;
    elements.dropZone.querySelector('.drop-zone__label').textContent = 'Load another ROM';
    elements.dropZone.querySelector('.drop-zone__hint').textContent = '.gb, .gbc, .gba or GBA BIOS .bin';
}

function hex(value, width) {

    return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

function replaceFacts(element, facts) {

    element.replaceChildren(...facts.map(([label, value]) => {

        const row = document.createElement('div');
        const term = document.createElement('dt');
        const description = document.createElement('dd');

        term.textContent = label;
        description.textContent = value;
        row.append(term, description);
        return row;
    }));
}

function updateCartridgeManager() {

    if (detectedROM === null || romBytes === null || runtime === null) {
        elements.cartridgeManagerButton.disabled = true;
        return;
    }

    const { header, model } = detectedROM;
    const cartridge = runtime.cartridge;
    const systemNames = {
        dmg: 'Game Boy',
        cgb: 'Game Boy Color',
        gba: 'Game Boy Advance',
    };
    const romFacts = [
        ['System', systemNames[model]],
        ['Title', header.title || 'Untitled'],
        ['File', romFileName],
        ['ROM size', formatBytes(romBytes.length)],
        ['Revision', String(header.version)],
    ];

    if (header.platform === 'gb') {
        const compatibility = {
            dmg: 'Game Boy',
            dual: 'Game Boy / Game Boy Color',
            cgb: 'Game Boy Color',
        }[header.compatibility];

        romFacts.push(
            ['Compatibility', compatibility],
            ['Mapper', header.cartridgeType.mapper.toUpperCase()],
            ['Cartridge type', header.cartridgeType.name],
            ['Region', header.destination === 'japan' ? 'Japan' : 'Overseas'],
            ['Boot logo', header.logoValid ? 'Valid' : 'Invalid'],
            ['Header checksum', `${header.headerChecksumValid ? 'Valid' : 'Invalid'} (${hex(header.headerChecksum, 2)})`],
            ['ROM checksum', `${header.globalChecksumValid ? 'Valid' : 'Invalid'} (${hex(header.globalChecksum, 4)})`],
        );

        if (header.manufacturerCode !== '') {
            romFacts.splice(5, 0, ['Manufacturer', header.manufacturerCode]);
        }
    } else {
        romFacts.push(
            ['Game code', header.gameCode || '—'],
            ['Maker code', header.makerCode || '—'],
            ['Unit code', hex(header.unitCode, 2)],
            ['Device type', hex(header.deviceType, 2)],
            ['Boot logo', header.logoValid ? 'Valid' : 'Invalid'],
            ['Header checksum', `${header.headerChecksumValid ? 'Valid' : 'Invalid'} (${hex(header.headerChecksum, 2)})`],
        );
    }

    const saveAvailable = cartridge !== null && cartridge.ram.length > 0;
    const hasRTC = header.platform === 'gb'
        ? header.cartridgeType.hasTimer
        : hasGBARTC(romBytes);
    const browserSave = saveAvailable && hasStoredSave(header);

    elements.managerSubtitle.textContent = romFileName;
    replaceFacts(elements.managerROMFacts, romFacts);
    replaceFacts(elements.managerSaveFacts, [
        ['Save type', saveAvailable ? cartridge.saveType : 'None'],
        ['Capacity', saveAvailable ? formatBytes(cartridge.ram.length) : '—'],
        ['Real-time clock', hasRTC ? 'Present' : 'Not present'],
        ['Browser copy', browserSave ? 'Stored locally' : 'Not written yet'],
    ]);
    elements.managerBackupButton.disabled = !saveAvailable;
    elements.managerRestoreButton.disabled = !saveAvailable;
    elements.cartridgeManagerButton.disabled = false;
}

function clearPressedButtons() {

    for (const button of pressedButtons) {
        runtime?.setButton(button, false);
    }

    pressedButtons.clear();
    for (const buttons of inputSources.values()) {
        buttons.clear();
    }
    queryRoot.querySelectorAll('[data-button].is-pressed').forEach((button) => {

        button.classList.remove('is-pressed');
    });
}

function updateSaveControls() {

    const saveAvailable = runtime?.cartridge !== null
        && runtime?.cartridge !== undefined
        && runtime.cartridge.ram.length > 0;

    elements.importSaveButton.disabled = !saveAvailable;
    elements.exportSaveButton.disabled = !saveAvailable;
    elements.cartridgeManagerButton.disabled = runtime === null;
}

function stopRuntime() {

    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    runtime = null;
    paused = false;
    lastAnimationTime = 0;
    frameAccumulator = 0;
    framesSinceSample = 0;
    fpsSampleTime = 0;
    clearAudioQueue();
    clearPressedButtons();
    updateSaveControls();
}

async function ensureAudio() {

    if (!soundEnabled) {
        return null;
    }

    if (audioContext === null) {
        const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: 'interactive' });

        audioContext = context;
        audioWorkletState = 'pending';
        audioInitialization = initializeAudioWorklet(context);
    }

    const context = audioContext;

    if (gbaHighPass === null) {
        gbaHighPass = context.createBiquadFilter();
        gbaHighPass.type = 'highpass';
        gbaHighPass.frequency.value = 20;
        gbaHighPass.Q.value = 0.5;
        gbaHighPass.connect(context.destination);
    }

    await audioInitialization;

    if (audioContext !== context) {
        return null;
    }

    connectAudioOutput();

    if (context.state === 'suspended') {
        await context.resume();
    }

    return context;
}

async function initializeAudioWorklet(context) {

    if (context.audioWorklet === undefined || typeof AudioWorkletNode === 'undefined') {
        audioWorkletState = 'unavailable';
        return;
    }

    try {
        await context.audioWorklet.addModule(`./audio-worklet.js?v=${AUDIO_WORKLET_VERSION}`);

        if (audioContext !== context || !soundEnabled) {
            return;
        }

        const node = new AudioWorkletNode(context, 'gb-audio-ring-buffer', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: {
                capacity: AUDIO_RING_CAPACITY,
                startThreshold: AUDIO_RING_START_THRESHOLD,
                generation: audioGeneration,
            },
        });

        node.addEventListener('processorerror', () => {

            if (audioWorkletNode !== node) {
                return;
            }

            node.disconnect();
            audioWorkletNode = null;
            audioWorkletState = 'unavailable';
            audioNextTime = 0;
            console.warn('AudioWorklet stopped; using scheduled audio buffers.');
        });
        node.port.onmessage = (event) => {

            if (audioWorkletNode !== node || event.data?.generation !== audioGeneration) {
                return;
            }

            if (event.data.type === 'underrun') {
                audioUnderrunsSinceSample++;
            }
        };
        audioWorkletNode = node;
        audioWorkletState = 'ready';
    } catch (error) {
        audioWorkletState = 'unavailable';
        console.warn('AudioWorklet is unavailable; using scheduled audio buffers.', error);
    }
}

function connectAudioOutput() {

    if (audioWorkletNode === null || audioContext === null) {
        return;
    }

    audioWorkletNode.disconnect();
    audioWorkletNode.connect(runtime?.model === 'gba' ? gbaHighPass : audioContext.destination);
}

function clearAudioQueue() {

    audioNextTime = 0;
    audioUnderrunsSinceSample = 0;
    audioGeneration++;
    audioWorkletNode?.port.postMessage({
        type: 'clear',
        generation: audioGeneration,
    });
}

function queueAudio() {

    const samples = runtime?.drainAudio();

    if (!samples || samples.left.length === 0 || !soundEnabled || !audioContext || audioContext.state !== 'running') {
        return;
    }

    if (audioWorkletNode !== null) {
        audioWorkletNode.port.postMessage({
            type: 'write',
            left: samples.left,
            right: samples.right,
        }, [samples.left.buffer, samples.right.buffer]);
        return;
    }

    if (audioWorkletState === 'pending') {
        return;
    }

    const audioBuffer = audioContext.createBuffer(2, samples.left.length, samples.sampleRate);

    audioBuffer.copyToChannel(samples.left, 0);
    audioBuffer.copyToChannel(samples.right, 1);

    const source = audioContext.createBufferSource();

    source.buffer = audioBuffer;

    if (runtime.model === 'gba') {
        source.connect(gbaHighPass);
    } else {
        source.connect(audioContext.destination);
    }

    const now = audioContext.currentTime;

    if (audioNextTime === 0) {
        audioNextTime = now + AUDIO_START_LEAD;
    } else if (audioNextTime < now) {
        audioUnderrunsSinceSample++;
        audioNextTime = now + AUDIO_START_LEAD;
    }

    source.start(audioNextTime);
    audioNextTime += audioBuffer.duration;
}

function renderFrame() {

    const pixels = runtime.frame.pixels;
    const output = imageData.data;

    for (let index = 0; index < pixels.length; index++) {
        const pixel = pixels[index];
        const offset = index * 4;

        output[offset] = (pixel >>> 16) & 0xff;
        output[offset + 1] = (pixel >>> 8) & 0xff;
        output[offset + 2] = pixel & 0xff;
        output[offset + 3] = 0xff;
    }

    context.putImageData(imageData, 0, 0);
}

function emulateFrame(renderOutput) {

    runtime.setRenderingEnabled(renderOutput);
    runtime.runFrame();

    if (renderOutput) {
        renderFrame();
        queueAudio();
    }
}

function updateFPS(time, completedFrames) {

    framesSinceSample += completedFrames;

    if (fpsSampleTime === 0) {
        fpsSampleTime = time;
        return;
    }

    if (time - fpsSampleTime >= 1000) {
        const fps = Math.round(framesSinceSample * 1000 / (time - fpsSampleTime));
        const audioStatus = audioUnderrunsSinceSample === 0 ? '' : ` · ${audioUnderrunsSinceSample} gaps`;

        elements.frameRate.textContent = `${fps} FPS${audioStatus}`;
        framesSinceSample = 0;
        fpsSampleTime = time;
        audioUnderrunsSinceSample = 0;
    }
}

function failRuntime(error) {

    console.error(error);
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    paused = true;
    clearPressedButtons();
    setStatus('error', 'Emulation stopped');
    setScreenMessage('STOPPED', error instanceof Error ? error.message : 'Unknown emulator error');
    elements.runtimeNote.textContent = error instanceof Error ? error.message : 'The emulator stopped unexpectedly.';
    elements.runtimeNote.hidden = false;
    updatePauseButton();
}

function tick(time) {

    if (!runtime || paused) {
        return;
    }

    pollGamepads();

    if (lastAnimationTime === 0) {
        lastAnimationTime = time;
    }

    frameAccumulator += Math.min(time - lastAnimationTime, 100);
    lastAnimationTime = time;

    const framesToRun = Math.min(
        Math.floor(frameAccumulator / FRAME_DURATION),
        MAX_FRAMES_PER_TICK,
    );
    let frames = 0;

    try {
        while (frames < framesToRun) {
            emulateFrame(frames === framesToRun - 1);
            frameAccumulator -= FRAME_DURATION;
            frames++;
        }

        if (frames === MAX_FRAMES_PER_TICK) {
            frameAccumulator = Math.min(frameAccumulator, FRAME_DURATION);
        }

        if (frames > 0) {
            updateFPS(time, frames);
        }
    } catch (error) {
        failRuntime(error);
        return;
    }

    animationFrame = requestAnimationFrame(tick);
}

function startRuntime() {

    stopRuntime();

    try {
        runtime = createRuntime(romBytes, detectedROM.model);
        configureVideo(runtime.frame);
        elements.screenMessage.hidden = true;
        elements.runtimeNote.textContent = detectedROM.model === 'gba' && gbaBIOS === null
            ? 'Running without a GBA BIOS. Games that call BIOS services require a 16 KB BIOS .bin file.'
            : '';
        elements.runtimeNote.hidden = elements.runtimeNote.textContent === '';
        elements.pauseButton.disabled = false;
        elements.resetButton.disabled = false;
        elements.soundButton.disabled = false;
        updateSaveControls();
        updateCartridgeManager();
        elements.frameRate.textContent = '— FPS';
        paused = false;
        setStatus('running', `${detectedROM.model.toUpperCase()} running`);
        updatePauseButton();
        ensureAudio().catch(console.warn);
        animationFrame = requestAnimationFrame(tick);
    } catch (error) {
        failRuntime(error);
    }
}

async function loadROM(file) {

    if (!file) {
        return;
    }

    setStatus('loading', 'Reading cartridge');
    elements.importSaveButton.disabled = true;
    elements.exportSaveButton.disabled = true;

    try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (bytes.length === GBA_BIOS_SIZE && file.name.toLowerCase().endsWith('.bin')) {
            gbaBIOS = bytes;
            setStatus('ready', 'GBA BIOS loaded');

            if (detectedROM?.model === 'gba' && romBytes !== null) {
                startRuntime();
            } else {
                setScreenMessage('GBA BIOS READY', 'Load a .gba ROM');
                elements.runtimeNote.textContent = 'The BIOS is kept in memory for this browser session only.';
                elements.runtimeNote.hidden = false;
            }
            updateSaveControls();
            return;
        }

        const detected = detectROM(bytes);

        if (detected === null) {
            throw new TypeError('This is not a recognized Game Boy, Game Boy Color, or Game Boy Advance ROM.');
        }

        romBytes = bytes;
        detectedROM = detected;
        romFileName = file.name;
        updateROMDetails(detected, file);

        startRuntime();
    } catch (error) {
        stopRuntime();
        setStatus('error', 'Could not load ROM');
        setScreenMessage('LOAD ERROR', error instanceof Error ? error.message : 'Invalid cartridge');
        elements.runtimeNote.textContent = error instanceof Error ? error.message : 'The cartridge could not be loaded.';
        elements.runtimeNote.hidden = false;
        elements.pauseButton.disabled = true;
        elements.resetButton.disabled = true;
        elements.soundButton.disabled = true;
    } finally {
        elements.fileInput.value = '';
    }
}

function updatePauseButton() {

    elements.pauseIcon.textContent = paused ? '▶' : 'Ⅱ';
    elements.pauseLabel.textContent = paused ? 'Resume' : 'Pause';
}

function getSaveFileName() {

    const stem = romFileName
        .replace(/\.[^.]+$/, '')
        .replace(/[/\\?%*:|"<>]/g, '-')
        .trim();

    return `${stem || 'gameboy-save'}.sav`;
}

function downloadSave() {

    const cartridge = runtime?.cartridge;

    if (cartridge === null || cartridge === undefined || cartridge.ram.length === 0) {
        return;
    }

    const url = URL.createObjectURL(new Blob([cartridge.dumpRAM()], {
        type: 'application/octet-stream',
    }));
    const link = document.createElement('a');

    link.href = url;
    link.download = getSaveFileName();
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(paused ? 'paused' : 'running', 'Save downloaded');
    elements.managerTransferStatus.dataset.state = 'success';
    elements.managerTransferStatus.textContent = `Backup downloaded as ${getSaveFileName()}`;
}

async function importSave(file) {

    const cartridge = runtime?.cartridge;

    if (!file || cartridge === null || cartridge === undefined || cartridge.ram.length === 0) {
        return;
    }

    const previousSave = cartridge.dumpRAM();

    try {
        const data = new Uint8Array(await file.arrayBuffer());

        cartridge.loadRAM(data);
        window.clearTimeout(saveTimer);
        saveTimer = 0;

        try {
            storeSave(cartridge);
        } catch (error) {
            cartridge.loadRAM(previousSave);
            throw error;
        }

        startRuntime();
        setStatus('running', 'Save imported');
        elements.managerTransferStatus.dataset.state = 'success';
        elements.managerTransferStatus.textContent = `Restored ${file.name}`;
    } catch (error) {
        console.error(error);
        setStatus(paused ? 'paused' : 'running', 'Save import failed');
        elements.statusText.title = error instanceof Error ? error.message : 'Invalid save file';
        elements.managerTransferStatus.dataset.state = 'error';
        elements.managerTransferStatus.textContent = error instanceof Error
            ? error.message
            : 'Invalid save file';
    } finally {
        elements.saveInput.value = '';
    }
}

function togglePause() {

    if (!runtime) {
        return;
    }

    paused = !paused;
    clearPressedButtons();
    updatePauseButton();

    if (paused) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        setStatus('paused', 'Paused');
        elements.frameRate.textContent = '— FPS';
        clearAudioQueue();
    } else {
        lastAnimationTime = 0;
        frameAccumulator = 0;
        setStatus('running', `${detectedROM.model.toUpperCase()} running`);
        ensureAudio().catch(console.warn);
        animationFrame = requestAnimationFrame(tick);
    }
}

function setGameButton(button, pressed, source) {

    if (!runtime || paused) {
        return;
    }

    const sourceButtons = inputSources.get(source);
    const wasPressed = pressedButtons.has(button);

    if (pressed) {
        sourceButtons.add(button);
    } else {
        sourceButtons.delete(button);
    }

    const isPressed = [...inputSources.values()].some((buttons) => buttons.has(button));

    if (wasPressed === isPressed) {
        return;
    }

    if (isPressed) {
        pressedButtons.add(button);
    } else {
        pressedButtons.delete(button);
    }

    runtime.setButton(button, isPressed);
    queryRoot.querySelectorAll(`[data-button="${button}"]`).forEach((control) => {

        control.classList.toggle('is-pressed', isPressed);
    });
}

function pollGamepads() {

    if (elements.cartridgeManager.open) {
        return;
    }

    const nextButtons = new Set();
    const gamepadButtons = inputSources.get('gamepad');
    const gamepads = document.hasFocus() ? navigator.getGamepads?.() ?? [] : [];

    for (const gamepad of gamepads) {
        if (gamepad === null) {
            continue;
        }

        for (const [index, button] of gamepadButtonMap) {
            if (gamepad.buttons[index]?.pressed || gamepad.buttons[index]?.value > 0.5) {
                nextButtons.add(button);
            }
        }

        if (gamepad.axes[0] <= -GAMEPAD_AXIS_THRESHOLD) {
            nextButtons.add('left');
        } else if (gamepad.axes[0] >= GAMEPAD_AXIS_THRESHOLD) {
            nextButtons.add('right');
        }

        if (gamepad.axes[1] <= -GAMEPAD_AXIS_THRESHOLD) {
            nextButtons.add('up');
        } else if (gamepad.axes[1] >= GAMEPAD_AXIS_THRESHOLD) {
            nextButtons.add('down');
        }
    }

    for (const button of gamepadButtons) {
        if (!nextButtons.has(button)) {
            setGameButton(button, false, 'gamepad');
        }
    }

    for (const button of nextButtons) {
        if (!gamepadButtons.has(button)) {
            setGameButton(button, true, 'gamepad');
        }
    }
}

function handleKeyboard(event, pressed) {

    if (elements.cartridgeManager.open) {
        return;
    }

    if (event.code === 'Space' && pressed && !event.repeat && runtime) {
        event.preventDefault();
        togglePause();
        return;
    }

    const button = keyboardMap.get(event.code);

    if (button === undefined || !runtime) {
        return;
    }

    event.preventDefault();
    if (pressed) {
        ensureAudio().catch(console.warn);
    }
    setGameButton(button, pressed, 'keyboard');
}

elements.dropZone.addEventListener('click', () => elements.fileInput.click());
elements.openButton.addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', () => loadROM(elements.fileInput.files?.[0]));
elements.pauseButton.addEventListener('click', togglePause);
elements.resetButton.addEventListener('click', () => {

    if (romBytes) {
        startRuntime();
    }
});
elements.soundButton.addEventListener('click', async () => {

    soundEnabled = !soundEnabled;
    elements.soundIcon.textContent = soundEnabled ? '♪' : '×';
    elements.soundLabel.textContent = soundEnabled ? 'Sound on' : 'Sound off';

    if (soundEnabled) {
        await ensureAudio();
    } else {
        runtime?.drainAudio();
        clearAudioQueue();

        const context = audioContext;

        audioContext = null;
        audioInitialization = null;
        audioWorkletNode?.disconnect();
        audioWorkletNode = null;
        audioWorkletState = 'unavailable';
        gbaHighPass = null;
        await context?.close();
    }
});
elements.importSaveButton.addEventListener('click', () => elements.saveInput.click());
elements.exportSaveButton.addEventListener('click', downloadSave);
elements.saveInput.addEventListener('change', () => importSave(elements.saveInput.files?.[0]));
elements.cartridgeManagerButton.addEventListener('click', () => {

    clearPressedButtons();
    updateCartridgeManager();
    elements.managerTransferStatus.dataset.state = '';
    elements.managerTransferStatus.textContent = 'Ready';
    elements.cartridgeManager.showModal();
});
elements.managerBackupButton.addEventListener('click', downloadSave);
elements.managerRestoreButton.addEventListener('click', () => elements.saveInput.click());
elements.fullscreenButton.addEventListener('click', () => {

    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        elements.playerStage.requestFullscreen?.();
    }
});

for (const control of queryRoot.querySelectorAll('[data-button]')) {
    const button = control.dataset.button;

    control.addEventListener('pointerdown', (event) => {

        event.preventDefault();
        control.setPointerCapture(event.pointerId);
        ensureAudio().catch(console.warn);
        setGameButton(button, true, 'pointer');
    });
    control.addEventListener('pointerup', () => setGameButton(button, false, 'pointer'));
    control.addEventListener('pointercancel', () => setGameButton(button, false, 'pointer'));
}

window.addEventListener('keydown', (event) => handleKeyboard(event, true));
window.addEventListener('keyup', (event) => handleKeyboard(event, false));
window.addEventListener('blur', clearPressedButtons);
document.addEventListener('visibilitychange', () => {

    if (document.hidden && runtime && !paused) {
        togglePause();
    }
});

window.addEventListener('dragenter', (event) => {

    event.preventDefault();
    dragDepth++;
    elements.dropOverlay.classList.add('is-visible');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', (event) => {

    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);

    if (dragDepth === 0) {
        elements.dropOverlay.classList.remove('is-visible');
    }
});
window.addEventListener('drop', (event) => {

    event.preventDefault();
    dragDepth = 0;
    elements.dropOverlay.classList.remove('is-visible');
    loadROM(event.dataTransfer?.files?.[0]);
});

window.addEventListener('beforeunload', () => {

    if (runtime?.cartridge?.ram.length) {
        try {
            localStorage.setItem(getSaveKey(runtime.cartridge.header), encodeBytes(runtime.cartridge.dumpRAM()));
        } catch (error) {
            console.warn('Could not persist cartridge RAM before closing.', error);
        }
    }
});

context.imageSmoothingEnabled = false;
context.fillStyle = '#9baa6b';
context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
