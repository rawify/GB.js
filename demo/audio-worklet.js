const DEFAULT_CAPACITY = 16384;
const DEFAULT_START_THRESHOLD = 7200;
const RATE_ESTIMATE_FRAMES = 4096;
const RATE_ESTIMATE_SMOOTHING = 0.5;
const RATE_RESPONSE = 0.02;
const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 1.05;
const MAX_LEVEL_RATE_CORRECTION = 0.06;
const LEVEL_CORRECTION_FRAMES = 48_000 * 2;
const STRETCH_GRAIN_SIZE = 1024;
const STRETCH_HOP_SIZE = STRETCH_GRAIN_SIZE / 2;
const STRETCH_SEARCH_RADIUS = 96;
const STRETCH_CORRELATION_STEP = 8;
const STRETCH_OFFSET_PENALTY = 0.0005;
const STRETCH_OUTPUT_CAPACITY = STRETCH_GRAIN_SIZE * 2;

class GameBoyAudioRingBuffer extends AudioWorkletProcessor {

    constructor(options) {

        super();

        const requestedCapacity = options.processorOptions?.capacity ?? DEFAULT_CAPACITY;

        this.capacity = Math.max(128, Math.trunc(requestedCapacity));
        this.startThreshold = Math.min(
            this.capacity,
            Math.max(128, Math.trunc(options.processorOptions?.startThreshold ?? DEFAULT_START_THRESHOLD)),
        );
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.playing = false;
        this.underrunning = false;
        this.adaptivePlayback = options.processorOptions?.adaptivePlayback !== false;
        this.playbackRate = 1;
        this.estimatedInputRate = 1;
        this.prebufferOutputFrames = 0;
        this.inputFramesSinceEstimate = 0;
        this.outputFramesSinceEstimate = 0;
        this.nextRateEstimateFrame = RATE_ESTIMATE_FRAMES;
        this.stretchTailLeft = new Float32Array(STRETCH_HOP_SIZE);
        this.stretchTailRight = new Float32Array(STRETCH_HOP_SIZE);
        this.stretchOutputLeft = new Float32Array(STRETCH_OUTPUT_CAPACITY);
        this.stretchOutputRight = new Float32Array(STRETCH_OUTPUT_CAPACITY);
        this.stretchOutputRead = 0;
        this.stretchOutputWrite = 0;
        this.stretchOutputAvailable = 0;
        this.stretchInitialized = false;
        this.stretchPositionError = 0;
        this.generation = Math.trunc(options.processorOptions?.generation ?? 0);
        this.port.onmessage = (event) => this.handleMessage(event.data);
    }

    process(_inputs, outputs) {

        const output = outputs[0];
        const left = output?.[0];
        const right = output?.[1] ?? left;

        if (left === undefined || right === undefined) {
            return true;
        }

        if (!this.playing && this.available > 0) {
            this.prebufferOutputFrames += left.length;
        }

        if (!this.playing && this.available >= this.startThreshold) {
            if (this.prebufferOutputFrames > 0) {
                const observedRate = this.available / this.prebufferOutputFrames;
                const boundedRate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, observedRate));

                this.estimatedInputRate = boundedRate;
                this.playbackRate = boundedRate;
            }

            this.playing = true;
            this.prebufferOutputFrames = 0;
            this.inputFramesSinceEstimate = 0;
            this.outputFramesSinceEstimate = 0;
            this.nextRateEstimateFrame = RATE_ESTIMATE_FRAMES;
        }

        if (!this.playing) {
            left.fill(0);
            right.fill(0);
            return true;
        }

        const readable = this.adaptivePlayback
            ? this.readStretched(left, right)
            : this.readDirect(left, right);

        if (readable < left.length) {
            left.fill(0, readable);
            right.fill(0, readable);

            if (!this.underrunning) {
                this.port.postMessage({
                    type: 'underrun',
                    missingFrames: left.length - readable,
                    generation: this.generation,
                });
            }

            this.underrunning = true;

            if (!this.adaptivePlayback) {
                this.playing = false;
                this.inputFramesSinceEstimate = 0;
                this.outputFramesSinceEstimate = 0;
                this.resetStretch();
            }
        } else {
            this.underrunning = false;
        }

        return true;
    }

    handleMessage(message) {

        if (message?.type === 'clear') {
            this.clear();
            this.generation = Math.trunc(message.generation ?? this.generation);
            return;
        }

        if (message?.type !== 'write'
            || !(message.left instanceof Float32Array)
            || !(message.right instanceof Float32Array)) {
            return;
        }

        this.write(message.left, message.right);
    }

    write(left, right) {

        const length = Math.min(left.length, right.length);
        const writeLength = Math.min(length, this.capacity);
        const sourceOffset = length - writeLength;
        const overflow = Math.max(0, this.available + writeLength - this.capacity);

        this.readIndex = (this.readIndex + overflow) % this.capacity;
        this.available -= overflow;

        if (overflow > 0) {
            this.resetStretch();
        }

        for (let index = 0; index < writeLength; index++) {
            this.left[this.writeIndex] = left[sourceOffset + index] ?? 0;
            this.right[this.writeIndex] = right[sourceOffset + index] ?? 0;
            this.writeIndex = (this.writeIndex + 1) % this.capacity;
        }

        this.available += writeLength;

        if (this.playing && this.adaptivePlayback) {
            this.inputFramesSinceEstimate += writeLength;
        }
    }

    readDirect(left, right) {

        const readable = Math.min(left.length, this.available);

        for (let index = 0; index < readable; index++) {
            left[index] = this.left[this.readIndex] ?? 0;
            right[index] = this.right[this.readIndex] ?? 0;
            this.readIndex = (this.readIndex + 1) % this.capacity;
        }

        this.available -= readable;
        return readable;
    }

    readStretched(left, right) {

        this.outputFramesSinceEstimate += left.length;

        if (this.outputFramesSinceEstimate >= this.nextRateEstimateFrame) {
            const observedRate = this.inputFramesSinceEstimate / this.outputFramesSinceEstimate;

            if (observedRate > 0) {
                const boundedRate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, observedRate));

                this.estimatedInputRate += (
                    boundedRate - this.estimatedInputRate
                ) * RATE_ESTIMATE_SMOOTHING;
            }

            this.nextRateEstimateFrame += RATE_ESTIMATE_FRAMES;
        }

        const levelCorrection = Math.min(
            MAX_LEVEL_RATE_CORRECTION,
            Math.max(
                -MAX_LEVEL_RATE_CORRECTION,
                (this.available - this.startThreshold) / LEVEL_CORRECTION_FRAMES,
            ),
        );
        const targetRate = Math.min(
            MAX_PLAYBACK_RATE,
            Math.max(MIN_PLAYBACK_RATE, this.estimatedInputRate + levelCorrection),
        );

        this.playbackRate += (targetRate - this.playbackRate) * RATE_RESPONSE;

        if (!this.stretchInitialized && this.playbackRate >= 0.985) {
            return this.readDirect(left, right);
        }

        let readable = 0;

        while (readable < left.length) {
            if (this.stretchOutputAvailable === 0 && !this.generateStretchGrain()) {
                break;
            }

            left[readable] = this.stretchOutputLeft[this.stretchOutputRead] ?? 0;
            right[readable] = this.stretchOutputRight[this.stretchOutputRead] ?? 0;
            this.stretchOutputRead = (this.stretchOutputRead + 1) % STRETCH_OUTPUT_CAPACITY;
            this.stretchOutputAvailable--;
            readable++;
        }

        return readable;
    }

    generateStretchGrain() {

        if (!this.stretchInitialized) {
            if (this.available < STRETCH_GRAIN_SIZE) {
                return false;
            }

            for (let index = 0; index < STRETCH_HOP_SIZE; index++) {
                this.enqueueStretchOutput(this.inputLeft(index), this.inputRight(index));
                this.stretchTailLeft[index] = this.inputLeft(index + STRETCH_HOP_SIZE);
                this.stretchTailRight[index] = this.inputRight(index + STRETCH_HOP_SIZE);
            }

            this.stretchInitialized = true;
            return true;
        }

        this.stretchPositionError += this.playbackRate * STRETCH_HOP_SIZE;

        const expectedOffset = Math.round(this.stretchPositionError);
        const searchStart = Math.max(1, expectedOffset - STRETCH_SEARCH_RADIUS);
        const searchEnd = expectedOffset + STRETCH_SEARCH_RADIUS;

        if (this.available < searchEnd + STRETCH_GRAIN_SIZE) {
            return false;
        }

        let bestOffset = expectedOffset;
        let bestScore = -Infinity;
        let bestCorrelation = 0;

        for (let offset = searchStart; offset <= searchEnd; offset++) {
            let correlation = 0;
            let referenceEnergy = 0;
            let candidateEnergy = 0;

            for (let index = 0; index < STRETCH_HOP_SIZE; index += STRETCH_CORRELATION_STEP) {
                const referenceLeft = this.stretchTailLeft[index];
                const referenceRight = this.stretchTailRight[index];
                const candidateLeft = this.inputLeft(offset + index);
                const candidateRight = this.inputRight(offset + index);

                correlation += referenceLeft * candidateLeft + referenceRight * candidateRight;
                referenceEnergy += referenceLeft * referenceLeft + referenceRight * referenceRight;
                candidateEnergy += candidateLeft * candidateLeft + candidateRight * candidateRight;
            }

            const energy = referenceEnergy * candidateEnergy;
            const normalizedCorrelation = energy > 0 ? correlation / Math.sqrt(energy) : 0;
            const score = normalizedCorrelation
                - Math.abs(offset - expectedOffset) * STRETCH_OFFSET_PENALTY;

            if (score > bestScore
                || (score === bestScore
                    && Math.abs(offset - expectedOffset) < Math.abs(bestOffset - expectedOffset))) {
                bestScore = score;
                bestOffset = offset;
                bestCorrelation = normalizedCorrelation;
            }
        }

        this.readIndex = (this.readIndex + bestOffset) % this.capacity;
        this.available -= bestOffset;
        this.stretchPositionError -= bestOffset;

        const overlapCorrelation = Math.max(0, Math.min(1, bestCorrelation));

        for (let index = 0; index < STRETCH_HOP_SIZE; index++) {
            const blend = index / STRETCH_HOP_SIZE;
            const tailWeight = 1 - blend;
            const normalization = 1 / Math.sqrt(
                tailWeight * tailWeight
                + blend * blend
                + 2 * overlapCorrelation * tailWeight * blend,
            );

            this.enqueueStretchOutput(
                (this.stretchTailLeft[index] * tailWeight + this.inputLeft(index) * blend)
                    * normalization,
                (this.stretchTailRight[index] * tailWeight + this.inputRight(index) * blend)
                    * normalization,
            );
            this.stretchTailLeft[index] = this.inputLeft(index + STRETCH_HOP_SIZE);
            this.stretchTailRight[index] = this.inputRight(index + STRETCH_HOP_SIZE);
        }

        return true;
    }

    inputLeft(offset) {

        return this.left[(this.readIndex + offset) % this.capacity] ?? 0;
    }

    inputRight(offset) {

        return this.right[(this.readIndex + offset) % this.capacity] ?? 0;
    }

    enqueueStretchOutput(left, right) {

        this.stretchOutputLeft[this.stretchOutputWrite] = left;
        this.stretchOutputRight[this.stretchOutputWrite] = right;
        this.stretchOutputWrite = (this.stretchOutputWrite + 1) % STRETCH_OUTPUT_CAPACITY;
        this.stretchOutputAvailable++;
    }

    resetStretch() {

        this.stretchOutputRead = 0;
        this.stretchOutputWrite = 0;
        this.stretchOutputAvailable = 0;
        this.stretchInitialized = false;
        this.stretchPositionError = 0;
    }

    clear() {

        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.playing = false;
        this.underrunning = false;
        this.playbackRate = 1;
        this.estimatedInputRate = 1;
        this.prebufferOutputFrames = 0;
        this.inputFramesSinceEstimate = 0;
        this.outputFramesSinceEstimate = 0;
        this.nextRateEstimateFrame = RATE_ESTIMATE_FRAMES;
        this.resetStretch();
    }
}

registerProcessor('gb-audio-ring-buffer', GameBoyAudioRingBuffer);
