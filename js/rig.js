/**
 * Rig - Babylon scene set up for repeatable sprite capture.
 *
 * Orthographic camera: no perspective drift between frames, so limb
 * proportions stay identical whatever the pose does in depth.
 * The camera orbits on fixed yaw/pitch and always looks straight at the
 * anchor point handed to it, which is how the centre of mass gets locked.
 */
const Rig = {
    engine: null,
    scene: null,
    camera: null,
    canvas: null,
    lights: {},
    envTexture: null,

    // World units covered by the full height of the viewport.
    orthoHeight: 4.0,

    // Fixed camera angles, in degrees.
    yaw: 0,
    pitch: 0,

    // Orthographic projection ignores distance; this only has to be far
    // enough back that nothing crosses the near plane.
    ORBIT_DISTANCE: 40,

    async init(canvas) {
        this.canvas = canvas;

        this.engine = new BABYLON.Engine(canvas, true, {
            preserveDrawingBuffer: true,
            alpha: true,
            premultipliedAlpha: false,
            stencil: false,
        });

        BABYLON.DracoCompression.Configuration.decoder = {
            wasmUrl: 'lib/draco_wasm_wrapper_gltf.js',
            wasmBinaryUrl: 'lib/draco_decoder_gltf.wasm',
            fallbackUrl: 'lib/draco_wasm_wrapper_gltf.js',
        };
        if (BABYLON.MeshoptCompression) {
            BABYLON.MeshoptCompression.Configuration.decoder = { url: 'lib/meshopt_decoder.js' };
        }

        this.scene = new BABYLON.Scene(this.engine);
        this.scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

        // A plain TargetCamera, positioned by hand. ArcRotateCamera is wrong
        // here: its setTarget() recomputes alpha/beta from the old position,
        // so moving the target to follow the hips would also change the
        // viewing angle - exactly what a fixed-angle capture must not do.
        this.camera = new BABYLON.TargetCamera(
            'capture', new BABYLON.Vector3(0, 1, this.ORBIT_DISTANCE), this.scene
        );
        this.camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
        this.camera.minZ = -200;
        this.camera.maxZ = 200;
        this.scene.activeCamera = this.camera;

        this._setupLighting();

        this.envTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
            'lib/environmentSpecular.env', this.scene
        );
        this.scene.environmentTexture = this.envTexture;
        this.scene.environmentIntensity = 1.0;

        this.applyOrtho();
        return this;
    },

    _setupLighting() {
        // Near-flat wrap light: keeps the read graphic rather than sculpted,
        // which is what a 2D artist or an image model wants to work from.
        this.lights.hemi = new BABYLON.HemisphericLight(
            'hemi', new BABYLON.Vector3(0.3, 1, -0.6), this.scene
        );
        this.lights.hemi.intensity = 0.95;
        this.lights.hemi.groundColor = new BABYLON.Color3(0.72, 0.74, 0.80);

        this.lights.key = new BABYLON.DirectionalLight(
            'key', new BABYLON.Vector3(-0.4, -0.7, 0.6), this.scene
        );
        this.lights.key.intensity = 0.5;
    },

    setFlatLighting(flat) {
        this.lights.key.intensity = flat ? 0.0 : 0.5;
        this.lights.hemi.intensity = flat ? 1.15 : 0.95;
        this.lights.hemi.groundColor = flat
            ? new BABYLON.Color3(1, 1, 1)
            : new BABYLON.Color3(0.72, 0.74, 0.80);
        this.scene.environmentIntensity = flat ? 0.35 : 1.0;
    },

    /** Set the render target size in pixels. */
    setResolution(w, h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.engine.setSize(w, h);
        this.applyOrtho();
    },

    /** Recompute the orthographic frustum from orthoHeight and the aspect. */
    applyOrtho() {
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        const halfH = this.orthoHeight / 2;
        const halfW = halfH * (w / h);
        this.camera.orthoTop = halfH;
        this.camera.orthoBottom = -halfH;
        this.camera.orthoLeft = -halfW;
        this.camera.orthoRight = halfW;
    },

    setOrthoHeight(units) {
        this.orthoHeight = units;
        this.applyOrtho();
    },

    /** Pixels per world unit at the current ortho height and resolution. */
    pixelsPerUnit() {
        return this.engine.getRenderHeight() / this.orthoHeight;
    },

    /**
     * yaw 0 puts the camera on +Z, which is the side these models face.
     * Positive yaw swings the camera towards +X; positive pitch raises it.
     */
    setAngles(yawDeg, pitchDeg) {
        this.yaw = yawDeg;
        this.pitch = pitchDeg;
        this.lookAt(this.camera.getTarget());
    },

    /**
     * Aim at a world position from the fixed yaw/pitch. Distance is constant
     * and irrelevant to an orthographic projection - it only has to keep the
     * subject inside minZ..maxZ.
     */
    lookAt(worldPos) {
        const yaw = BABYLON.Tools.ToRadians(this.yaw);
        const pitch = BABYLON.Tools.ToRadians(this.pitch);
        const d = this.ORBIT_DISTANCE;
        const flat = Math.cos(pitch) * d;
        this.camera.position.set(
            worldPos.x + Math.sin(yaw) * flat,
            worldPos.y + Math.sin(pitch) * d,
            worldPos.z + Math.cos(yaw) * flat
        );
        this.camera.setTarget(worldPos.clone());
    },

    /** Project a world point to canvas pixel coordinates with the current camera. */
    projectToPixels(worldPos) {
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        const p = BABYLON.Vector3.Project(
            worldPos,
            BABYLON.Matrix.Identity(),
            this.scene.getTransformMatrix(),
            new BABYLON.Viewport(0, 0, w, h)
        );
        return { x: p.x, y: p.y };
    },

    render() {
        this.scene.render();
    },
};
