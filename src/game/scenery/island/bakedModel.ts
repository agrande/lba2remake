import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

import LightMapPlugin from '../../../graphics/gltf/LightMapPlugin';
import LBAMaterialsPlugin from '../../../graphics/gltf/LBAMaterialsPlugin';
import { loadTexture } from '../../../texture';
import { IslandData } from './data';
import TextureAtlas from './TextureAtlas';
import { IslandModel } from './model';
import { registerPalette } from '../../../graphics/materials/impl/PalUtils';

export async function hasBakedModel(name: string) {
    const info = await fetch(`models/lba2/islands/${name}.glb`, {
        method: 'HEAD'
    });
    return info.ok;
}

export async function loadBakedModel(
    data: IslandData,
    models: IslandModel[]
): Promise<THREE.Object3D> {
    const atlas = new TextureAtlas(data, models, true);
    const textures = {
        ground: loadTexture(data.ile.getEntry(1), data.palette, false),
        objects: atlas.texture
    };
    const loader = new GLTFLoader();
    loader.register(parser => new LightMapPlugin(parser));
    loader.register(parser => new LBAMaterialsPlugin(parser, textures));
    await registerPalette();
    const gltf = await loader.loadAsync(`models/lba2/islands/${data.name}.glb`);
    return gltf.scene;
}