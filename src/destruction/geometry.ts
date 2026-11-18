import { BoxGeometry, BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Matrix4, Quaternion, Shape, Vector3 } from 'three';

export type Point2 = readonly [number, number];
export function clipPolygon(polygon: readonly Point2[], nx: number, ny: number, distance: number): Point2[] {
  const result: Point2[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const da = a[0] * nx + a[1] * ny - distance;
    const db = b[0] * nx + b[1] * ny - distance;
    if (da <= 1e-8) result.push(a);
    if ((da < 0) !== (db < 0)) {
      const t = da / (da - db);
      result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return result;
}
export function polygonArea(p: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!;
    area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(area) / 2;
}
/** Irregular continuous Voronoi fracture, with no exploded toy-block gaps. */
export function fractureRectangle(x0: number, y0: number, x1: number, y1: number, rng: () => number, spacingX = 1.05, spacingY = 0.97, minArea = 0.003): Point2[][] {
  const columns = Math.max(1, Math.round((x1 - x0) / spacingX));
  const rows = Math.max(1, Math.round((y1 - y0) / spacingY));
  const seeds: Point2[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    seeds.push([x0 + (c + 0.18 + rng() * 0.64) * (x1 - x0) / columns,
      y0 + (r + 0.18 + rng() * 0.64) * (y1 - y0) / rows]);
  }
  return seeds.map((a, index) => {
    let p: Point2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    seeds.forEach((b, j) => {
      if (index === j || p.length === 0) return;
      p = clipPolygon(p, b[0] - a[0], b[1] - a[1], (b[0] ** 2 + b[1] ** 2 - a[0] ** 2 - a[1] ** 2) / 2);
    });
    return p;
  }).filter(p => p.length >= 3 && polygonArea(p) > minArea);
}
/** Smaller independent skin fractures clipped to a convex masonry piece. */
export function fracturePlaster(polygon: readonly Point2[], rng: () => number): Point2[][] {
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  return fractureRectangle(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), rng, 0.34, 0.34, 1e-9)
    .map(cell => {
      let result = cell;
      for (let i = 0; i < polygon.length && result.length; i++) {
        const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
        const nx = b[1] - a[1], ny = a[0] - b[0];
        result = clipPolygon(result, nx, ny, nx * a[0] + ny * a[1]);
      }
      return result;
    }).filter(p => p.length >= 3 && polygonArea(p) > 1e-7);
}
/** Convex difference, partitioned without overlapping strips or cutting every cell into horizontal bands. */
export function subtractOpening(polygon: readonly Point2[], left: number, bottom: number, right: number, top: number): Point2[][] {
  const overlap = clipPolygon(clipPolygon(clipPolygon(clipPolygon(polygon, -1, 0, -left), 1, 0, right), 0, -1, -bottom), 0, 1, top);
  if (overlap.length < 3 || polygonArea(overlap) < 1e-8) return [[...polygon]];
  const leftPart = clipPolygon(polygon, 1, 0, left);
  const rightPart = clipPolygon(polygon, -1, 0, -right);
  const middle = clipPolygon(clipPolygon(polygon, -1, 0, -left), 1, 0, right);
  return [leftPart, rightPart, clipPolygon(middle, 0, 1, bottom), clipPolygon(middle, 0, -1, -top)]
    .filter(p => p.length >= 3 && polygonArea(p) > 1e-7);
}
export function polygonPrism(polygon: readonly Point2[], depth: number): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(polygon[0]![0], polygon[0]![1]);
  polygon.slice(1).forEach(p => shape.lineTo(p[0], p[1]));
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 });
  geometry.translate(0, 0, -depth / 2);
  // Metric UVs preserve masonry courses across adjoining fracture pieces.
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uv[i * 2] = Math.abs(normal.getZ(i)) > 0.5 ? position.getX(i) : position.getZ(i);
    uv[i * 2 + 1] = position.getY(i);
  }
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.clearGroups();
  return geometry;
}
export function box(x: number, y: number, z: number, px = 0, py = 0, pz = 0): BufferGeometry {
  const geometry = new BoxGeometry(x, y, z);
  geometry.translate(px, py, pz);
  geometry.clearGroups();
  return geometry;
}
export function beamBetween(a: Vector3, b: Vector3, width: number, depth = width): BufferGeometry {
  const g = box(width, a.distanceTo(b), depth);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return g.applyMatrix4(new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new Vector3(1, 1, 1)));
}
/** Concave upper surface; individual curved tile silhouettes survive roof section failure. */
export function roofTile(): BufferGeometry {
  const positions: number[] = [], uvs: number[] = [];
  const segments = 4;
  const vertex = (x: number, y: number, z: number, u: number, v: number) => { positions.push(x, y, z); uvs.push(u, v); };
  for (let i = 0; i < segments; i++) {
    const x0 = -0.16 + i * 0.32 / segments, x1 = x0 + 0.32 / segments;
    const y0 = 0.027 * Math.cos((i / segments - 0.5) * Math.PI * 2);
    const y1 = 0.027 * Math.cos(((i + 1) / segments - 0.5) * Math.PI * 2);
    vertex(x0, y0, -0.27, i / segments, 0); vertex(x0, y0 + 0.025, 0.27, i / segments, 1); vertex(x1, y1, -0.27, (i + 1) / segments, 0);
    vertex(x1, y1, -0.27, (i + 1) / segments, 0); vertex(x0, y0 + 0.025, 0.27, i / segments, 1); vertex(x1, y1 + 0.025, 0.27, (i + 1) / segments, 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}
