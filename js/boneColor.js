/**
 * BoneColor - bakes a flat "which limb is this" colour into each vertex.
 *
 * Every vertex of a skinned mesh already carries matricesIndices /
 * matricesWeights. We pick the bone with the highest weight and write that
 * bone's region colour into the ColorKind vertex buffer. The regular Babylon
 * skinning path then carries those colours through animation for free, so the
 * segmentation pass lines up with the beauty pass exactly, frame for frame.
 *
 * Bone names are Mixamo standard, optionally prefixed with "mixamorig:".
 * "Left"/"Right" are the character's own left and right.
 */
const BoneColor = {

    // Ordered rules - first match wins. Tested against the bone name with any
    // mixamorig prefix stripped.
    REGIONS: [
        { re: /^(Head|HeadTop|Neck)/i,        color: [0.98, 0.92, 0.62], label: 'head' },
        { re: /^(Hips|Spine)/i,               color: [0.55, 0.42, 0.78], label: 'torso' },

        // Character's LEFT arm - warm ramp, hand is the hot highlight
        { re: /^LeftHand/i,                   color: [1.00, 0.13, 0.13], label: 'hand.L' },
        { re: /^LeftForeArm/i,                color: [1.00, 0.60, 0.15], label: 'forearm.L' },
        { re: /^LeftArm/i,                    color: [0.85, 0.38, 0.05], label: 'upperarm.L' },
        { re: /^LeftShoulder/i,               color: [0.55, 0.25, 0.05], label: 'shoulder.L' },

        // Character's RIGHT arm - cool ramp, hand is the hot highlight
        { re: /^RightHand/i,                  color: [0.10, 0.45, 1.00], label: 'hand.R' },
        { re: /^RightForeArm/i,               color: [0.25, 0.82, 0.92], label: 'forearm.R' },
        { re: /^RightArm/i,                   color: [0.10, 0.55, 0.62], label: 'upperarm.R' },
        { re: /^RightShoulder/i,              color: [0.05, 0.32, 0.38], label: 'shoulder.R' },

        // Character's LEFT leg - green ramp, foot is the highlight
        { re: /^Left(ToeBase|Toe_End|Foot)/i, color: [0.55, 1.00, 0.20], label: 'foot.L' },
        { re: /^LeftLeg/i,                    color: [0.20, 0.72, 0.28], label: 'shin.L' },
        { re: /^LeftUpLeg/i,                  color: [0.10, 0.42, 0.18], label: 'thigh.L' },

        // Character's RIGHT leg - magenta ramp, foot is the highlight
        { re: /^Right(ToeBase|Toe_End|Foot)/i,color: [1.00, 0.45, 0.85], label: 'foot.R' },
        { re: /^RightLeg/i,                   color: [0.82, 0.15, 0.62], label: 'shin.R' },
        { re: /^RightUpLeg/i,                 color: [0.45, 0.06, 0.34], label: 'thigh.R' },

        // ---- Unreal mannequin naming -----------------------------------
        // Same colours, different rig convention: pelvis/spine_01/clavicle_l/
        // upperarm_l/lowerarm_l/hand_l/thigh_l/calf_l/foot_l, with a trailing
        // index on every bone. "_l" is the character's own left, as with
        // Mixamo's "Left", so the two conventions agree on which side is which.
        { re: /^(head|neck|face|eyebrows|eyes|jaw)(_|$)/i,  color: [0.98, 0.92, 0.62], label: 'head' },
        { re: /^_?(root|pelvis|spine)(_|$|Joint)/i,         color: [0.55, 0.42, 0.78], label: 'torso' },

        { re: /^(hand|thumb|index|middle|ring|pinky)(_\d+)*_l(_|$)/i, color: [1.00, 0.13, 0.13], label: 'hand.L' },
        { re: /^lowerarm_l(_|$)/i,                          color: [1.00, 0.60, 0.15], label: 'forearm.L' },
        { re: /^upperarm_l(_|$)/i,                          color: [0.85, 0.38, 0.05], label: 'upperarm.L' },
        { re: /^clavicle_l(_|$)/i,                          color: [0.55, 0.25, 0.05], label: 'shoulder.L' },

        { re: /^(hand|thumb|index|middle|ring|pinky)(_\d+)*_r(_|$)/i, color: [0.10, 0.45, 1.00], label: 'hand.R' },
        { re: /^lowerarm_r(_|$)/i,                          color: [0.25, 0.82, 0.92], label: 'forearm.R' },
        { re: /^upperarm_r(_|$)/i,                          color: [0.10, 0.55, 0.62], label: 'upperarm.R' },
        { re: /^clavicle_r(_|$)/i,                          color: [0.05, 0.32, 0.38], label: 'shoulder.R' },

        { re: /^(foot|ball|toes)_l(_|$)/i,                  color: [0.55, 1.00, 0.20], label: 'foot.L' },
        { re: /^calf_l(_|$)/i,                              color: [0.20, 0.72, 0.28], label: 'shin.L' },
        { re: /^thigh_l(_|$)/i,                             color: [0.10, 0.42, 0.18], label: 'thigh.L' },

        { re: /^(foot|ball|toes)_r(_|$)/i,                  color: [1.00, 0.45, 0.85], label: 'foot.R' },
        { re: /^calf_r(_|$)/i,                              color: [0.82, 0.15, 0.62], label: 'shin.R' },
        { re: /^thigh_r(_|$)/i,                             color: [0.45, 0.06, 0.34], label: 'thigh.R' },
    ],

    UNMATCHED: [0.5, 0.5, 0.5],

    /** sRGB (the values written in REGIONS) to linear. */
    _toLinear(c) {
        return Math.pow(c, 2.2);
    },

    stripPrefix(name) {
        return name.replace(/^mixamorig[_:]?/i, '');
    },

    colorForBone(boneName) {
        const bare = this.stripPrefix(boneName);
        for (const r of this.REGIONS) {
            if (r.re.test(bare)) return r.color;
        }
        return this.UNMATCHED;
    },

    /**
     * Build the per-bone colour lookup for a skeleton, indexed the same way
     * matricesIndices is (i.e. by position in skeleton.bones).
     * @returns {{colors: Array<Array<number>>, unmatched: string[]}}
     */
    buildPalette(skeleton) {
        const colors = [];
        const unmatched = [];
        for (const bone of skeleton.bones) {
            const bare = this.stripPrefix(bone.name);
            let hit = null;
            for (const r of this.REGIONS) {
                if (r.re.test(bare)) { hit = r; break; }
            }
            if (hit) {
                colors.push(hit.color);
            } else {
                colors.push(this.UNMATCHED);
                unmatched.push(bone.name);
            }
        }
        return { colors, unmatched };
    },

    /**
     * Write dominant-bone colours into the ColorKind buffer of every skinned
     * mesh in the list. Meshes keep useVertexColors = false so the beauty pass
     * is unaffected; the capture code flips it on for the segmentation pass.
     * @param {BABYLON.AbstractMesh[]} meshes
     * @param {BABYLON.Skeleton} skeleton
     * @returns {{meshCount:number, vertexCount:number, unmatched:string[]}}
     */
    bake(meshes, skeleton) {
        if (!skeleton) {
            throw new Error('BoneColor.bake: model has no skeleton, cannot derive limb regions');
        }
        const { colors, unmatched } = this.buildPalette(skeleton);

        let meshCount = 0;
        let vertexCount = 0;

        for (const mesh of meshes) {
            const total = mesh.getTotalVertices();
            if (!total) continue;

            const idx = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesIndicesKind);
            const wgt = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesWeightsKind);
            if (!idx || !wgt) {
                throw new Error(
                    `BoneColor.bake: mesh "${mesh.name}" has ${total} vertices but no skinning ` +
                    `data (matricesIndices=${!!idx}, matricesWeights=${!!wgt})`
                );
            }
            const idxE = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesIndicesExtraKind);
            const wgtE = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesWeightsExtraKind);

            const out = new Float32Array(total * 4);

            for (let v = 0; v < total; v++) {
                let bestW = -1;
                let bestB = 0;

                for (let k = 0; k < 4; k++) {
                    const w = wgt[v * 4 + k];
                    if (w > bestW) { bestW = w; bestB = idx[v * 4 + k]; }
                }
                if (idxE && wgtE) {
                    for (let k = 0; k < 4; k++) {
                        const w = wgtE[v * 4 + k];
                        if (w > bestW) { bestW = w; bestB = idxE[v * 4 + k]; }
                    }
                }

                const c = colors[bestB] || this.UNMATCHED;
                // Written in linear space: the PBR pipeline converts back to
                // sRGB on output, so the sheet ends up with the exact palette
                // values the legend shows.
                out[v * 4 + 0] = this._toLinear(c[0]);
                out[v * 4 + 1] = this._toLinear(c[1]);
                out[v * 4 + 2] = this._toLinear(c[2]);
                out[v * 4 + 3] = 1.0;
            }

            mesh.setVerticesData(BABYLON.VertexBuffer.ColorKind, out, false, 4);
            mesh.useVertexColors = false;   // off until the segmentation pass asks for it
            meshCount++;
            vertexCount += total;
        }

        if (meshCount === 0) {
            throw new Error('BoneColor.bake: no meshes with geometry were found on this model');
        }
        return { meshCount, vertexCount, unmatched };
    },

    /**
     * Flat unlit material that shows the baked vertex colours.
     *
     * PBRMaterial.unlit, not StandardMaterial.disableLighting: Babylon 8's
     * default shader no longer has a DISABLELIGHTING branch, so that property
     * silently produces black. The unlit PBR path multiplies surfaceAlbedo by
     * the vertex colour and skips all lighting.
     */
    createFlatMaterial(scene) {
        const m = new BABYLON.PBRMaterial('boneColorFlat', scene);
        m.unlit = true;
        m.albedoColor = new BABYLON.Color3(1, 1, 1);
        m.backFaceCulling = false;
        m.transparencyMode = BABYLON.Material.MATERIAL_OPAQUE;
        return m;
    },

    /**
     * Legend entries for the UI. Several rig conventions share the same
     * regions, so collapse to one swatch per label.
     */
    legend() {
        const seen = new Set();
        const out = [];
        for (const r of this.REGIONS) {
            if (seen.has(r.label)) continue;
            seen.add(r.label);
            out.push({
                label: r.label,
                css: `rgb(${r.color.map(c => Math.round(c * 255)).join(',')})`
            });
        }
        return out;
    }
};
