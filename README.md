# STEP Viewer

A local, browser-based viewer for `.step` / `.stp` CAD files, with preset isometric and orthographic camera views.

## Running it

Browsers block WASM loading over `file://`, so serve the folder over local HTTP:

```
cd "step-viewer"
python3 -m http.server 8743
```

Then open http://localhost:8743/index.html in Chrome or any modern browser.

## Using it

- A procedural test cube loads by default so there's always something on screen to try the controls on — its 6 faces are each their own part (Top/Bottom/Front/Back/Right/Left), individually selectable and colorable just like a multi-part STEP file. Drag a `.step`/`.stp` file onto the drop zone (or click it to browse) to replace it — the swap is instant, no bundled file involved.
- Every sidebar section collapses — click its header to fold it away. **Collapse all**/**Expand all** next to the title does it for every section at once (the label flips depending on whether anything's still open). Collapsed state is remembered per browser (via `localStorage`), so your layout persists across reloads.
- Large files (the bundled `test models/` are 18-25 MB) can take anywhere from several seconds to around a minute to parse — parsing runs in a background Web Worker so the page stays responsive while it works. Above 30 MB, the loading overlay flags the file as large before it even starts, and shows a live elapsed-time counter throughout — occt-import-js gives no progress callbacks, so without it a slow-but-working parse and a dead one look identical. Very large or geometrically complex assemblies (many thousands of individual parts) can take many minutes and may exceed what a single-threaded, in-browser WASM parser can hold in memory; if that happens, the file still "succeeds" but produces zero triangles for some or all parts, so the sidebar now checks for that specifically and shows an explicit warning (with the affected part count) instead of just a silently empty viewport.
- Once loaded, use the sidebar buttons to jump to a preset view:
  - **Isometric views**: Front-Right-Top, Front-Left-Top, Back-Right-Top, Back-Left-Top (true 35.26° isometric corners)
  - **Axis-aligned views**: Front, Back, Left, Right, Top, Bottom
  - **Hero views**: the same 4 corners as Isometric but at a shallower 18° elevation — reads more like a product photo than a CAD drawing, which suits flat/wide hardware (a card, a server tray) that true isometric foreshortens oddly — plus **Top-Front**/**Top-Back**, a Top view tilted 30° toward the front or back (60° elevation, no left-right skew) for showing a fan shroud or heatsink layout with some depth instead of a flat orthographic Top.
  - **Fit & Reset View**: reframes and returns to the default isometric view
- Orbit/pan/zoom freely with the mouse (drag to orbit, scroll to zoom, right-drag to pan) between preset clicks.
- **Rotate model**: spins the model itself, in place around its own center, ±7.5° per click about the STEP file's world X/Y/Z axes — the camera doesn't move. 24 clicks on one axis = full 180°, e.g. to see the underside of a part while keeping the same camera angle. The number field between the buttons shows the running total for that axis and is itself editable — type an angle and press Enter/tab away to jump straight there. **Reset Rotation** clears it (and the fields) back to how the file was loaded.
- **Parallel projection** (in the View section): switches to an orthographic camera, so parallel edges on the model stay parallel on screen instead of converging toward a vanishing point. Your current view angle carries over when toggling.
- **Camera angle (A/E/D)** (also in the View section): same layout as Rotate Model — ±7.5° buttons flanking an editable field for Azimuth and Elevation, ±10% buttons for Distance (a fixed mm step wouldn't scale between a tiny part and a full chassis). All three stay live as you mouse-orbit or click a view preset, and typing a value + pressing Enter/tab away jumps the camera exactly there. **Copy** puts the current values on the clipboard as plain text — meant for handing to someone reproducing the shot in other 3D software, where "azimuth/elevation/distance from the subject" means something regardless of that software's own camera conventions. The same numbers are burned into the PNG export label.
- Toggle **Show edges** and **Wireframe** in the Display section.
- **Background color**: checked by default (`#ffffff`) — type a hex code (`#rrggbb`, `#rgb`, or without the `#`) or use the swatch next to it. **Uncheck it to go transparent** instead, live and in PNG exports alike — the export always mirrors whatever the live view is showing, checked or not, so there's no separate "always transparent" export behavior to fight with anymore.
- **Cast shadows**: off by default. When on, every part casts and receives real shadows from the key light (useful for seeing one part's shadow fall on another in an assembly), and a soft shadow appears beneath the whole model on an otherwise-invisible ground plane — it only ever renders where an actual shadow lands, so it doesn't add a visible floor to your shot. Shadows carry into PNG exports too, composited correctly whether the background is a color or transparent.
- **Light softness** (next to Lighting intensity): 0 is a crisp, hard-edged shadow; higher values blur it into a soft penumbra. Only has a visible effect while Cast shadows is on (the row dims to signal that), and is included in the export label and Save/Load Settings.
- **Parts list**: every mesh part from the STEP file gets its own row (using the part's name from the file, or "Part N" if it has none). Hovering a part — in the 3D view or in the list — highlights it in both places (blue) and shows a tooltip. **Click** a part (in the 3D view or the list) to select it (amber highlight); **shift+click** in the 3D view hides it instead (e.g. to see what's hidden behind an enclosure). **Show all** brings every hidden part back.
- **Material**: **Plastic / Metal / Shiny / Matte** (physically-based metalness/roughness presets) apply to every part immediately on click — no extra step needed. Color works differently: pick one of the 6 swatches (3 accent colors, 3 greys) or type/pick an exact color via the hex field next to them; this only *previews* on the selected part (or does nothing if nothing's selected) until you click **Apply to Selected** or **Apply to All Parts**. Selecting a part syncs the hex field to show its current color as a starting point.
- **Lighting intensity** slider (in the Display section): raises or lowers the ambient/fill light uniformly across every material — useful for taming a too-contrasty Metal/Shiny look. Range 0–4×, in 0.01 steps, default 0.20×; 0 drops ambient/fill entirely (key light only), higher values fill in shadow areas more.
- **Light direction**: the key light is independent of the camera, so orbiting or switching views never changes how the model is lit. Reposition it by dragging the glowing marker in the 3D view directly — it orbits the model, arcball-style, following your cursor — or with the **Azimuth**/**Elevation** sliders, which stay in sync with the marker either way. The fill light automatically stays a softer light on the opposite side. **Reset Light** returns it to the default angle (matching the default front-left-top view). The marker itself never appears in a PNG export.
- **Download view as PNG**: **1×**/**2×**/**4×** buttons export exactly what's on screen as a PNG — including the current background (a solid color, or transparent if Background color is unchecked, so it drops cleanly onto slides/docs) — with a monospaced reference label burned into the lower-left corner — drawn as a flat 2D overlay after the render, so it's never part of the 3D scene, can't get occluded by the model, and always lands in the corner regardless of camera angle. The label has everything needed to recreate the look:
  - **Camera position / Camera angle**: where the camera is (X/Y/Z, in the model's own units) and which way it's facing — as azimuth/elevation/distance from whatever it's orbiting, not raw camera rotation, so it's directly usable in any other 3D software's own camera controls. Independent of model rotation (rotating the model never moves the camera) — "Model rotation" below it tracks that separately.
  - **Model rotation**: the Rotate Model X/Y/Z totals.
  - **Lighting**: the Lighting intensity slider value, plus the key light's current azimuth/elevation.
  - **Materials**: every currently-visible part's color + finish, grouped and counted (e.g. `17× Metal #e53935`) so it stays a short, readable list even on a model with thousands of parts — the 8 largest groups are shown, with a `+N more` line if there are more distinct combinations than that.
  
  2×/4× supersample (render at higher internal resolution, same framing) for sharper prints/large displays, without changing the live on-screen view. Rendered in small tiles internally (via a separate offscreen renderer) rather than one giant frame, since large framebuffers (tens of megapixels, as 4× needs) can silently corrupt on some GPUs well under their advertised limits — tiling keeps every individual render comfortably within any GPU's limits.

- **Save Settings / Load Settings**: exports everything above (camera position/angle, model rotation, projection mode, lighting, edges/wireframe/shadows toggles, background color, and every part's visibility/color/finish) to a `.json` file, and re-applies a previously saved file. Loading onto the *same* model reproduces the look exactly; loading onto a *different* model matches parts by name where the new model has matching part names, falling back to matching by position in the parts list otherwise — so per-part color/visibility may not map cleanly onto a model with a very different part structure, while camera, rotation, lighting, and display toggles always carry over.

## How it works

- Geometry parsing: [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCASCADE compiled to WASM), running in a Web Worker so multi-megabyte files don't freeze the UI.
- Rendering: [three.js](https://threejs.org/) with OrbitControls.
- All libraries are vendored locally in `vendor/` (three.js r138.3, OrbitControls, occt-import-js 0.0.23) so the viewer works fully offline once the folder is on disk — no CDN calls at runtime.

## Files

- `index.html` - page layout and styling
- `app.js` - scene setup, STEP loading, view presets, mesh building
- `vendor/` - vendored three.js, OrbitControls, and occt-import-js (JS + WASM)
- `test models/` - sample STEP files for testing
