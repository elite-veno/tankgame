// Laden van assets met voortgang. Resultaten worden bewaard, zodat een tweede match niets opnieuw laadt.
import {
  LoadingManager,
  TextureLoader,
  RepeatWrapping,
  SRGBColorSpace,
  NoColorSpace,
  PMREMGenerator,
  EquirectangularReflectionMapping,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const BASE = './assets/';

export class AssetStore {
  constructor(renderer) {
    this.renderer = renderer;
    this.tank = null;
    this.world = null;
  }

  // Laadt een lijst taken [{ key, file, load() -> Promise }] en meldt voortgang (0..1).
  // Een mislukte taak geeft een Error met de bestandsnaam (loaders geven soms alleen een Event).
  async runTasks(tasks, onProgress) {
    const results = {};
    let done = 0;
    onProgress?.(0);
    await Promise.all(
      tasks.map(async (task) => {
        try {
          results[task.key] = await task.load();
        } catch (err) {
          throw new Error(`${task.file} kon niet geladen worden${err?.message ? ` (${err.message})` : ''}`);
        }
        done++;
        onProgress?.(done / tasks.length);
      }),
    );
    return results;
  }

  async loadTank(onProgress) {
    if (this.tank) {
      onProgress?.(1);
      return this.tank;
    }
    const loader = new GLTFLoader(new LoadingManager());
    const files = { full: 'panther.glb', lod1: 'panther_lod1.glb', lod2: 'panther_lod2.glb', lod3: 'panther_lod3.glb' };
    const tasks = Object.entries(files).map(([key, file]) => ({ key, file, load: () => loader.loadAsync(BASE + file) }));
    this.tank = await this.runTasks(tasks, onProgress);
    return this.tank;
  }

  async loadWorld(onProgress) {
    if (this.world) {
      onProgress?.(1);
      return this.world;
    }
    const texLoader = new TextureLoader();
    const aniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    const tex = (key, file, srgb, repeat = true) => ({
      key,
      file,
      load: async () => {
        const t = await texLoader.loadAsync(BASE + file);
        t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
        if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
        t.anisotropy = aniso;
        return t;
      },
    });
    const json = (key, file) => ({
      key,
      file,
      load: async () => {
        const res = await fetch(BASE + file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    });
    const tasks = [
      tex('groundForest', 'ground_forest_diff.jpg', true),
      tex('groundForestN', 'ground_forest_nor.jpg', false),
      tex('groundLeaves', 'ground_leaves_diff.jpg', true),
      tex('groundLeavesN', 'ground_leaves_nor.jpg', false),
      tex('groundMud', 'ground_mud_diff.jpg', true),
      tex('groundMudN', 'ground_mud_nor.jpg', false),
      tex('bark', 'bark.jpg', true),
      tex('trees', 'trees_atlas.png', true, false),
      json('treesMeta', 'trees_atlas.json'),
      tex('plants', 'plants_atlas.png', true, false),
      {
        key: 'env',
        file: 'sky.hdr',
        load: async () => {
          const hdr = await new HDRLoader().loadAsync(BASE + 'sky.hdr');
          hdr.mapping = EquirectangularReflectionMapping;
          const pmrem = new PMREMGenerator(this.renderer);
          const env = pmrem.fromEquirectangular(hdr).texture;
          pmrem.dispose();
          hdr.dispose();
          return env;
        },
      },
    ];
    this.world = await this.runTasks(tasks, onProgress);
    this.world.trees.anisotropy = 4;
    this.world.plants.anisotropy = 4;
    return this.world;
  }
}
