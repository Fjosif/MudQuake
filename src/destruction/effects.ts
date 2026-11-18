import { Color, DataTexture, DoubleSide, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, LinearFilter, Matrix4, MeshStandardMaterial, PlaneGeometry, Quaternion, RGBAFormat, Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, texture } from 'three/tsl';
import type { DestructionEvent, Vec3 } from './contracts';
import { randomSource } from './random';

class Pool {
  readonly position: Float32Array; readonly velocity: Float32Array; readonly age: Float32Array;
  readonly life: Float32Array; readonly size: Float32Array; readonly spin: Float32Array; readonly thickness: Float32Array;
  cursor = 0; active = 0;
  constructor(readonly capacity: number) {
    this.position = new Float32Array(capacity * 3); this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity); this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity); this.spin = new Float32Array(capacity);
    this.thickness = new Float32Array(capacity);
  }
  clear(): void { this.life.fill(0); this.age.fill(0); this.cursor = this.active = 0; }
}
export class DestructionEffects {
  readonly root = new Group();
  private fragments: Pool; private dust: Pool;
  private fragmentMesh: InstancedMesh; private dustMesh: InstancedMesh;
  private dustAlpha: InstancedBufferAttribute;
  private dustMap: DataTexture;
  private readonly matrix = new Matrix4(); private readonly q = new Quaternion();
  private readonly p = new Vector3(); private readonly s = new Vector3();
  private readonly color = new Color(); private readonly listener = new Vector3(0, 1.7, 22);
  private readonly look = new Matrix4(); private readonly up = new Vector3(0, 1, 0);
  private readonly fragmentAxis = new Vector3(0.72, 0.45, 0.53).normalize();
  private rng: () => number;
  // Preserve grown clouds during the dense impact cascade instead of continually
  // overwriting all 320 slots with newborn, almost transparent particles.
  private dustCredits = 36;
  private readonly ground: (x: number, z: number) => number;
  constructor(private readonly seed: number, fragmentCapacity: number, dustCapacity: number, ground: (x: number, z: number) => number) {
    this.rng = randomSource(seed ^ 0xeffec7); this.ground = ground;
    this.fragments = new Pool(fragmentCapacity); this.dust = new Pool(dustCapacity);
    // Jagged low-poly shard instead of cubical particles. Thousands of chips share one draw.
    const shard = new IcosahedronGeometry(1, 0); shard.scale(1, 0.6, 0.75);
    this.fragmentMesh = new InstancedMesh(shard, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.91 }), fragmentCapacity);
    // Allocate instanceColor BEFORE shader compilation; late allocation renders the first burst white.
    this.fragmentMesh.setColorAt(0, new Color(0xa99c82));
    this.fragmentMesh.instanceMatrix.setUsage(DynamicDrawUsage); this.fragmentMesh.frustumCulled = false;
    this.fragmentMesh.castShadow = false; this.fragmentMesh.receiveShadow = true;
    const n = 48, pixels = new Uint8Array(n * n * 4);
    const texRng = randomSource(seed ^ 0xd057);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n * 2 - 1, (y + 0.5) / n * 2 - 1);
      const billow = 0.8 + Math.sin(x * 0.37 + Math.sin(y * 0.29) * 2) * 0.13;
      const a = Math.pow(Math.max(0, 1 - r / billow), 1.45) * (0.88 + texRng() * 0.12);
      pixels.set([255, 255, 255, a * 150], (y * n + x) * 4);
    }
    this.dustMap = new DataTexture(pixels, n, n, RGBAFormat); this.dustMap.needsUpdate = true;
    this.dustMap.magFilter = this.dustMap.minFilter = LinearFilter;
    const dustGeometry = new PlaneGeometry(1, 1);
    this.dustAlpha = new InstancedBufferAttribute(new Float32Array(dustCapacity), 1).setUsage(DynamicDrawUsage);
    dustGeometry.setAttribute('particleOpacity', this.dustAlpha);
    const dustMaterial = new MeshBasicNodeMaterial({ color: 0xa99e8d, transparent: true, depthWrite: false, side: DoubleSide });
    dustMaterial.opacityNode = texture(this.dustMap).a.mul(attribute('particleOpacity', 'float'));
    this.dustMesh = new InstancedMesh(dustGeometry, dustMaterial, dustCapacity);
    this.dustMesh.name = 'MudquakeCollapseDust';
    this.dustMesh.instanceMatrix.setUsage(DynamicDrawUsage); this.dustMesh.frustumCulled = false;
    this.root.name = 'mudquake-destruction-effects'; this.root.add(this.fragmentMesh, this.dustMesh);
    this.clear();
  }
  emit(event: DestructionEvent): void {
    if (event.type !== 'failure' && event.type !== 'glass' && event.type !== 'impact' && event.type !== 'crack') return;
    const isGlass = event.type === 'glass', cracking = event.type === 'crack';
    const count = cracking ? (event.kind === 'wall' ? 10 : 4) : isGlass ? 26 : 12 + Math.floor(event.energy * 20);
    for (let j = 0; j < count; j++) {
      const i = this.fragments.cursor++ % this.fragments.capacity, k = i * 3;
      this.fragments.position[k] = event.position.x + (this.rng() - 0.5) * 0.4;
      this.fragments.position[k + 1] = event.position.y + (this.rng() - 0.5) * 0.4;
      this.fragments.position[k + 2] = event.position.z + (this.rng() - 0.5) * 0.4;
      this.fragments.velocity[k] = (this.rng() - 0.5) * (1.5 + event.energy * 3);
      this.fragments.velocity[k + 1] = this.rng() * 1.8;
      this.fragments.velocity[k + 2] = (this.rng() - 0.5) * (1.5 + event.energy * 3);
      this.fragments.age[i] = 0; this.fragments.life[i] = isGlass ? 6 : 9 + this.rng() * 6;
      const plaster = event.kind === 'wall' && (cracking || this.rng() < (event.type === 'failure' ? 0.7 : 0.3));
      this.fragments.size[i] = isGlass ? 0.025 + this.rng() * 0.055 : plaster ? 0.055 + this.rng() * 0.13 : 0.035 + this.rng() * 0.1;
      this.fragments.thickness[i] = plaster ? 0.08 : isGlass ? 0.05 : 0.7;
      this.fragments.spin[i] = (this.rng() - 0.5) * 12;
      this.color.setHex(isGlass ? 0xa7c1bf : plaster ? 0xc9c2b3 : event.kind === 'wall' || event.kind === 'chimney' ? 0x875440 : event.kind === 'roof' ? 0x704a37 : event.kind === 'post' || event.kind === 'beam' ? 0x66503a : 0xa99c82);
      this.color.multiplyScalar(0.75 + this.rng() * 0.45); this.fragmentMesh.setColorAt(i, this.color);
    }
    const masonry = event.kind === 'wall' || event.kind === 'chimney' || event.kind === 'floor' || event.kind === 'roof';
    if (!isGlass && masonry && (event.type !== 'impact' || event.energy > 0.12)) {
      const puffs = cracking ? 1 : 3 + Math.floor(event.energy * 4);
      for (let j = 0; j < puffs; j++) this.emitDust(event.position, cracking ? 0.06 : event.energy);
    }
    if (this.fragmentMesh.instanceColor) this.fragmentMesh.instanceColor.needsUpdate = true;
  }
  emitDust(position: Vec3, energy: number): void {
    if (this.dustCredits < 1) return;
    this.dustCredits--;
    const i = this.dust.cursor++ % this.dust.capacity, k = i * 3;
    this.dust.position[k] = position.x + (this.rng() - 0.5) * 1.1;
    this.dust.position[k + 1] = Math.max(position.y, this.ground(position.x, position.z) + 0.25);
    this.dust.position[k + 2] = position.z + (this.rng() - 0.5) * 1.1;
    this.dust.velocity[k] = (this.rng() - 0.35) * (0.7 + energy);
    this.dust.velocity[k + 1] = 0.16 + this.rng() * 0.32;
    this.dust.velocity[k + 2] = (this.rng() - 0.4) * (0.7 + energy);
    this.dust.age[i] = 0; this.dust.life[i] = 3.2 + this.rng() * 2.2;
    this.dust.size[i] = 0.7 + this.rng() * 0.6 + energy * 1.3;
  }
  setListenerPosition(position: Vec3): void { this.listener.set(position.x, position.y, position.z); }
  update(dt: number): void {
    this.dustCredits = Math.min(36, this.dustCredits + dt * 54);
    const f = this.fragments; f.active = 0;
    for (let i = 0; i < f.capacity; i++) {
      if (f.life[i] === 0) continue;
      const k = i * 3, age = f.age[i]! + dt; f.age[i] = age;
      if (age >= f.life[i]!) { f.life[i] = 0; this.hide(this.fragmentMesh, i); continue; }
      f.active++;
      f.velocity[k + 1] = f.velocity[k + 1]! - 9.81 * dt;
      for (let c = 0; c < 3; c++) f.position[k + c] = f.position[k + c]! + f.velocity[k + c]! * dt;
      const ground = this.ground(f.position[k]!, f.position[k + 2]!) + f.size[i]! * 0.5;
      if (f.position[k + 1]! < ground) {
        f.position[k + 1] = ground; f.velocity[k + 1] = Math.abs(f.velocity[k + 1]!) * 0.12;
        f.velocity[k] = f.velocity[k]! * 0.65; f.velocity[k + 2] = f.velocity[k + 2]! * 0.65;
      }
      this.p.fromArray(f.position, k);
      this.q.setFromAxisAngle(this.fragmentAxis, age * f.spin[i]!);
      const size = f.size[i]! * Math.min(1, (f.life[i]! - age) / 0.5);
      this.s.set(size, size * f.thickness[i]!, size); this.matrix.compose(this.p, this.q, this.s);
      this.fragmentMesh.setMatrixAt(i, this.matrix);
    }
    const d = this.dust; d.active = 0;
    for (let i = 0; i < d.capacity; i++) {
      if (d.life[i] === 0) continue;
      const k = i * 3, age = d.age[i]! + dt; d.age[i] = age;
      if (age >= d.life[i]!) { d.life[i] = 0; this.hide(this.dustMesh, i); this.dustAlpha.setX(i, 0); continue; }
      d.active++;
      for (let c = 0; c < 3; c++) d.position[k + c] = d.position[k + c]! + d.velocity[k + c]! * dt;
      this.p.fromArray(d.position, k); this.look.lookAt(this.listener, this.p, this.up); this.q.setFromRotationMatrix(this.look);
      const size = d.size[i]! * (1 + Math.sqrt(age) * 0.85); this.s.set(size, size * 0.8, size); this.matrix.compose(this.p, this.q, this.s);
      this.dustMesh.setMatrixAt(i, this.matrix);
      this.dustAlpha.setX(i, Math.min(1, age * 4) * Math.pow(Math.max(0, 1 - age / d.life[i]!), 1.2));
    }
    this.fragmentMesh.instanceMatrix.needsUpdate = true; this.dustMesh.instanceMatrix.needsUpdate = true; this.dustAlpha.needsUpdate = true;
  }
  private hide(mesh: InstancedMesh, i: number): void { this.matrix.makeScale(0, 0, 0); mesh.setMatrixAt(i, this.matrix); }
  clear(): void {
    this.fragments.clear(); this.dust.clear(); this.rng = randomSource(this.seed ^ 0xeffec7);
    this.dustCredits = 36;
    for (let i = 0; i < this.fragments.capacity; i++) this.hide(this.fragmentMesh, i);
    for (let i = 0; i < this.dust.capacity; i++) this.hide(this.dustMesh, i);
    this.dustAlpha.array.fill(0); this.dustAlpha.needsUpdate = true;
    this.fragmentMesh.instanceMatrix.needsUpdate = true; this.dustMesh.instanceMatrix.needsUpdate = true;
  }
  get activeFragments(): number { return this.fragments.active; }
  get activeDust(): number { return this.dust.active; }
  dispose(): void {
    for (const mesh of [this.fragmentMesh, this.dustMesh]) { mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); mesh.dispose(); }
    this.dustMap.dispose(); this.root.removeFromParent(); this.root.clear();
  }
}
