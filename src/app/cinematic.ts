import { RenderPipeline, type Node, type WebGPURenderer } from 'three/webgpu';
import { mix, pass, vec4 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type { PerspectiveCamera, Scene } from 'three';

/** Half-resolution local occlusion adds depth under eaves and between rubble pieces. */
export function createCinematicPipeline(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera) {
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  const occlusion = ao(scenePass.getTextureNode('depth'), null as unknown as Node, camera);
  occlusion.resolutionScale = 0.5;
  occlusion.samples.value = 8; occlusion.radius.value = 1.2;
  occlusion.thickness.value = 0.35; occlusion.scale.value = 1;
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = vec4(color.rgb.mul(mix(1, occlusion.getTextureNode().r, 0.65)), color.a);
  return {
    render: () => pipeline.render(),
    dispose() { pipeline.dispose(); occlusion.dispose(); scenePass.dispose(); },
  };
}
