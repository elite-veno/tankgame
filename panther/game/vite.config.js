import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  // alle Three.js-addons vooraf bundelen; anders herlaadt Vite de pagina zodra de match
  // (dynamisch geïmporteerd) voor het eerst een nieuwe addon gebruikt
  optimizeDeps: {
    include: [
      'three',
      'three/addons/controls/OrbitControls.js',
      'three/addons/environments/RoomEnvironment.js',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/loaders/HDRLoader.js',
      'three/addons/utils/BufferGeometryUtils.js',
    ],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
