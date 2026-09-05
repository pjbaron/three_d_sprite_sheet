/**
 * Preview - plays a captured sheet back as an animation.
 *
 * Two things it is really for:
 *   - checking the sampled frames read as motion rather than as a slideshow,
 *     before committing the sheet to anything downstream
 *   - proving the JSON is complete. Playback reads only the sheet canvas and
 *     the metadata, using exactly the compositing recipe the README documents,
 *     so if the travel replays correctly here it will replay correctly for
 *     anyone else consuming the files.
 *
 * The figure is drawn by its anchor (the hips), not by its cell corner:
 *     destX = origin.x - frame.anchor.x + frame.rootOffsetPx.x
 * Dropping the rootOffsetPx term is what the "locked" mode does, which is why
 * the same code path covers both.
 */
const Preview = {
    canvas: null,
    ctx: null,

    sheets: null,       // { beauty: HTMLCanvasElement, bones: HTMLCanvasElement }
    meta: null,

    pass: 'beauty',
    playing: true,
    speed: 1,
    reconstruct: true,  // add the removed root travel back in
    showPath: false,

    index: 0,
    origin: { x: 0, y: 0 },
    durations: [],      // seconds per frame
    anchors: [],        // anchor position in canvas pixels, per frame

    MAX_DISPLAY_HEIGHT: 420,

    _raf: null,
    _lastTime: 0,
    _elapsed: 0,        // seconds spent on the current frame
    _onFrame: null,     // callback so the UI can show the frame counter

    mount(canvas, onFrame) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._onFrame = onFrame || null;
        return this;
    },

    /** Hand it a Capture.run() result. */
    setResult(result) {
        this.sheets = { beauty: result.beauty, bones: result.bones };
        this.meta = result.meta;
        this.index = 0;
        this._elapsed = 0;
        this._buildTimeline();
        this.layout();
        this.start();
    },

    hasResult() {
        return !!this.meta;
    },

    /**
     * Per-frame durations from the source timestamps. Sampling is uniform, but
     * deriving each step from the metadata rather than assuming it keeps this
     * honest if the sampler ever changes.
     */
    _buildTimeline() {
        const f = this.meta.frames;
        this.durations = [];
        for (let i = 0; i < f.length; i++) {
            if (i < f.length - 1) {
                this.durations.push(Math.max(1e-3, f[i + 1].timeSeconds - f[i].timeSeconds));
            } else {
                // Last frame holds for the same step as the one before it. On a
                // looping clip that step is exactly the gap back to frame 0.
                this.durations.push(this.durations[i - 1] || 1 / 12);
            }
        }
    },

    /**
     * Size the canvas to hold every frame at its reconstructed position, so
     * nothing is clipped as the figure travels.
     */
    layout() {
        if (!this.meta) return;
        const m = this.meta;
        const cw = m.cell.width;
        const ch = m.cell.height;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const f of m.frames) {
            const ox = this.reconstruct ? f.rootOffsetPx.x : 0;
            const oy = this.reconstruct ? f.rootOffsetPx.y : 0;
            const dx = -f.anchor.x + ox;
            const dy = -f.anchor.y + oy;
            minX = Math.min(minX, dx);
            minY = Math.min(minY, dy);
            maxX = Math.max(maxX, dx + cw);
            maxY = Math.max(maxY, dy + ch);
        }

        this.origin = { x: -minX, y: -minY };
        this.canvas.width = Math.ceil(maxX - minX);
        this.canvas.height = Math.ceil(maxY - minY);

        this.anchors = m.frames.map(f => ({
            x: this.origin.x + (this.reconstruct ? f.rootOffsetPx.x : 0),
            y: this.origin.y + (this.reconstruct ? f.rootOffsetPx.y : 0),
        }));

        // Scale the displayed size down if the canvas is tall, keeping aspect
        // exactly rather than letting two CSS max- constraints fight.
        const s = Math.min(1, this.MAX_DISPLAY_HEIGHT / this.canvas.height);
        this.canvas.style.width = Math.round(this.canvas.width * s) + 'px';
        this.canvas.style.height = Math.round(this.canvas.height * s) + 'px';

        this.draw();
    },

    draw() {
        if (!this.meta) return;
        const m = this.meta;
        const f = m.frames[this.index];
        const ctx = this.ctx;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.showPath) this._drawPath();

        const ox = this.reconstruct ? f.rootOffsetPx.x : 0;
        const oy = this.reconstruct ? f.rootOffsetPx.y : 0;

        ctx.drawImage(
            this.sheets[this.pass],
            f.cell.x, f.cell.y, m.cell.width, m.cell.height,
            this.origin.x - f.anchor.x + ox,
            this.origin.y - f.anchor.y + oy,
            m.cell.width, m.cell.height
        );

        if (this.showPath) this._drawAnchorMarker();
        if (this._onFrame) this._onFrame(this.index, m.frames.length, f);
    },

    _drawPath() {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(90, 170, 255, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        this.anchors.forEach((a, i) => {
            if (i === 0) ctx.moveTo(a.x, a.y);
            else ctx.lineTo(a.x, a.y);
        });
        ctx.stroke();
        ctx.restore();
    },

    _drawAnchorMarker() {
        const a = this.anchors[this.index];
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(90, 170, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    },

    // ---- transport ------------------------------------------------------

    start() {
        this.stop();
        this._lastTime = performance.now();
        const step = (now) => {
            const dt = Math.min(0.25, (now - this._lastTime) / 1000);
            this._lastTime = now;
            if (this.playing && this.meta) this._advance(dt * this.speed);
            this._raf = requestAnimationFrame(step);
        };
        this._raf = requestAnimationFrame(step);
    },

    stop() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
    },

    _advance(dt) {
        this._elapsed += dt;
        let changed = false;
        let guard = 0;
        while (this._elapsed >= this.durations[this.index] && guard++ < 1000) {
            this._elapsed -= this.durations[this.index];
            this.index = (this.index + 1) % this.meta.frames.length;
            changed = true;
        }
        if (changed) this.draw();
    },

    seek(i) {
        if (!this.meta) return;
        const n = this.meta.frames.length;
        this.index = ((i % n) + n) % n;
        this._elapsed = 0;
        this.draw();
    },

    setPass(pass) {
        this.pass = pass;
        this.draw();
    },

    setPlaying(on) {
        this.playing = on;
        this._lastTime = performance.now();
    },

    setSpeed(x) {
        this.speed = x;
    },

    setReconstruct(on) {
        this.reconstruct = on;
        this.layout();
    },

    setShowPath(on) {
        this.showPath = on;
        this.draw();
    },

    /** Total loop length in seconds at 1x. */
    duration() {
        return this.durations.reduce((a, b) => a + b, 0);
    },
};
