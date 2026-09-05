/**
 * Capture - steps an AnimationGroup frame by frame and packs the renders
 * into a sprite sheet.
 *
 * Centre of mass:
 *   The hips bone is locked to a fixed screen position, so the figure never
 *   wanders inside the cell no matter how much the Mixamo clip translates.
 *   The motion that lock removes is measured first, against a stationary
 *   camera, and written into the JSON as rootOffsetPx / rootOffsetWorld so
 *   the original travel can be replayed exactly.
 *
 * Cropping:
 *   Every frame is rendered full size, then a single crop rectangle - the
 *   union of all frames' alpha bounds plus padding - is applied to all of
 *   them. One shared rectangle means uniform cells with no scale jitter.
 */
const Capture = {

    ALPHA_THRESHOLD: 8,     // 0-255; below this a pixel counts as empty
    FIT_FILL: 0.90,         // fraction of the frame the figure should occupy

    _scratch: null,

    _scratchCtx(w, h) {
        if (!this._scratch) this._scratch = document.createElement('canvas');
        if (this._scratch.width !== w || this._scratch.height !== h) {
            this._scratch.width = w;
            this._scratch.height = h;
        }
        return this._scratch.getContext('2d', { willReadFrequently: true });
    },

    /** Source frame numbers to sample, evenly spaced over the selected range. */
    sampleFrames(clip, opts) {
        const span = clip.to - clip.from;
        const a = clip.from + span * opts.rangeStart;
        const b = clip.from + span * opts.rangeEnd;
        const n = opts.frameCount;
        const out = [];
        for (let i = 0; i < n; i++) {
            // A looping clip's last frame repeats the first, so step by n
            // rather than n-1 to avoid capturing the same pose twice.
            const t = opts.loops ? i / n : (n === 1 ? 0 : i / (n - 1));
            out.push(a + (b - a) * t);
        }
        return out;
    },

    /** Pose the rig at one source frame and flush the transforms. */
    _goToFrame(ag, frame) {
        ag.goToFrame(frame);
        Rig.render();
    },

    _anchorWorld() {
        return Loader.model.anchorNode.node.getAbsolutePosition().clone();
    },

    /** Alpha bounding box of the current canvas, or null if fully empty. */
    _alphaBounds() {
        const w = Rig.engine.getRenderWidth();
        const h = Rig.engine.getRenderHeight();
        const ctx = this._scratchCtx(w, h);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(Rig.canvas, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;

        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
            const row = y * w * 4;
            for (let x = 0; x < w; x++) {
                if (data[row + x * 4 + 3] > this.ALPHA_THRESHOLD) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        return { minX, minY, maxX, maxY };
    },

    /** Position the camera for one frame, honouring the vertical lock. */
    _aimAt(anchor, anchor0, lockVertical) {
        const target = lockVertical
            ? anchor
            : new BABYLON.Vector3(anchor.x, anchor0.y, anchor.z);
        Rig.lookAt(target);
        Rig.render();
    },

    /**
     * Choose an ortho height that fits the whole clip with a margin, so no
     * pose is ever clipped by the viewport and the crop can do its job.
     */
    fit(ag, frames, opts) {
        const w = Rig.engine.getRenderWidth();
        const h = Rig.engine.getRenderHeight();
        const aspect = w / h;
        const cx = w / 2, cy = h / 2;

        // Two passes: start deliberately wide so nothing is off-frame during
        // the measurement, then tighten onto what was actually measured.
        Rig.setOrthoHeight(Math.max(Rig.orthoHeight, 10));

        for (let pass = 0; pass < 2; pass++) {
            this._goToFrame(ag, frames[0]);
            const anchor0 = this._anchorWorld();

            let dxMax = 1, dyMax = 1;
            for (const f of frames) {
                this._goToFrame(ag, f);
                this._aimAt(this._anchorWorld(), anchor0, opts.lockVertical);
                const b = this._alphaBounds();
                if (!b) continue;
                dxMax = Math.max(dxMax, Math.abs(b.minX - cx), Math.abs(b.maxX - cx));
                dyMax = Math.max(dyMax, Math.abs(b.minY - cy), Math.abs(b.maxY - cy));
            }

            const ppu = Rig.pixelsPerUnit();
            const needV = (2 * dyMax / ppu) / this.FIT_FILL;
            const needH = (2 * dxMax / ppu) / (aspect * this.FIT_FILL);
            Rig.setOrthoHeight(Math.max(needV, needH));
        }
        return Rig.orthoHeight;
    },

    /**
     * Babylon finalises a new shader effect on a timer, and skips drawing any
     * mesh whose effect is not ready yet. A synchronous capture loop therefore
     * renders empty frames without raising anything. Both passes have to be
     * compiled, and the event loop given a turn, before capture starts.
     */
    async prepare(flatMaterial) {
        for (const mode of ['bones', 'beauty']) {
            Loader.setPass(mode, flatMaterial);
            Rig.render();
            await Rig.scene.whenReadyAsync();
            for (const mesh of Loader.model.geoMeshes) {
                if (mesh.material) await mesh.material.forceCompilationAsync(mesh);
            }
            Rig.render();
        }
    },

    _yield() {
        return new Promise(r => setTimeout(r, 0));
    },

    /**
     * Render every sampled frame in both passes and pack the results.
     * @returns {{beauty: HTMLCanvasElement, bones: HTMLCanvasElement, meta: object}}
     */
    async run(opts, context, onProgress) {
        const model = Loader.model;
        const ag = model.animations.current;
        if (!ag) throw new Error('No clip loaded - nothing to capture');

        const frames = this.sampleFrames(context.clip, opts);

        ag.start(false);
        ag.pause();

        await this.prepare(context.flatMaterial);

        if (opts.autoFit) this.fit(ag, frames, opts);

        const w = Rig.engine.getRenderWidth();
        const h = Rig.engine.getRenderHeight();

        // ---- Measure pass: how far does the clip actually travel? ----------
        this._goToFrame(ag, frames[0]);
        const anchor0 = this._anchorWorld();
        Rig.lookAt(anchor0);
        Rig.render();

        const travel = [];
        const screen0 = Rig.projectToPixels(anchor0);
        for (const f of frames) {
            this._goToFrame(ag, f);
            const a = this._anchorWorld();
            // Camera deliberately left where it was, so this measures the
            // motion the lock is about to remove.
            const s = Rig.projectToPixels(a);
            travel.push({
                px: { x: s.x - screen0.x, y: s.y - screen0.y },
                world: { x: a.x - anchor0.x, y: a.y - anchor0.y, z: a.z - anchor0.z },
            });
        }

        // ---- Capture pass: locked camera, both material passes ------------
        Loader.setPass('beauty', context.flatMaterial);

        const shots = [];
        let union = null;

        for (let i = 0; i < frames.length; i++) {
            if (onProgress) onProgress(i, frames.length);
            await this._yield();

            this._goToFrame(ag, frames[i]);
            const anchor = this._anchorWorld();
            this._aimAt(anchor, anchor0, opts.lockVertical);

            const anchorPx = Rig.projectToPixels(anchor);

            Loader.setPass('beauty', context.flatMaterial);
            Rig.render();
            const beauty = this._grab(w, h);
            const bounds = this._alphaBounds();

            Loader.setPass('bones', context.flatMaterial);
            Rig.render();
            const bones = this._grab(w, h);

            if (!bounds) {
                throw new Error(
                    `Frame ${i} (source frame ${frames[i].toFixed(1)}) rendered completely empty. ` +
                    `The figure is outside the viewport or the model failed to render.`
                );
            }
            union = union
                ? {
                    minX: Math.min(union.minX, bounds.minX),
                    minY: Math.min(union.minY, bounds.minY),
                    maxX: Math.max(union.maxX, bounds.maxX),
                    maxY: Math.max(union.maxY, bounds.maxY),
                }
                : bounds;

            shots.push({ beauty, bones, anchorPx, bounds, srcFrame: frames[i] });
        }

        Loader.setPass('beauty', context.flatMaterial);

        // ---- Crop rectangle, shared by every cell --------------------------
        const pad = opts.padding;
        const cropX = Math.max(0, union.minX - pad);
        const cropY = Math.max(0, union.minY - pad);
        const cropW = Math.min(w, union.maxX + 1 + pad) - cropX;
        const cropH = Math.min(h, union.maxY + 1 + pad) - cropY;

        const cols = Math.max(1, Math.min(opts.columns, shots.length));
        const rows = Math.ceil(shots.length / cols);

        const beautySheet = this._pack(shots, 'beauty', cropX, cropY, cropW, cropH, cols, rows);
        const bonesSheet = this._pack(shots, 'bones', cropX, cropY, cropW, cropH, cols, rows);

        // ---- Metadata ------------------------------------------------------
        const ppu = Rig.pixelsPerUnit();
        const meta = {
            generator: 'three_d_sprite_sheet',
            created: new Date().toISOString(),
            character: context.characterName,
            characterFile: context.characterFile,
            clip: context.clipName,
            clipFile: context.clipFile,
            source: {
                fps: context.clip.fps,
                fromFrame: context.clip.from,
                toFrame: context.clip.to,
                rangeStart: opts.rangeStart,
                rangeEnd: opts.rangeEnd,
                loops: opts.loops,
            },
            camera: {
                projection: 'orthographic',
                yawDeg: opts.yaw,
                pitchDeg: opts.pitch,
                orthoHeightUnits: Rig.orthoHeight,
                pixelsPerUnit: ppu,
                renderWidth: w,
                renderHeight: h,
            },
            anchor: {
                bone: model.anchorNode.boneName,
                lockedAxes: opts.lockVertical ? ['x', 'y', 'z'] : ['x', 'z'],
            },
            cell: { width: cropW, height: cropH, padding: pad },
            sheet: {
                width: cropW * cols,
                height: cropH * rows,
                cols,
                rows,
                frameCount: shots.length,
            },
            playback: 'Draw cell i so its anchor lands at the desired screen point: ' +
                'destX = targetX - frames[i].anchor.x + frames[i].rootOffsetPx.x, ' +
                'destY = targetY - frames[i].anchor.y + frames[i].rootOffsetPx.y. ' +
                'Omit rootOffsetPx to keep the figure locked in place.',
            frames: shots.map((s, i) => ({
                index: i,
                sourceFrame: +s.srcFrame.toFixed(3),
                timeSeconds: +((s.srcFrame - context.clip.from) / context.clip.fps).toFixed(4),
                cell: { x: (i % cols) * cropW, y: Math.floor(i / cols) * cropH },
                anchor: {
                    x: +(s.anchorPx.x - cropX).toFixed(2),
                    y: +(s.anchorPx.y - cropY).toFixed(2),
                },
                contentBox: {
                    x: s.bounds.minX - cropX,
                    y: s.bounds.minY - cropY,
                    width: s.bounds.maxX - s.bounds.minX + 1,
                    height: s.bounds.maxY - s.bounds.minY + 1,
                },
                rootOffsetPx: {
                    x: +travel[i].px.x.toFixed(2),
                    y: +travel[i].px.y.toFixed(2),
                },
                rootOffsetWorld: {
                    x: +travel[i].world.x.toFixed(5),
                    y: +travel[i].world.y.toFixed(5),
                    z: +travel[i].world.z.toFixed(5),
                },
            })),
        };

        return { beauty: beautySheet, bones: bonesSheet, meta };
    },

    _grab(w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(Rig.canvas, 0, 0);
        return c;
    },

    _pack(shots, key, cropX, cropY, cropW, cropH, cols, rows) {
        const sheet = document.createElement('canvas');
        sheet.width = cropW * cols;
        sheet.height = cropH * rows;
        const ctx = sheet.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        shots.forEach((s, i) => {
            const dx = (i % cols) * cropW;
            const dy = Math.floor(i / cols) * cropH;
            ctx.drawImage(s[key], cropX, cropY, cropW, cropH, dx, dy, cropW, cropH);
        });
        return sheet;
    },
};
