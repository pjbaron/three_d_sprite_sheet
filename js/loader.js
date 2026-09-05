/**
 * Loader - GLB character loading and Mixamo clip retargeting.
 *
 * Lifted from the game's Babylon3DRenderer, with the game-specific parts
 * removed and two changes that matter for frame capture:
 *   - animation blending is OFF, so goToFrame() lands on the exact pose
 *     instead of easing towards it
 *   - the model sits at the origin at scale 1; framing is the camera's job
 */
const Loader = {
    scene: null,
    model: null,              // { root, meshes, skeleton, anchorNode }
    _animSourceCache: {},

    init(scene) {
        this.scene = scene;
        return this;
    },

    /**
     * Babylon's glTF loader starts animatables directly on bone and node
     * objects, outside any AnimationGroup. Left running they fight our
     * retargeted groups and corrupt the pose.
     */
    _stopLeakedAnimatables(skeleton, meshes) {
        const visited = new Set();
        const stop = (node) => {
            if (!node || visited.has(node)) return;
            visited.add(node);
            this.scene.stopAnimation(node);
            node.animations = [];
            for (const child of node.getChildren()) stop(child);
        };
        for (const mesh of meshes || []) stop(mesh);
        for (const bone of skeleton ? skeleton.bones : []) {
            stop(bone.getTransformNode());
            stop(bone);
        }
    },

    disposeModel() {
        if (!this.model) return;
        for (const name in this.model.animations) {
            const ag = this.model.animations[name];
            ag.stop();
            ag.dispose();
        }
        for (const m of this.model.meshes) m.dispose();
        if (this.model.skeleton) this.model.skeleton.dispose();
        this.model.root.dispose();
        this.model = null;
    },

    async loadCharacter(url) {
        this.disposeModel();

        const lastSlash = url.lastIndexOf('/');
        const rootUrl = url.substring(0, lastSlash + 1);
        const fileName = url.substring(lastSlash + 1);

        const result = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene);

        const root = new BABYLON.TransformNode('modelRoot', this.scene);
        for (const mesh of result.meshes) {
            if (!mesh.parent) mesh.parent = root;
        }

        for (const mesh of result.meshes) {
            if (!mesh.material) continue;
            mesh.material.backFaceCulling = false;
            // FBX->GLB conversion often marks these ALPHA_BLEND with an empty
            // alpha channel, which renders the whole character invisible.
            mesh.material.transparencyMode = BABYLON.Material.MATERIAL_OPAQUE;
            if (mesh.material.albedoTexture && mesh.material.albedoTexture.hasAlpha) {
                mesh.material.albedoTexture.hasAlpha = false;
            }
        }

        const skeleton = (result.skeletons && result.skeletons[0]) || null;
        if (!skeleton) {
            throw new Error(`Model "${fileName}" has no skeleton - cannot animate or colour by bone`);
        }

        for (const ag of result.animationGroups) { ag.stop(); ag.dispose(); }
        this._stopLeakedAnimatables(skeleton, result.meshes);

        const geoMeshes = result.meshes.filter(m => m.getTotalVertices() > 0);

        this.model = {
            root,
            meshes: result.meshes,
            geoMeshes,
            skeleton,
            animations: {},
            anchorNode: this._findAnchorNode(skeleton),
            originalMaterials: geoMeshes.map(m => m.material),
        };
        return this.model;
    },

    /**
     * The hips bone is the conventional centre of mass for a humanoid rig and
     * is what we lock to fix the figure in frame.
     */
    ANCHOR_PATTERNS: [
        /^Hips$/i,              // Mixamo
        /^pelvis(_|$)/i,        // Unreal mannequin
        /^(Bip\d*_)?Pelvis$/i,  // 3ds Max biped
    ],

    _findAnchorNode(skeleton) {
        let fallback = null;
        const candidates = [];
        for (const bone of skeleton.bones) {
            const tn = bone.getTransformNode();
            if (!tn) continue;
            candidates.push({ node: tn, boneName: bone.name,
                              bare: BoneColor.stripPrefix(bone.name) });
            if (!fallback) fallback = { node: tn, boneName: bone.name };
        }
        // Patterns are tried in order, so a rig carrying both names still
        // resolves to the preferred one rather than whichever comes first.
        for (const re of this.ANCHOR_PATTERNS) {
            const hit = candidates.find(c => re.test(c.bare));
            if (hit) return { node: hit.node, boneName: hit.boneName };
        }
        if (!fallback) {
            throw new Error('No bone transform nodes found - cannot pick a centre-of-mass anchor');
        }
        console.warn(`No "Hips" bone found; anchoring on "${fallback.boneName}" instead`);
        return fallback;
    },

    /**
     * Load an animation GLB and retarget it onto the current model by bone name.
     * @param {string} url
     * @param {RegExp|null} skipBones - bones (prefix-stripped) to leave unanimated
     */
    async loadClip(url, skipBones) {
        const model = this.model;
        if (!model) throw new Error('loadClip called before a character was loaded');

        if (model.animations.current) {
            model.animations.current.stop();
            model.animations.current.dispose();
            model.animations.current = null;
        }

        let sourceAnims = this._animSourceCache[url];

        if (!sourceAnims) {
            const lastSlash = url.lastIndexOf('/');
            const rootUrl = url.substring(0, lastSlash + 1);
            const fileName = url.substring(lastSlash + 1);

            const result = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene);
            for (const m of result.meshes) m.isVisible = false;

            const sourceAGs = result.animationGroups || [];
            if (sourceAGs.length === 0) {
                for (const m of result.meshes) m.dispose();
                throw new Error(`Animation GLB "${fileName}" contains no animation groups`);
            }

            const sourceAG = sourceAGs[sourceAGs.length - 1];
            sourceAnims = sourceAG.targetedAnimations.map(ta => ({
                name: (ta.target && ta.target.name) || '',
                animation: ta.animation,
            }));
            this._animSourceCache[url] = sourceAnims;

            for (const ag of sourceAGs) { ag.stop(); ag.dispose(); }
            for (const m of result.meshes) m.dispose();
            if (result.skeletons && result.skeletons[0]) result.skeletons[0].dispose();
        }

        // Index the model's bone transform nodes by both raw and stripped name.
        const byName = new Map();
        const byStripped = new Map();
        for (const bone of model.skeleton.bones) {
            const tn = bone.getTransformNode();
            if (!tn) continue;
            byName.set(tn.name, tn);
            byName.set(bone.name, tn);
            const s1 = BoneColor.stripPrefix(bone.name);
            if (s1 !== bone.name) byStripped.set(s1, tn);
            const s2 = BoneColor.stripPrefix(tn.name);
            if (s2 !== tn.name) byStripped.set(s2, tn);
        }

        const ag = new BABYLON.AnimationGroup('clip', this.scene);
        let retargeted = 0;
        const missed = [];

        for (const src of sourceAnims) {
            const bare = BoneColor.stripPrefix(src.name);
            if (skipBones && skipBones.test(bare)) continue;

            const tn = byName.get(src.name) || byName.get(bare) || byStripped.get(bare);
            if (!tn) { missed.push(src.name); continue; }

            const cloned = src.animation.clone();
            // Blending would make goToFrame() approach the pose over time
            // instead of snapping to it - fatal for single-frame capture.
            cloned.enableBlending = false;
            ag.addTargetedAnimation(cloned, tn);
            retargeted++;
        }

        if (retargeted === 0) {
            ag.dispose();
            throw new Error(
                `No bones matched when retargeting "${url}". Source bone names look like: ` +
                sourceAnims.slice(0, 5).map(a => a.name).join(', ')
            );
        }

        ag.loopAnimation = true;
        model.animations.current = ag;

        const first = ag.targetedAnimations[0].animation;
        return {
            group: ag,
            retargeted,
            missed,
            fps: first.framePerSecond || 60,
            from: ag.from,
            to: ag.to,
        };
    },

    /** Swap between the textured beauty pass and the flat bone-colour pass. */
    setPass(mode, flatMaterial) {
        const model = this.model;
        if (!model) return;
        const bones = (mode === 'bones');
        model.geoMeshes.forEach((mesh, i) => {
            mesh.useVertexColors = bones;
            mesh.material = bones ? flatMaterial : model.originalMaterials[i];
        });
    },
};
