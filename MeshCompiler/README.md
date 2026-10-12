# ReSkate Mesh Compiler

Swap the mesh of any ReSkate cosmetic for a new model and keep the cosmetic's own bones.
Shoes, tops, hoodies, pants, hair, hats, full costumes and decks all work the same way.

Open **`ReSkate_Mesh_Compiler.html`** in a browser (double-click it; no install, no server,
works offline). Files never leave your computer.

## How to use it

1. **Import cosmetic.** In ReSkate Studio, export the cosmetic you want to replace. In the
   Mesh Compiler press **Import folder…** and pick that export folder (or drop the folder on
   the window). The FBX is read with its skeleton, skin and every mesh; the texture images are
   listed separately.
2. **New model.** Press **Import new model…** and pick an FBX, OBJ or GLB in any size or
   orientation. It is turned, sized and placed on the selected target automatically, using the
   original's measurements. Fine-tune with the handles (`W` move, `E` rotate, `R` scale) or by
   typing values. For a pair, select the placed part and press **Duplicate & mirror** (`M`):
   the copy lands on the other side, mirrored across the character's centre (found from the
   left/right bones). **Split** turns a multi-mesh model into separate parts. Heavy models are
   simplified automatically to about twice the original's triangle count (**Detail** changes it).
3. **Textures.** For each of the cosmetic's textures choose the original, **Replace…** with
   your own image, a texture that came with the new model, or a flat colour.
   **Load new model textures…** takes a folder (for example a Substance export) and matches
   base colour, normal, roughness and so on by name. A model with several materials (Body, Sole,
   Laces…) is combined into the cosmetic's one texture set: each material gets a part of the
   texture and its UVs are moved to match. Replacements are written at the original size and
   format under the original file names. **Flip G** converts between OpenGL and DirectX normal maps.
4. **Compile & export.** **Compile** puts each new part into the original mesh it sits on (in
   every LOD) and gives every new vertex the bone weights of the closest point on the original
   surface. Check the result with **Weights** (colour by bone) and the **Bend test**. Then
   **Export folder (.zip)** (FBX + all textures) or **Export .fbx**, and load them into
   ReSkate Studio for that cosmetic.

## What the compiler changes

Only the mesh data is rebuilt: each replaced `Geometry` (vertices, polygons, edges, normals,
tangents, UVs, vertex colours, material indices), the `Indexes`/`Weights` of each skin
`Cluster`, and blend-shape deltas (carried over from the original surface). The skeleton,
bind pose, bone names, cluster matrices, materials, texture links, object ids and connections
are written back byte for byte, so the FBX keeps the structure Studio exported. Binary
(7.x, including 7.5+ 64-bit) and ASCII FBX are both read and written in their own format.

## Building

The HTML is built from `src/` with esbuild and three.js:

```
cd MeshCompiler
npm install
npm run build   # writes ReSkate_Mesh_Compiler.html
npm test        # FBX round trips, weight transfer, mirroring, auto placement
```

| Path | What |
|---|---|
| `src/fbx/binary.js`, `src/fbx/ascii.js` | FBX node tree reader/writer (lossless for untouched nodes) |
| `src/fbx/scene.js` | Meshes, skin clusters, skeleton and bind pose from the tree |
| `src/fbx/compile.js` | Builds the new meshes and rewrites geometry, clusters and shapes |
| `src/mesh/transfer.js`, `src/mesh/grid.js` | Closest-point weight, colour and shape transfer |
| `src/mesh/align.js` | Auto placement, fit and mirror |
| `src/mesh/simplify.js` | Triangle budget (meshoptimizer), per material |
| `src/atlas.js` | Combining several materials into one texture set |
| `src/mesh/newmodel.js` | Loads FBX/OBJ/GLB models as static parts |
| `src/textures.js` | Texture types, PNG/JPG/TGA/DDS decoding, re-encoding |
| `src/main.js`, `src/viewport.js` | The page and the 3D view |
