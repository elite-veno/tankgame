// Eén gedeelde WebGL-renderer voor de hangar en de match.
import { WebGLRenderer, ACESFilmicToneMapping, SRGBColorSpace, PCFShadowMap } from 'three';
import { CONFIG } from '../config.js';

export function createRenderer(canvas) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.graphics.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = CONFIG.graphics.shadows;
  renderer.shadowMap.type = PCFShadowMap;
  return renderer;
}
