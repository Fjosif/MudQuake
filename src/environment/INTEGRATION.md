# MUDQUAKE – Environment Module (`src/environment/`) Integration Notes

## Exported Contract
Imported from `src/environment/index.ts`:

```ts
createEnvironment(scene, renderer, options)
updateEnvironment(deltaTime, elapsedTime, earthquakeState)
disposeEnvironment()
```

Additional helper exports for Agent B & Integration:
- `notifyDebrisImpact(position: Vec3Like, impulse: number, radius?: number): void` — Spawns localized ballistic mud clods and muddy water spray at the exact ground impact point when collapsing house debris hits the terrain.
- `getTerrainHeightAt(x: number, z: number): number` — Deterministic heightfield query (meters) matching the rendered terrain mesh.
- `getTerrainNormalAt(x: number, z: number, target?: THREE.Vector3): THREE.Vector3` — Analytical terrain normal query.
- `setEnvironmentQuality(quality: 'low' | 'medium' | 'high' | 'ultra'): void` — Runtime quality preset switching.
- `getEnvironmentStats(): EnvironmentStats` — Returns vertex, particle, instance counts, and CPU `updateEnvironment` timing.

## Integration Requirements
1. **Camera tracking for rain**: Set `scene.userData.camera = camera` so the GPU toroidal rain volume stays centered around the active camera as the user walks or orbits.
2. **House pad**: Centered at `(0, 0, 0)` with default `halfWidth = 5.2`, `halfDepth = 4.2`, `foundationY = 0.0`, and crushed wet gravel apron blending into the muddy yard and foreground wheel ruts.
3. **Rapier 3D ground collider**: For debris-ground collisions, either place a ground plane/box at `y = 0` under the house pad or sample `getTerrainHeightAt(x, z)` over a heightfield grid.
4. **Debris splashes**: On Rapier contact events between house debris and ground, call `notifyDebrisImpact(contactPoint, impulseMagnitude, debrisRadius)`.
5. **Dependencies**: Built against `three@0.187.0` (`three/webgpu` + `three/tsl`).

## Technical Limitations
- **Puddle reflections**: Uses a procedural equirectangular overcast storm-sky environment map (`DataTexture`) rather than a full-scene planar reflection pass, so puddles reflect the sky/clouds/sunlight accurately at minimal GPU cost but do not mirror dynamic house walls in real time.
- **Rain occlusion**: Rain streaks are simulated in a camera-centered GPU toroidal volume and do not perform per-drop roof occlusion inside the house interior.
- **Terrain shake**: Earthquake terrain shaking is applied in the vertex shader (`positionNode`) and puddle normals rather than mutating the Rapier physics heightfield each frame.
- **Performance scope**: Verified at `1280×800` in headless/automated Chromium on the `WebGPU` backend at `60 FPS` (`high` preset, `0.00–0.30 ms` CPU update); 1440p RTX 4090 target was not directly benchmarked in this session's environment.
