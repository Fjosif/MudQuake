import { BufferGeometry, Quaternion, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ComponentKind } from './contracts';
import { beamBetween, box, fracturePlaster, fractureRectangle, polygonPrism, roofTile, subtractOpening, type Point2 } from './geometry';
import type { MaterialKey } from './materials';
import { randomSource } from './random';

export interface VisualPart { readonly material: MaterialKey; readonly geometry: BufferGeometry; readonly damageOnly?: boolean; readonly detachAtDamage?: number }
export interface HouseComponent {
  readonly id: number;
  readonly kind: ComponentKind;
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly halfExtents: Vector3;
  readonly hull?: Float32Array;
  readonly colliderBoxes?: readonly { readonly size: Vector3; readonly position: Vector3; readonly rotation?: Quaternion }[];
  readonly density: number;
  readonly strength: number;
  readonly parts: readonly VisualPart[];
  readonly supportIds: number[];
  readonly neighborIds: number[];
  readonly permanent: boolean;
}
export interface HouseBlueprint { readonly components: readonly HouseComponent[]; readonly bounds: { width: number; depth: number; height: number } }

/** Geometry is local to each rigid body. No scene, renderer, clock, physics or external assets. */
export function buildHouse(seed: number, baseElevation = 0): HouseBlueprint {
  const rng = randomSource(seed), components: HouseComponent[] = [];
  function add(kind: ComponentKind, position: Vector3, size: Vector3, parts: VisualPart[], strength: number, density: number, rotation = new Quaternion(), hull?: Float32Array): HouseComponent {
    const c: HouseComponent = {
      id: components.length, kind, position: position.add(new Vector3(0, baseElevation, 0)), rotation,
      halfExtents: size.multiplyScalar(0.5), parts, strength: strength * (0.88 + rng() * 0.24), density,
      supportIds: [], neighborIds: [], permanent: kind === 'foundation', ...(hull ? { hull } : {}),
    };
    components.push(c); return c;
  }
  const part = (material: MaterialKey, geometry: BufferGeometry): VisualPart => ({ material, geometry });
  function merged(material: MaterialKey, geometries: BufferGeometry[]): VisualPart {
    // BatchedMesh accepts indexed or non-indexed geometry, but merge requires a uniform layout.
    const normalized = geometries.map(g => g.index ? g.toNonIndexed() : g);
    const geometry = mergeGeometries(normalized, false)!;
    new Set([...normalized, ...geometries]).forEach(g => g.dispose());
    return part(material, geometry);
  }
  const foundation = add('foundation', new Vector3(0, 0.12, 0), new Vector3(10.4, 0.32, 8.4), [part('concrete', box(10.4, 0.32, 8.4))], 1e9, 2300);

  // Sill plates, exposed posts and ring beams are separate load-bearing components.
  for (const y of [1.57, 4.17]) {
    for (const x of [-4.82, 0, 4.82]) for (const z of [-3.82, 3.82]) {
      const post = add('post', new Vector3(x, y, z), new Vector3(0.22, 2.54, 0.22), [part('wood', box(0.22, 2.54, 0.22)), part('metal', box(0.24, 0.07, 0.24, 0, -1.18, 0))], 1.25, 650);
      if (y < 2) post.supportIds.push(foundation.id);
    }
    for (const z of [-3.82, 3.82]) for (const x of [-2.41, 2.41]) {
      add('beam', new Vector3(x, y + 1.27, z), new Vector3(4.82, 0.2, 0.24), [part('wood', box(4.82, 0.2, 0.24))], 1.45, 650);
    }
    for (const x of [-4.82, 4.82]) for (const z of [-1.91, 1.91]) {
      add('beam', new Vector3(x, y + 1.27, z), new Vector3(0.24, 0.2, 3.82), [part('wood', box(0.24, 0.2, 3.82))], 1.4, 650);
    }
  }
  // Nine first-floor sections carry their joists with them; real gaps permit separate falling sections.
  for (let ix = 0; ix < 3; ix++) for (let iz = 0; iz < 3; iz++) {
    const wood: BufferGeometry[] = [];
    for (let p = 0; p < 13; p++) wood.push(box(3.13, 0.045, 0.191, 0, 0.04, -1.2 + p * 0.2));
    for (const x of [-1.35, 0, 1.35]) wood.push(box(0.11, 0.22, 2.57, x, -0.09, 0));
    add('floor', new Vector3(-3.15 + ix * 3.15, 2.98, -2.6 + iz * 2.6), new Vector3(3.14, 0.24, 2.58), [merged('wood', wood), part('interior', box(3.12, 0.018, 2.56, 0, -0.21, 0))], 1.55, 520);
  }
  // Ground-floor planks are decorative parts attached to the foundation.
  const floor: BufferGeometry[] = [];
  for (let i = 0; i < 32; i++) floor.push(box(9.5, 0.035, 0.235, 0, 0.18, -3.7 + i * 0.239));
  (foundation.parts as VisualPart[]).push(merged('wood', floor));

  interface Opening { left: number; right: number; bottom: number; top: number; door: boolean }
  function wall(length: number, origin: Vector3, angle: number, front: boolean): void {
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);
    const openings: Opening[] = [];
    for (const y of [1.12, 3.56]) for (const x of [-length * 0.3, length * 0.3]) {
      openings.push({ left: x - 0.63, right: x + 0.63, bottom: y, top: y + 1.14, door: false });
    }
    if (front) openings.push({ left: -0.58, right: 0.58, bottom: 0.3, top: 2.48, door: true });
    // Fracture the complete facade FIRST. Window subtraction now only clips cells touching
    // an opening, preserving angled cracks instead of producing long rectangular courses.
    let cells = fractureRectangle(-length / 2, 0.3, length / 2, 5.28, rng);
    for (const opening of [...openings, { left: -length / 2, right: length / 2, bottom: 2.88, top: 3.1 }]) {
      cells = cells.flatMap(polygon => subtractOpening(polygon, opening.left, opening.bottom, opening.right, opening.top));
    }
    for (const polygon of cells) {
        const cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
        const cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
        const local: Point2[] = polygon.map(p => [p[0] - cx, p[1] - cy]);
        const w = Math.max(...local.map(p => p[0])) - Math.min(...local.map(p => p[0]));
        const h = Math.max(...local.map(p => p[1])) - Math.min(...local.map(p => p[1]));
        const hull = new Float32Array(local.flatMap(p => [p[0], p[1], -0.155, p[0], p[1], 0.155]));
        // A real masonry core survives skin failure. Cut edges expose brick, while
        // independently detachable 6 mm plaster patches peel off both wall faces.
        const core = polygonPrism(local, 0.306);
        const parts: VisualPart[] = [part('brick', core)];
        const skinRng = randomSource(seed ^ Math.imul(components.length + 1, 0x51ed270b));
        for (const patch of fracturePlaster(local, skinRng)) {
          const front = polygonPrism(patch, 0.006); front.translate(0, 0, 0.157);
          const back = polygonPrism(patch, 0.006); back.translate(0, 0, -0.157);
          parts.push({ ...merged('plaster', [front, back]), detachAtDamage: 0.48 + skinRng() * 0.64 });
        }
        // Preserve metric courses and weathering across adjoining wall pieces.
        for (const visual of parts) {
          const uv = visual.geometry.getAttribute('uv');
          for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + cx, uv.getY(i) + cy);
        }
        const cracks: BufferGeometry[] = [];
        for (const side of [-1, 1]) {
          let a = new Vector3(-w * 0.25, -h * 0.35, side * 0.1605);
          for (let s = 1; s <= 4; s++) {
            const b = new Vector3((s / 4 - 0.5) * w * 0.55 + (rng() - 0.5) * 0.07, (s / 4 - 0.5) * h * 0.8, side * 0.1605);
            cracks.push(beamBetween(a, b, 0.006, 0.001)); a = b;
          }
        }
        parts.push({ ...merged('fracture', cracks), damageOnly: true });
        add('wall', new Vector3(cx, cy, 0).applyQuaternion(rotation).add(origin), new Vector3(w, h, 0.31), parts,
          (cy < 3 ? 1.15 : 0.94) * (0.8 + rng() * 0.65), 1680, rotation.clone(), hull);
    }
    for (const opening of openings) {
      const x = (opening.left + opening.right) / 2, y = (opening.bottom + opening.top) / 2;
      const w = opening.right - opening.left, h = opening.top - opening.bottom;
      const position = new Vector3(x, y, 0).applyQuaternion(rotation).add(origin);
      if (opening.door) {
        const planks: BufferGeometry[] = [];
        for (let i = 0; i < 6; i++) planks.push(box(w / 6 - 0.008, h - 0.04, 0.065, -w / 2 + (i + 0.5) * w / 6, 0, 0));
        planks.push(box(w - 0.05, 0.1, 0.08, 0, -h * 0.32, -0.035), box(w - 0.05, 0.1, 0.08, 0, h * 0.32, -0.035));
        add('door', position, new Vector3(w - 0.02, h - 0.02, 0.09), [merged('wood', planks), part('metal', box(0.035, 0.13, 0.05, w * 0.33, 0, 0.06))], 0.78, 650, rotation.clone());
      } else {
        add('glass', position.clone(), new Vector3(w - 0.12, h - 0.12, 0.012), [part('glass', box(w - 0.12, h - 0.12, 0.012))], 0.22, 2500, rotation.clone());
      }
      const trim = [box(0.075, h + 0.12, 0.13, -w / 2, 0, 0), box(0.075, h + 0.12, 0.13, w / 2, 0, 0), box(w + 0.14, 0.075, 0.15, 0, h / 2, 0)];
      if (!opening.door) trim.push(box(w + 0.22, 0.09, 0.28, 0, -h / 2, 0.07), box(0.045, h, 0.07), box(w, 0.04, 0.07));
      const frame = add('beam', position, new Vector3(w + 0.15, h + 0.12, 0.14), [merged('wood', trim)], 1.15, 560, rotation.clone());
      // Compound colliders keep the opening hollow. Cross-muntins are visual detail only.
      Object.assign(frame, { colliderBoxes: [
        { size: new Vector3(0.075, h + 0.12, 0.13), position: new Vector3(-w / 2, 0, 0) },
        { size: new Vector3(0.075, h + 0.12, 0.13), position: new Vector3(w / 2, 0, 0) },
        { size: new Vector3(w + 0.14, 0.075, 0.15), position: new Vector3(0, h / 2, 0) },
        ...(!opening.door ? [{ size: new Vector3(w + 0.22, 0.09, 0.28), position: new Vector3(0, -h / 2, 0.07) }] : []),
      ] });
    }
  }
  wall(9.6, new Vector3(0, 0, 4), 0, true);
  wall(9.6, new Vector3(0, 0, -4), Math.PI, false);
  wall(7.7, new Vector3(-5, 0, 0), -Math.PI / 2, false);
  wall(7.7, new Vector3(5, 0, 0), Math.PI / 2, false);

  // Sixteen pitched roof sections, each with lapped curved tiles, battens, a rafter and fascia.
  const rise = 1.7, run = 4.5, slope = Math.atan2(rise, run), length = Math.hypot(rise, run);
  for (const side of [-1, 1]) for (let i = 0; i < 8; i++) {
    const tiles: BufferGeometry[] = [], timber: BufferGeometry[] = [];
    for (let row = 0; row < 12; row++) for (let col = 0; col < 4; col++) {
      const g = roofTile();
      g.translate(-0.465 + col * 0.31, 0.08 + (11 - row) * 0.004, -length / 2 + 0.2 + row * 0.395);
      tiles.push(g);
    }
    for (let row = 0; row < 12; row++) timber.push(box(1.26, 0.045, 0.05, 0, 0.025, -length / 2 + row * 0.4));
    timber.push(box(0.11, 0.19, length - 0.22, -0.49, -0.075, side * 0.11), box(0.11, 0.19, length - 0.22, 0.49, -0.075, side * 0.11), box(1.27, 0.16, 0.05, 0, -0.03, length / 2));
    const panel = add('roof', new Vector3(-4.55 + i * 1.3, 6.15, side * 2.25), new Vector3(1.285, 0.2, length),
      [merged('tile', tiles), merged('wood', timber)], 1.13, 520,
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), side * slope));
    // Thin tile skin + real rafters, not a solid box filling the air below the roof.
    // Ridge ends stop short so opposing slopes do not start deeply interpenetrating.
    Object.assign(panel, { colliderBoxes: [
      { size: new Vector3(1.25, 0.055, length - 0.12), position: new Vector3(0, 0.10, side * 0.06) },
      { size: new Vector3(0.10, 0.18, length - 0.22), position: new Vector3(-0.49, -0.075, side * 0.11) },
      { size: new Vector3(0.10, 0.18, length - 0.22), position: new Vector3(0.49, -0.075, side * 0.11) },
    ] });
  }
  // Open attic trusses expose king posts and diagonal bracing after tiles fall.
  for (let i = 0; i < 5; i++) {
    const beams = [beamBetween(new Vector3(0, 0, -3.8), new Vector3(0, 0, 3.8), 0.16),
      beamBetween(new Vector3(0, 0, -3.8), new Vector3(0, 1.5, 0), 0.16),
      beamBetween(new Vector3(0, 1.5, 0), new Vector3(0, 0, 3.8), 0.16),
      box(0.14, 1.5, 0.14, 0, 0.75, 0),
      beamBetween(new Vector3(0, 0, 0), new Vector3(0, 0.75, -1.9), 0.09),
      beamBetween(new Vector3(0, 0, 0), new Vector3(0, 0.75, 1.9), 0.09)];
    const trussGeometry = merged('wood', beams);
    const truss = add('beam', new Vector3(-4 + i * 2, 5.42, 0), new Vector3(0.18, 1.65, 7.6), [trussGeometry], 1.8, 600);
    const segment = (a: Vector3, b: Vector3, width: number) => ({
      position: a.clone().add(b).multiplyScalar(0.5),
      size: new Vector3(width, a.distanceTo(b), width),
      rotation: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize()),
    });
    Object.assign(truss, { colliderBoxes: [
      segment(new Vector3(0, 0, -3.8), new Vector3(0, 0, 3.8), 0.16),
      segment(new Vector3(0, 0, -3.8), new Vector3(0, 1.5, 0), 0.16),
      segment(new Vector3(0, 1.5, 0), new Vector3(0, 0, 3.8), 0.16),
      segment(new Vector3(0, 0, 0), new Vector3(0, 1.5, 0), 0.14),
    ] });
  }
  // Lightweight gable boards leave the roof structure legible, rather than a monolithic roof block.
  for (const x of [-4.93, 4.93]) {
    const gable = polygonPrism([[-3.9, 0], [3.9, 0], [0, 1.48]], 0.085);
    add('wall', new Vector3(x, 5.38, 0), new Vector3(7.8, 1.48, 0.085), [part('wood', gable)], 0.6, 440,
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
      new Float32Array([-3.9, 0, -0.042, 3.9, 0, -0.042, 0, 1.48, -0.042, -3.9, 0, 0.042, 3.9, 0, 0.042, 0, 1.48, 0.042]));
  }
  for (let i = 0; i < 5; i++) {
    const chimney = [box(0.72, 0.22, 0.13, 0, 0, -0.295), box(0.72, 0.22, 0.13, 0, 0, 0.295), box(0.13, 0.22, 0.46, -0.295, 0, 0), box(0.13, 0.22, 0.46, 0.295, 0, 0)];
    add('chimney', new Vector3(2.65, 6.3 + i * 0.225, -1.1), new Vector3(0.72, 0.22, 0.72), [merged('brick', chimney)], 0.46, 1550);
  }

  // Build a bottom-up load path and lateral links from geometry, stable in deterministic ID order.
  for (const c of components) {
    if (c.permanent || c.supportIds.length) continue;
    const y = c.position.y - baseElevation;
    const candidates = components.filter(p => p.id !== c.id && p.kind !== 'glass' && p.kind !== 'door'
      && (c.kind !== 'roof' || (p.kind === 'beam' && p.position.y > baseElevation + 5))
      && (p.kind === 'foundation' || p.kind === 'post' || p.kind === 'beam' || p.kind === 'wall' || p.kind === 'floor')
      && p.position.y < c.position.y - 0.12 && p.position.y > c.position.y - (c.kind === 'roof' ? 3.6 : 3.2));
    candidates.sort((a, b) => supportDistance(c, a) - supportDistance(c, b) || a.id - b.id);
    for (const p of candidates.slice(0, c.kind === 'roof' || c.kind === 'floor' ? 4 : 2)) c.supportIds.push(p.id);
    if (!c.supportIds.length && y < 3) c.supportIds.push(foundation.id);
    // Upper chimney courses are supported by the one below, preventing floating pieces.
    if (c.kind === 'chimney') {
      const lower = components.find(p => p.kind === 'chimney' && p.id === c.id - 1);
      if (lower) c.supportIds.splice(0, c.supportIds.length, lower.id);
    }
    const neighbors = components.filter(p => p.id !== c.id && p.kind === c.kind && p.position.distanceTo(c.position) < 1.8);
    neighbors.forEach(p => c.neighborIds.push(p.id));
  }
  return { components, bounds: { width: 10.4, depth: 9, height: 7.44 } };
}
function supportDistance(a: HouseComponent, b: HouseComponent): number {
  const dx = Math.max(0, Math.abs(a.position.x - b.position.x) - b.halfExtents.x);
  const dz = Math.max(0, Math.abs(a.position.z - b.position.z) - b.halfExtents.z);
  return dx * dx + dz * dz + Math.abs(a.position.y - b.position.y - b.halfExtents.y) * 0.35;
}
