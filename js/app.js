/**
 * App - UI wiring for the sprite sheet builder.
 */
const App = {
    flatMaterial: null,
    clipInfo: null,          // { group, fps, from, to, retargeted, missed }
    previewAnchor0: null,
    result: null,
    busy: false,

    el(id) { return document.getElementById(id); },

    status(msg, isError) {
        const s = this.el('status');
        s.textContent = msg;
        s.classList.toggle('error', !!isError);
        if (isError) console.error(msg);
    },

    async init() {
        this._populate();
        this._buildLegend();

        const canvas = this.el('render');
        await Rig.init(canvas);
        Loader.init(Rig.scene);
        this.flatMaterial = BoneColor.createFlatMaterial(Rig.scene);

        this._bind();
        this._applyCamera();
        Rig.setResolution(512, 512);

        Rig.engine.runRenderLoop(() => {
            if (this.busy) return;
            if (Loader.model && this.previewAnchor0) {
                const anchor = Loader.model.anchorNode.node.getAbsolutePosition();
                const lockY = this.el('lockVertical').checked;
                Rig.lookAt(lockY
                    ? anchor
                    : new BABYLON.Vector3(anchor.x, this.previewAnchor0.y, anchor.z));
            }
            Rig.scene.render();
        });

        await this.reloadCharacter();
    },

    _populate() {
        const cs = this.el('character');
        CHARACTERS.forEach((c, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = c.name;
            cs.appendChild(o);
        });

        const cl = this.el('clip');
        CLIPS.forEach((c, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = c.name;
            cl.appendChild(o);
        });
        cl.value = '4';   // Punching - a clip with obvious limb action
    },

    _buildLegend() {
        const box = this.el('legend');
        for (const item of BoneColor.legend()) {
            const d = document.createElement('div');
            const i = document.createElement('i');
            i.style.background = item.css;
            d.appendChild(i);
            d.appendChild(document.createTextNode(item.label));
            box.appendChild(d);
        }
    },

    _bind() {
        const live = (id, out, fmt) => {
            const input = this.el(id);
            const output = out ? this.el(out) : null;
            const sync = () => {
                if (output) output.textContent = fmt ? fmt(input.value) : input.value;
            };
            input.addEventListener('input', () => { sync(); this._applyCamera(); });
            sync();
        };

        live('yaw', 'yawOut');
        live('pitch', 'pitchOut');
        live('ortho', 'orthoOut', v => (+v).toFixed(1));
        live('frames', 'framesOut');

        this.el('flatLight').addEventListener('change', e => Rig.setFlatLighting(e.target.checked));
        Rig.setFlatLighting(true);

        this.el('resolution').addEventListener('change', e => {
            const n = +e.target.value;
            Rig.setResolution(n, n);
        });

        this.el('character').addEventListener('change', () => this.reloadCharacter());
        this.el('skipHands').addEventListener('change', () => this.reloadClip());
        this.el('clip').addEventListener('change', () => this.reloadClip());

        this.el('capture').addEventListener('click', () => this.doCapture());
        this._bindPlayback();
        this.el('dlBeauty').addEventListener('click', () => this._download('beauty'));
        this.el('dlBones').addEventListener('click', () => this._download('bones'));
        this.el('dlJson').addEventListener('click', () => this._download('json'));
    },

    _bindPlayback() {
        Preview.mount(this.el('playbackCanvas'), (i, n, frame) => {
            this.el('scrub').value = String(i);
            this.el('frameLabel').textContent =
                `${String(i + 1).padStart(2, ' ')}/${n}  src ${frame.sourceFrame}  ` +
                `${frame.timeSeconds.toFixed(2)}s`;
        });

        const setPass = (pass) => {
            Preview.setPass(pass);
            this.el('passBeauty').classList.toggle('on', pass === 'beauty');
            this.el('passBones').classList.toggle('on', pass === 'bones');
        };
        this.el('passBeauty').addEventListener('click', () => setPass('beauty'));
        this.el('passBones').addEventListener('click', () => setPass('bones'));

        const playBtn = this.el('playPause');
        playBtn.addEventListener('click', () => {
            Preview.setPlaying(!Preview.playing);
            playBtn.textContent = Preview.playing ? 'Pause' : 'Play';
        });

        // Stepping implies stopping - otherwise the next tick moves it straight on.
        const step = (d) => {
            Preview.setPlaying(false);
            playBtn.textContent = 'Play';
            Preview.seek(Preview.index + d);
        };
        this.el('stepBack').addEventListener('click', () => step(-1));
        this.el('stepFwd').addEventListener('click', () => step(1));

        this.el('scrub').addEventListener('input', e => {
            Preview.setPlaying(false);
            playBtn.textContent = 'Play';
            Preview.seek(+e.target.value);
        });

        this.el('speed').addEventListener('input', e => {
            const v = +e.target.value;
            Preview.setSpeed(v);
            this.el('speedOut').textContent = v.toFixed(1);
        });

        this.el('reconstruct').addEventListener('change',
            e => Preview.setReconstruct(e.target.checked));
        this.el('showPath').addEventListener('change',
            e => Preview.setShowPath(e.target.checked));
    },

    _showPlayback(result) {
        this.el('playback').classList.remove('hidden');
        this.el('scrub').max = String(result.meta.frames.length - 1);
        this.el('playPause').textContent = 'Pause';

        Preview.setResult(result);

        const travel = result.meta.frames.reduce((max, f) => Math.max(
            max, Math.hypot(f.rootOffsetPx.x, f.rootOffsetPx.y)), 0);
        this.el('playbackNote').textContent =
            `${result.meta.frames.length} frames, ${Preview.duration().toFixed(2)}s loop. ` +
            (travel < 1
                ? 'This clip barely travels, so replaying the offsets looks the same as locked.'
                : `Peak travel ${travel.toFixed(0)}px from the start pose - untick to see it locked.`);
    },

    _applyCamera() {
        Rig.setAngles(+this.el('yaw').value, +this.el('pitch').value);
        Rig.setOrthoHeight(+this.el('ortho').value);
    },

    _skipBonesPattern() {
        return this.el('skipHands').checked ? /^(Left|Right)Hand./i : null;
    },

    async reloadCharacter() {
        const c = CHARACTERS[+this.el('character').value];
        this.busy = true;
        this.status(`Loading ${c.name}...`);
        try {
            const model = await Loader.loadCharacter(MODEL_DIR + c.file);
            const baked = BoneColor.bake(model.geoMeshes, model.skeleton);
            let msg = `${c.name}: ${baked.meshCount} mesh(es), ` +
                      `${baked.vertexCount} vertices coloured, ` +
                      `anchor bone "${model.anchorNode.boneName}".`;
            if (baked.unmatched.length) {
                msg += `\nBones with no region rule (grey): ${baked.unmatched.join(', ')}`;
            }
            this.status(msg);
            this.busy = false;
            await this.reloadClip();
        } catch (e) {
            this.busy = false;
            this.status(`Failed to load ${c.name}\n${e.message}`, true);
        }
    },

    async reloadClip() {
        if (!Loader.model) return;
        const c = CLIPS[+this.el('clip').value];
        this.busy = true;
        this.status(`Loading clip ${c.name}...`);
        try {
            this.clipInfo = await Loader.loadClip(MODEL_DIR + c.file, this._skipBonesPattern());
            const ag = this.clipInfo.group;

            ag.start(false);
            ag.goToFrame(ag.from);
            Rig.scene.render();
            this.previewAnchor0 = Loader.model.anchorNode.node.getAbsolutePosition().clone();

            ag.stop();
            ag.start(true);

            const dur = (this.clipInfo.to - this.clipInfo.from) / this.clipInfo.fps;
            let msg = `${c.name}: frames ${this.clipInfo.from.toFixed(0)}-${this.clipInfo.to.toFixed(0)} ` +
                      `at ${this.clipInfo.fps}fps (${dur.toFixed(2)}s), ` +
                      `${this.clipInfo.retargeted} bones retargeted.`;
            if (this.clipInfo.missed.length) {
                msg += `\nUnmatched source bones: ${this.clipInfo.missed.length}`;
            }
            this.status(msg);
        } catch (e) {
            this.status(`Failed to load clip ${c.name}\n${e.message}`, true);
        }
        this.busy = false;
    },

    _options() {
        return {
            yaw: +this.el('yaw').value,
            pitch: +this.el('pitch').value,
            frameCount: +this.el('frames').value,
            rangeStart: +this.el('rangeStart').value,
            rangeEnd: +this.el('rangeEnd').value,
            loops: this.el('loops').checked,
            columns: +this.el('columns').value,
            padding: +this.el('padding').value,
            lockVertical: this.el('lockVertical').checked,
            autoFit: this.el('autoFit').checked,
        };
    },

    async doCapture() {
        if (!this.clipInfo) {
            this.status('No clip loaded.', true);
            return;
        }
        const opts = this._options();
        if (opts.rangeEnd <= opts.rangeStart) {
            this.status('Range end must be greater than range start.', true);
            return;
        }

        const character = CHARACTERS[+this.el('character').value];
        const clipDef = CLIPS[+this.el('clip').value];

        this.busy = true;
        this.el('capture').disabled = true;
        this.status(`Capturing ${opts.frameCount} frames...`);

        try {
            const ag = this.clipInfo.group;
            ag.stop();

            const result = await Capture.run(opts, {
                clip: this.clipInfo,
                flatMaterial: this.flatMaterial,
                characterName: character.name,
                characterFile: character.file,
                clipName: clipDef.name,
                clipFile: clipDef.file,
            }, (i, n) => this.status(`Capturing frame ${i + 1} of ${n}...`));

            this.result = result;
            this._showSheets(result);
            this._showPlayback(result);

            // Reflect any auto-fit adjustment back into the slider.
            this.el('ortho').value = Rig.orthoHeight.toFixed(1);
            this.el('orthoOut').textContent = Rig.orthoHeight.toFixed(1);

            this.el('downloads').classList.remove('hidden');
            const m = result.meta;
            this.status(
                `Done. ${m.sheet.frameCount} frames, cell ${m.cell.width}x${m.cell.height}, ` +
                `sheet ${m.sheet.width}x${m.sheet.height} (${m.sheet.cols}x${m.sheet.rows}), ` +
                `${m.camera.pixelsPerUnit.toFixed(1)} px/unit.`
            );

            ag.start(true);
        } catch (e) {
            this.status(`Capture failed\n${e.message}`, true);
            console.error(e);
        }
        this.busy = false;
        this.el('capture').disabled = false;
    },

    _showSheets(result) {
        for (const key of ['beauty', 'bones']) {
            const dst = this.el(key === 'beauty' ? 'outBeauty' : 'outBones');
            dst.width = result[key].width;
            dst.height = result[key].height;
            const ctx = dst.getContext('2d');
            ctx.clearRect(0, 0, dst.width, dst.height);
            ctx.drawImage(result[key], 0, 0);
        }
    },

    _baseName() {
        const c = CHARACTERS[+this.el('character').value];
        const k = CLIPS[+this.el('clip').value];
        return `${c.id}_${k.id}_${this.result.meta.sheet.cols}x${this.result.meta.sheet.rows}`;
    },

    _download(what) {
        if (!this.result) return;
        const base = this._baseName();

        if (what === 'json') {
            const blob = new Blob([JSON.stringify(this.result.meta, null, 2)],
                { type: 'application/json' });
            this._save(blob, `${base}.json`);
            return;
        }
        const suffix = what === 'bones' ? '_bonemap' : '';
        this.result[what].toBlob(blob => this._save(blob, `${base}${suffix}.png`), 'image/png');
    },

    _save(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
};

window.addEventListener('DOMContentLoaded', () => {
    App.init().catch(e => {
        App.status(`Startup failed\n${e.message}`, true);
        console.error(e);
    });
});
