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

- A procedural test cube loads by default so there's always something on screen to try the controls on. Drag a `.step`/`.stp` file onto the drop zone (or click it to browse) to replace it — the swap is instant, no bundled file involved.
- Every sidebar section collapses — click its header to fold it away. **Collapse all**/**Expand all** next to the title does it for every section at once (the label flips depending on whether anything's still open). Collapsed state is remembered per browser (via `localStorage`), so your layout persists across reloads.
- Large files (the bundled `test models/` are 18-25 MB) can take anywhere from several seconds to around a minute to parse — parsing runs in a background Web Worker so the page stays responsive while it works.
- Once loaded, use the sidebar buttons to jump to a preset view:
  - **Isometric views**: Front-Right-Top, Front-Left-Top, Back-Right-Top, Back-Left-Top (true 35.26° isometric corners)
  - **Axis-aligned views**: Front, Back, Left, Right, Top, Bottom
  - **Fit & Reset View**: reframes and returns to the default isometric view
- Orbit/pan/zoom freely with the mouse (drag to orbit, scroll to zoom, right-drag to pan) between preset clicks.
- **Rotate model**: spins the model itself, in place around its own center, ±7.5° per click about the STEP file's world X/Y/Z axes — the camera doesn't move. 24 clicks on one axis = full 180°, e.g. to see the underside of a part while keeping the same camera angle. The number field between the buttons shows the running total for that axis and is itself editable — type an angle and press Enter/tab away to jump straight there. **Reset Rotation** clears it (and the fields) back to how the file was loaded.
- **Parallel projection** (in the View section): switches to an orthographic camera, so parallel edges on the model stay parallel on screen instead of converging toward a vanishing point. Your current view angle carries over when toggling.
- Toggle **Show edges** and **Wireframe** in the Display section.
- **Parts list**: every mesh part from the STEP file gets its own row (using the part's name from the file, or "Part N" if it has none). Hovering a part — in the 3D view or in the list — highlights it in both places (blue) and shows a tooltip. **Click** a part (in the 3D view or the list) to select it (amber highlight); **shift+click** in the 3D view hides it instead (e.g. to see what's hidden behind an enclosure). **Show all** brings every hidden part back.
- **Material**: pick a finish (Plastic, Metal, Shiny, Matte — these set physically-based metalness/roughness) and/or one of 16 colors, or dial in an exact color with the **Hue / Saturation / Brightness** sliders below the swatches. Selecting a part syncs the sliders to show that part's current color as a starting point; dragging a slider (or clicking a swatch) previews live on the selected part immediately. **With nothing selected, the HSB sliders instead recolor the whole model live** — the finish buttons and color swatches still require an explicit **Apply to All Parts** click. **Apply to Selected** (re)applies your current finish/color pick to the selected part; **Apply to All Parts** applies it to the entire model.
- **Lighting intensity** slider (in the Display section): raises or lowers the ambient/fill light uniformly across every material — useful for taming a too-contrasty Metal/Shiny look. Range 0–4×, in 0.01 steps, default 0.20×; 0 drops ambient/fill entirely (key light only), higher values fill in shadow areas more.
- **Light direction**: the key light is independent of the camera, so orbiting or switching views never changes how the model is lit. Reposition it by dragging the glowing marker in the 3D view directly — it orbits the model, arcball-style, following your cursor — or with the **Azimuth**/**Elevation** sliders, which stay in sync with the marker either way. The fill light automatically stays a softer light on the opposite side. **Reset Light** returns it to the default angle (matching the default front-left-top view). The marker itself never appears in a PNG export.
- **Download view as PNG**: **1×**/**2×**/**4×** buttons export exactly what's on screen as a PNG with a transparent background (so it drops cleanly onto slides/docs), with a monospaced reference label burned into the lower-left corner — drawn as a flat 2D overlay after the render, so it's never part of the 3D scene, can't get occluded by the model, and always lands in the corner regardless of camera angle. The label has everything needed to recreate the look:
  - **Camera position / Camera angle**: where the camera is and which way it's facing. Independent of model rotation (rotating the model never moves the camera), so "Camera angle" can legitimately read 0/0/0 in an on-axis view like Top even while "Model rotation" below it shows a real value.
  - **Model rotation**: the Rotate Model X/Y/Z totals.
  - **Lighting**: the Lighting intensity slider value, plus the key light's current azimuth/elevation.
  - **Materials**: every currently-visible part's color + finish, grouped and counted (e.g. `17× Metal #e53935`) so it stays a short, readable list even on a model with thousands of parts — the 8 largest groups are shown, with a `+N more` line if there are more distinct combinations than that.
  
  2×/4× supersample (render at higher internal resolution, same framing) for sharper prints/large displays, without changing the live on-screen view. Rendered in small tiles internally (via a separate offscreen renderer) rather than one giant frame, since large framebuffers (tens of megapixels, as 4× needs) can silently corrupt on some GPUs well under their advertised limits — tiling keeps every individual render comfortably within any GPU's limits.

- **Save Settings / Load Settings**: exports everything above (camera position/angle, model rotation, projection mode, lighting, edges/wireframe toggles, and every part's visibility/color/finish) to a `.json` file, and re-applies a previously saved file. Loading onto the *same* model reproduces the look exactly; loading onto a *different* model matches parts by name where the new model has matching part names, falling back to matching by position in the parts list otherwise — so per-part color/visibility may not map cleanly onto a model with a very different part structure, while camera, rotation, lighting, and display toggles always carry over.

## How it works

- Geometry parsing: [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCASCADE compiled to WASM), running in a Web Worker so multi-megabyte files don't freeze the UI.
- Rendering: [three.js](https://threejs.org/) with OrbitControls.
- All libraries are vendored locally in `vendor/` (three.js r138.3, OrbitControls, occt-import-js 0.0.23) so the viewer works fully offline once the folder is on disk — no CDN calls at runtime.

## Files

- `index.html` - page layout and styling
- `app.js` - scene setup, STEP loading, view presets, mesh building
- `vendor/` - vendored three.js, OrbitControls, and occt-import-js (JS + WASM)
- `test models/` - sample STEP files for testing
