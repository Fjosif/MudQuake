import { BatchedMesh, Float32BufferAttribute, Group, Matrix4, Mesh, Quaternion, Uint32BufferAttribute, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, Fn, mat3, normalLocal, positionLocal, uniformArray, vec4 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HouseBlueprint } from './house';
import { createMaterials, type MaterialKey } from './materials';
import { hash } from './random';

interface GlassEntry { readonly mesh: BatchedMesh; readonly index: number }
interface VisibilityEntry { readonly values: number[]; readonly index: number; readonly damageOnly: boolean; readonly detachAtDamage: number }
export class HouseVisuals {
  readonly root = new Group(); readonly drawBatches: number;
  private readonly visibility: VisibilityEntry[][];
  private readonly glass: (GlassEntry | null)[];
  private readonly batches: (Mesh | BatchedMesh)[] = [];
  private readonly nodeMaterials: MeshStandardNodeMaterial[] = [];
  private readonly transforms: Matrix4[];
  private readonly materials;
  private readonly matrix = new Matrix4(); private readonly scale = new Vector3(1, 1, 1);
  constructor(blueprint: HouseBlueprint, seed: number) {
    this.materials = createMaterials(seed); this.visibility = blueprint.components.map(() => []);
    this.glass = blueprint.components.map(() => null);
    this.transforms = blueprint.components.map(c => new Matrix4().compose(c.position, c.rotation, this.scale));
    const transforms = uniformArray<'mat4'>(this.transforms, 'mat4');
    for (const material of Object.keys(this.materials.materials) as MaterialKey[]) {
      const pieces = blueprint.components.flatMap(c => c.parts.filter(p => p.material === material).map(p => ({ c, p })));
      if (!pieces.length) continue;
      if (material === 'glass') {
        const vertices = pieces.reduce((sum, { p }) => sum + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count), 0);
        const batch = new BatchedMesh(pieces.length, vertices, 0, this.materials.materials.glass);
        batch.name = 'house-glass'; batch.sortObjects = true; batch.frustumCulled = false;
        for (const { c, p } of pieces) {
          const geometry = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
          const index = batch.addInstance(batch.addGeometry(geometry));
          batch.setMatrixAt(index, this.transforms[c.id]!); this.glass[c.id] = { mesh: batch, index };
          if (geometry !== p.geometry) geometry.dispose(); p.geometry.dispose();
        }
        this.root.add(batch); this.batches.push(batch); continue;
      }
      const visible = pieces.map(() => material === 'fracture' ? 0 : 1);
      const visibleNode = uniformArray<'float'>(visible, 'float');
      const source = this.materials.materials[material];
      const shader = new MeshStandardNodeMaterial({ color: source.color, map: source.map, normalMap: source.normalMap,
        roughnessMap: source.roughnessMap, roughness: source.roughness, metalness: source.metalness,
        normalScale: source.normalScale, side: source.side, vertexColors: true });
      // One draw per opaque material: all pieces share a vertex-buffer and a small transform palette.
      // This avoids WebGPU's per-geometry BatchedMesh draw emulation (hundreds of calls per pass).
      shader.positionNode = Fn(() => {
        const id = attribute('bodyId', 'uint');
        const transform = transforms.element(id);
        normalLocal.assign(mat3(transform).mul(normalLocal));
        return transform.mul(vec4(positionLocal, 1)).xyz.mul(visibleNode.element(attribute('partId', 'uint')));
      })();
      const geometries = [];
      for (const [partIndex, { c, p }] of pieces.entries()) {
        const geometry = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
        const count = geometry.getAttribute('position').count;
        geometry.setAttribute('bodyId', new Uint32BufferAttribute(new Uint32Array(count).fill(c.id), 1));
        geometry.setAttribute('partId', new Uint32BufferAttribute(new Uint32Array(count).fill(partIndex), 1));
        const shade = c.kind === 'wall' ? 1 : 0.96 + hash(seed, c.id) * 0.08;
        geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(count * 3).fill(shade), 3));
        geometries.push(geometry); this.visibility[c.id]!.push({ values: visible, index: partIndex, damageOnly: !!p.damageOnly, detachAtDamage: p.detachAtDamage ?? Infinity });
      }
      const merged = mergeGeometries(geometries, false)!;
      geometries.forEach(g => g.dispose()); pieces.forEach(({ p }) => p.geometry.dispose());
      const mesh = new Mesh(merged, shader); mesh.name = `house-${material}`;
      mesh.frustumCulled = false; mesh.castShadow = material !== 'fracture'; mesh.receiveShadow = true;
      this.nodeMaterials.push(shader); this.batches.push(mesh); this.root.add(mesh);
    }
    this.drawBatches = this.batches.length; this.root.name = 'mudquake-house';
  }
  setTransform(id: number, position: Vector3, rotation: Quaternion): void {
    this.transforms[id]!.compose(position, rotation, this.scale);
    const glass = this.glass[id];
    if (glass) { this.matrix.compose(position, rotation, this.scale); glass.mesh.setMatrixAt(glass.index, this.matrix); }
  }
  setDamage(id: number, damage: number, hidden = false): void {
    for (const entry of this.visibility[id]!) entry.values[entry.index] = Number(!hidden && damage < entry.detachAtDamage && (!entry.damageOnly || (damage > 0.22 && damage < 1)));
    const glass = this.glass[id]; if (glass) glass.mesh.setVisibleAt(glass.index, !hidden);
  }
  dispose(): void {
    this.batches.forEach(batch => { if (batch instanceof BatchedMesh) batch.dispose(); else batch.geometry.dispose(); });
    this.nodeMaterials.forEach(material => material.dispose());
    this.materials.dispose(); this.root.clear(); this.root.removeFromParent();
  }
}
