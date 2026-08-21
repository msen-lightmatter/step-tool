// STEP file viewer: three.js rendering + occt-import-js (WASM) parsing via Worker.

const sidebarEl = document.getElementById('sidebar');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileNameEl = document.getElementById('file-name');
const statusEl = document.getElementById('status');
const modelInfoEl = document.getElementById('model-info');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const toggleEdgesEl = document.getElementById('toggle-edges');
const toggleWireframeEl = document.getElementById('toggle-wireframe');
const toggleOrthoEl = document.getElementById('toggle-ortho');
const resetFitBtn = document.getElementById('reset-fit');
const resetRotationBtn = document.getElementById('reset-rotation');
const viewport = document.getElementById('viewport');
const partsSection = document.getElementById('parts-section');
const partsSep = document.getElementById('parts-sep');
const partsListEl = document.getElementById('parts-list');
const showAllPartsBtn = document.getElementById('show-all-parts');
const tooltipEl = document.getElementById('part-tooltip');
const colorGridEl = document.getElementById('color-grid');
const selectedPartLabelEl = document.getElementById('selected-part-label');
const applySelectedBtn = document.getElementById('apply-selected');
const applyAllBtn = document.getElementById('apply-all');
const exposureSlider = document.getElementById('exposure-slider');
const exposureValueEl = document.getElementById('exposure-value');
const hueSlider = document.getElementById('hue-slider');
const hueValueEl = document.getElementById('hue-value');
const saturationSlider = document.getElementById('saturation-slider');
const saturationValueEl = document.getElementById('saturation-value');
const brightnessSlider = document.getElementById('brightness-slider');
const brightnessValueEl = document.getElementById('brightness-value');

// ---------- three.js scene setup ----------

// alpha + preserveDrawingBuffer are needed so the PNG export below can read
// back a transparent-background frame from this same canvas/context.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setClearColor(0x1b1d21);
// MeshStandardMaterial (used for metalness/roughness) needs these to render
// with correct contrast/saturation — without them PBR materials look washed out.
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9; // also adjustable live via the Lighting Intensity slider
viewport.insertBefore(renderer.domElement, viewport.firstChild);

const scene = new THREE.Scene();

const perspCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e7);
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e7);
perspCamera.up.set(0, 0, 1); // STEP files are Z-up by convention
orthoCamera.up.set(0, 0, 1);

let camera = perspCamera;

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

// HemisphereLight gives PBR (MeshStandardMaterial) surfaces a natural-looking
// ambient gradient; a flat AmbientLight washes metalness/roughness out badly.
// These are the "1.00x" reference points for the Lighting Intensity slider,
// which scales hemi+fill together — raising the shadow floor to cut contrast
// (unlike tone-mapping exposure, which scales everything equally and barely
// changes the *relative* contrast between a bright highlight and a dark area).
const BASE_HEMI_INTENSITY = 0.55;
const BASE_FILL_INTENSITY = 0.45;

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x2b2d33, BASE_HEMI_INTENSITY);
scene.add(hemiLight);

// DirectionalLight aims at .target, which defaults to world origin (0,0,0)
// and — unlike position — isn't picked up unless it's also in the scene
// graph. Without this, a STEP file whose centroid isn't near the origin
// (most of them) gets a "headlight" aimed at empty space near the model
// rather than at the model itself, and how well-lit it looks swings
// unpredictably with view angle instead of staying consistent.
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
scene.add(keyLight);
scene.add(keyLight.target);

const fillLight = new THREE.DirectionalLight(0xffffff, BASE_FILL_INTENSITY);
scene.add(fillLight);
scene.add(fillLight.target);

const grid = new THREE.GridHelper(1000, 20, 0x444444, 0x2c2e33);
grid.rotation.x = Math.PI / 2; // lie flat in the XY plane (Z-up)
grid.visible = false;
scene.add(grid);

const modelRoot = new THREE.Object3D();
scene.add(modelRoot);

// Manual rotation (X/Y/Z buttons) is applied here. Its position is kept at
// modelCenter and its child's local position offset by -modelCenter (done once
// per load, in fitCameraToModel), so world-axis rotations pivot around the
// model's own centroid instead of swinging around the STEP file's raw origin.
const flipGroup = new THREE.Object3D();
modelRoot.add(flipGroup);

let modelRadius = 100; // fallback until a model is loaded
let modelCenter = new THREE.Vector3(0, 0, 0);

// ---------- part picking (hover highlight, click-to-select, shift+click-to-hide) ----------

const raycaster = new THREE.Raycaster();
let pointerNDC = null; // {x,y} in [-1,1], null when the mouse isn't over the canvas
let currentGroup = null; // the flat THREE.Group holding this load's part meshes
let hoveredMesh = null;
let selectedMesh = null;
const HOVER_EMISSIVE = 0x3b6fff;
const SELECT_EMISSIVE = 0xffb020;
const HIGHLIGHT_EMISSIVE_INTENSITY = 0.35; // tint, not overwrite — keep the true material visible underneath

function partDisplayName(mesh) {
  const n = mesh.userData.partIndex + 1;
  return mesh.name && mesh.name.trim() ? `${n}. ${mesh.name.trim()}` : `Part ${n}`;
}

function meshMaterials(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

// Emissive shows hover (blue) if hovered, else selection (amber) if selected, else off.
function refreshMeshEmissive(mesh) {
  if (!mesh) return;
  const hex = mesh === hoveredMesh ? HOVER_EMISSIVE : mesh === selectedMesh ? SELECT_EMISSIVE : 0x000000;
  meshMaterials(mesh).forEach((m) => m.emissive.setHex(hex));
  if (mesh.userData.rowEl) {
    mesh.userData.rowEl.classList.toggle('hovered', mesh === hoveredMesh);
    mesh.userData.rowEl.classList.toggle('selected', mesh === selectedMesh);
  }
}

function getPickableMeshes() {
  return currentGroup ? currentGroup.children.filter((c) => c.isMesh && c.visible) : [];
}

function getPickableMeshesIncludingHidden() {
  return currentGroup ? currentGroup.children.filter((c) => c.isMesh) : [];
}

function setHoveredMesh(mesh) {
  if (mesh === hoveredMesh) return;
  const prev = hoveredMesh;
  hoveredMesh = mesh;
  if (prev) refreshMeshEmissive(prev);
  if (hoveredMesh) refreshMeshEmissive(hoveredMesh);
}

function setSelectedMesh(mesh) {
  if (mesh === selectedMesh) return;
  const prev = selectedMesh;
  selectedMesh = mesh;
  if (prev) refreshMeshEmissive(prev);
  if (selectedMesh) refreshMeshEmissive(selectedMesh);
  updateSelectedPartLabel();
  // Show the newly-selected part's actual current color as the sliders'
  // starting point — a display sync only, doesn't touch pendingColorHex.
  if (selectedMesh) syncSlidersToColor(meshMaterials(selectedMesh)[0].color.getHex());
}

function updateHoverPick() {
  if (!pointerNDC || !currentGroup) {
    setHoveredMesh(null);
    tooltipEl.style.display = 'none';
    return;
  }
  raycaster.setFromCamera(pointerNDC, camera);
  const targets = getPickableMeshes();
  const hit = targets.length ? raycaster.intersectObjects(targets, false)[0] : undefined;
  setHoveredMesh(hit ? hit.object : null);
  if (hoveredMesh) {
    tooltipEl.textContent = `${partDisplayName(hoveredMesh)} — click to select, shift+click to hide`;
    tooltipEl.style.display = 'block';
  } else {
    tooltipEl.style.display = 'none';
  }
}

function setPartVisible(mesh, visible) {
  mesh.visible = visible;
  if (mesh.userData.edges) mesh.userData.edges.visible = visible && toggleEdgesEl.checked;
  if (mesh.userData.checkboxEl) mesh.userData.checkboxEl.checked = visible;
  if (mesh.userData.rowEl) mesh.userData.rowEl.classList.toggle('hidden-part', !visible);
  if (!visible && mesh === hoveredMesh) setHoveredMesh(null);
  if (!visible && mesh === selectedMesh) setSelectedMesh(null);
}

function clearPartsList() {
  partsListEl.innerHTML = '';
  partsSection.style.display = 'none';
  partsSep.style.display = 'none';
  currentGroup = null;
  hoveredMesh = null;
  selectedMesh = null;
  tooltipEl.style.display = 'none';
  tooltipEl.textContent = '';
  updateSelectedPartLabel();
}

function buildPartsList(meshes) {
  partsListEl.innerHTML = '';
  meshes.forEach((mesh, i) => {
    mesh.userData.partIndex = i;

    const row = document.createElement('div');
    row.className = 'part-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.addEventListener('change', () => setPartVisible(mesh, checkbox.checked));

    const label = document.createElement('span');
    label.className = 'part-name';
    label.textContent = partDisplayName(mesh);

    row.appendChild(checkbox);
    row.appendChild(label);
    row.addEventListener('mouseenter', () => setHoveredMesh(mesh));
    row.addEventListener('mouseleave', () => {
      if (hoveredMesh === mesh) setHoveredMesh(null);
    });
    row.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      setSelectedMesh(selectedMesh === mesh ? null : mesh);
    });

    mesh.userData.rowEl = row;
    mesh.userData.checkboxEl = checkbox;
    partsListEl.appendChild(row);
  });

  partsSection.style.display = meshes.length ? 'block' : 'none';
  partsSep.style.display = meshes.length ? 'block' : 'none';
}

showAllPartsBtn.addEventListener('click', () => {
  getPickableMeshesIncludingHidden().forEach((mesh) => setPartVisible(mesh, true));
});

renderer.domElement.addEventListener('pointermove', (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC = {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
  };
  tooltipEl.style.left = `${e.clientX - rect.left}px`;
  tooltipEl.style.top = `${e.clientY - rect.top}px`;
});

renderer.domElement.addEventListener('pointerleave', () => {
  pointerNDC = null;
});

// A fresh raycast at the exact click point, rather than trusting the
// render-loop-cached hoveredMesh — pointerdown/pointerup can both fire
// before the next animation frame gets a chance to update it.
function pickMeshAtClient(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
  raycaster.setFromCamera(ndc, camera);
  const targets = getPickableMeshes();
  const hit = targets.length ? raycaster.intersectObjects(targets, false)[0] : undefined;
  return hit ? hit.object : null;
}

let pointerDownPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY, button: e.button, shiftKey: e.shiftKey };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  const wasClick = pointerDownPos.button === 0 && Math.hypot(dx, dy) < 4;
  const wasShiftClick = wasClick && pointerDownPos.shiftKey;
  pointerDownPos = null;
  if (!wasClick) return;
  const picked = pickMeshAtClient(e.clientX, e.clientY);
  if (wasShiftClick && picked) {
    setPartVisible(picked, false);
  } else {
    setSelectedMesh(picked);
  }
});

// ---------- material & color ----------

// Metal deliberately stops short of metalness 1.0: a fully metallic surface
// has zero diffuse response, so it only ever shows a hard direct-light
// specular streak against near-black everywhere else — no amount of ambient
// light or exposure tuning can soften that. 0.82 keeps a clearly metallic
// look while leaving enough diffuse response for ambient/fill light to matter.
const FINISH_PRESETS = {
  plastic: { metalness: 0.0, roughness: 0.45 },
  metal: { metalness: 0.82, roughness: 0.42 },
  shiny: { metalness: 0.5, roughness: 0.06 },
  matte: { metalness: 0.0, roughness: 0.95 },
};
const DEFAULT_FINISH = { metalness: 0.05, roughness: 0.55 };

const COLOR_PALETTE = [
  '#e53935', '#fb8c00', '#fdd835', '#7cb342',
  '#00897b', '#29b6f6', '#1e88e5', '#5e35b1',
  '#d81b60', '#6d4c41', '#9e9e9e', '#455a64',
  '#000000', '#ffffff', '#c0c0c0', '#d4af37',
];

let pendingFinish = null; // key into FINISH_PRESETS, chosen but not necessarily applied yet
let pendingColorHex = null; // number (0xRRGGBB), same

function applyFinishToMesh(mesh, finishKey) {
  const preset = FINISH_PRESETS[finishKey];
  if (!preset) return;
  meshMaterials(mesh).forEach((m) => {
    m.metalness = preset.metalness;
    m.roughness = preset.roughness;
  });
}

function applyColorToMesh(mesh, hex) {
  meshMaterials(mesh).forEach((m) => m.color.setHex(hex));
}

function applyPendingToMesh(mesh) {
  if (pendingFinish) applyFinishToMesh(mesh, pendingFinish);
  if (pendingColorHex !== null) applyColorToMesh(mesh, pendingColorHex);
}

function updateSelectedPartLabel() {
  selectedPartLabelEl.textContent = selectedMesh
    ? `Selected: ${partDisplayName(selectedMesh)}`
    : 'No part selected — click a part to select it';
  applySelectedBtn.disabled = !selectedMesh;
}

function updateApplyAllState() {
  applyAllBtn.disabled = !pendingFinish && pendingColorHex === null;
}

document.querySelectorAll('#finish-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    pendingFinish = btn.dataset.finish;
    document.querySelectorAll('#finish-grid .btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (selectedMesh) applyFinishToMesh(selectedMesh, pendingFinish);
    updateApplyAllState();
  });
});

function buildColorGrid() {
  COLOR_PALETTE.forEach((hex) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch';
    btn.style.background = hex;
    btn.title = hex;
    btn.addEventListener('click', () => {
      pendingColorHex = parseInt(hex.slice(1), 16);
      document.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('active', b === btn));
      syncSlidersToColor(pendingColorHex);
      if (selectedMesh) applyColorToMesh(selectedMesh, pendingColorHex);
      updateApplyAllState();
    });
    colorGridEl.appendChild(btn);
  });
}

applySelectedBtn.addEventListener('click', () => {
  if (selectedMesh) applyPendingToMesh(selectedMesh);
});

applyAllBtn.addEventListener('click', () => {
  getPickableMeshesIncludingHidden().forEach((mesh) => applyPendingToMesh(mesh));
});

// ---------- HSL sliders ----------

// Pure display sync — sets slider positions/readouts to match a color
// without touching pendingColorHex or applying anything. Used when a part
// is selected (to show its current color as a starting point) and when a
// swatch is clicked (to keep the sliders showing the same color).
function syncSlidersToColor(hex) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  hueSlider.value = Math.round(hsl.h * 360);
  saturationSlider.value = Math.round(hsl.s * 100);
  brightnessSlider.value = Math.round(hsl.l * 100);
  hueValueEl.textContent = `${hueSlider.value}°`;
  saturationValueEl.textContent = `${saturationSlider.value}%`;
  brightnessValueEl.textContent = `${brightnessSlider.value}%`;
}

// User is actively dragging a slider — compute the resulting color, make it
// the pending color, and preview it live: on the selection if one exists,
// otherwise on every part (so the sliders are never a no-op).
function applyHSLFromSliders() {
  const h = parseFloat(hueSlider.value) / 360;
  const s = parseFloat(saturationSlider.value) / 100;
  const l = parseFloat(brightnessSlider.value) / 100;
  hueValueEl.textContent = `${hueSlider.value}°`;
  saturationValueEl.textContent = `${saturationSlider.value}%`;
  brightnessValueEl.textContent = `${brightnessSlider.value}%`;

  const c = new THREE.Color();
  c.setHSL(h, s, l);
  pendingColorHex = c.getHex();
  document.querySelectorAll('.color-swatch').forEach((b) => b.classList.remove('active'));
  if (selectedMesh) {
    applyColorToMesh(selectedMesh, pendingColorHex);
  } else {
    getPickableMeshesIncludingHidden().forEach((mesh) => applyColorToMesh(mesh, pendingColorHex));
  }
  updateApplyAllState();
}
[hueSlider, saturationSlider, brightnessSlider].forEach((slider) => {
  slider.addEventListener('input', applyHSLFromSliders);
});

function updateCameraProjection() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  const aspect = w / h;
  if (camera.isOrthographicCamera) {
    const halfHeight = modelRadius * 1.15;
    const halfWidth = halfHeight * aspect;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

function resizeRenderer() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  updateCameraProjection();
}
window.addEventListener('resize', resizeRenderer);
resizeRenderer();

function updateKeyLights() {
  const target = controls.target;
  keyLight.position.copy(camera.position);
  keyLight.target.position.copy(target);
  // Mirrored through the target (not the world origin) so it lands on the
  // opposite side of the model, not the opposite side of empty space.
  fillLight.position.set(2 * target.x - camera.position.x, 2 * target.y - camera.position.y, camera.position.z);
  fillLight.target.position.copy(target);
}

renderer.setAnimationLoop(() => {
  controls.update();
  updateKeyLights();
  updateHoverPick();
  renderer.render(scene, camera);
});

// ---------- view presets ----------

// Direction vectors are in Z-up object space, pointing FROM the model TOWARD the camera.
const VIEW_PRESETS = {
  'front':   { dir: [0, -1, 0], up: [0, 0, 1] },
  'back':    { dir: [0, 1, 0],  up: [0, 0, 1] },
  'left':    { dir: [-1, 0, 0], up: [0, 0, 1] },
  'right':   { dir: [1, 0, 0],  up: [0, 0, 1] },
  'top':     { dir: [0, 0, 1],  up: [0, 1, 0] },
  'bottom':  { dir: [0, 0, -1], up: [0, 1, 0] },
  'iso-frt': { dir: [1, -1, 1],  up: [0, 0, 1] }, // front-right-top
  'iso-flt': { dir: [-1, -1, 1], up: [0, 0, 1] }, // front-left-top
  'iso-brt': { dir: [1, 1, 1],   up: [0, 0, 1] }, // back-right-top
  'iso-blt': { dir: [-1, 1, 1],  up: [0, 0, 1] }, // back-left-top
};

function applyView(name) {
  const preset = VIEW_PRESETS[name];
  if (!preset) return;
  const dir = new THREE.Vector3(...preset.dir).normalize();
  camera.up.set(...preset.up);
  if (camera.isOrthographicCamera) {
    const dist = modelRadius * 3 + 10;
    camera.position.copy(modelCenter).addScaledVector(dir, dist);
    camera.zoom = 1;
    updateCameraProjection();
  } else {
    const fitDistance = modelRadius / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.15;
    camera.position.copy(modelCenter).addScaledVector(dir, fitDistance);
  }
  controls.target.copy(modelCenter);
  camera.lookAt(modelCenter);
  controls.update();
}

document.querySelectorAll('#iso-grid .btn, #ortho-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => applyView(btn.dataset.view));
});

resetFitBtn.addEventListener('click', () => applyView('iso-frt'));

// Rotates the model itself (not the camera) around a fixed world axis,
// pivoting on the model's own center. The camera/view stays exactly where
// it is, so e.g. rotating 180° about X flips top<->bottom in place.
const ROTATE_AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

function rotateModel(axisName, degrees) {
  const axis = ROTATE_AXES[axisName];
  if (!axis) return;
  flipGroup.rotateOnWorldAxis(axis, (degrees * Math.PI) / 180);
}

// Running per-axis totals shown in the editable angle fields. These are just
// an odometer of applied deltas (world-axis rotations don't commute, so this
// isn't a true decomposition of the model's orientation) — but since every
// change here IS applied as a relative delta in whatever order the user
// requests, the totals stay a faithful, useful "how far have I turned this
// axis" readout.
const rotationTotals = { x: 0, y: 0, z: 0 };
const angleInputs = {};
document.querySelectorAll('.angle-input').forEach((input) => {
  angleInputs[input.dataset.axis] = input;
});

function roundClean(n) {
  return Math.round(n * 100) / 100; // trims float noise like 7.499999999998
}

function applyRotationDelta(axisName, deltaDeg) {
  rotateModel(axisName, deltaDeg);
  rotationTotals[axisName] = roundClean(rotationTotals[axisName] + deltaDeg);
  if (angleInputs[axisName]) angleInputs[axisName].value = rotationTotals[axisName];
}

function resetRotationTotals() {
  ['x', 'y', 'z'].forEach((axisName) => {
    rotationTotals[axisName] = 0;
    if (angleInputs[axisName]) angleInputs[axisName].value = 0;
  });
}

document.querySelectorAll('#rotate-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => applyRotationDelta(btn.dataset.axis, parseFloat(btn.dataset.deg)));
});

Object.values(angleInputs).forEach((input) => {
  input.addEventListener('change', () => {
    const axisName = input.dataset.axis;
    const newVal = parseFloat(input.value);
    if (Number.isNaN(newVal)) {
      input.value = rotationTotals[axisName];
      return;
    }
    applyRotationDelta(axisName, newVal - rotationTotals[axisName]);
  });
});

resetRotationBtn.addEventListener('click', () => {
  flipGroup.quaternion.identity();
  resetRotationTotals();
});

function setProjectionMode(useOrthographic) {
  const wantOrtho = !!useOrthographic;
  if (wantOrtho === camera.isOrthographicCamera) return;

  const target = controls.target.clone();
  const dir = camera.position.clone().sub(target).normalize();
  const up = camera.up.clone();

  camera = wantOrtho ? orthoCamera : perspCamera;
  camera.up.copy(up);

  if (wantOrtho) {
    const dist = modelRadius * 3 + 10;
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.zoom = 1;
  } else {
    const fitDistance = modelRadius / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.15;
    camera.position.copy(target).addScaledVector(dir, fitDistance);
  }

  camera.lookAt(target);
  controls.object = camera;
  controls.target.copy(target);
  updateCameraProjection();
  controls.update();
}

toggleOrthoEl.addEventListener('change', () => setProjectionMode(toggleOrthoEl.checked));

// ---------- STEP loading (Web Worker) ----------

let worker = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.add('visible');
}

function hideLoading() {
  loadingOverlay.classList.remove('visible');
}

function clearModel() {
  while (flipGroup.children.length > 0) {
    const child = flipGroup.children.pop();
    child.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
  flipGroup.position.set(0, 0, 0);
  flipGroup.quaternion.identity();
  resetRotationTotals();
  clearPartsList();
}

function loadStepFile(file) {
  fileNameEl.textContent = file.name;
  showLoading(`Parsing ${file.name}...`);
  setStatus('Reading file...');

  const reader = new FileReader();
  reader.onload = () => {
    const buffer = new Uint8Array(reader.result);
    setStatus('Parsing geometry (this can take a while for large files)...');

    if (worker) worker.terminate();
    worker = new Worker('vendor/occt-import-js-worker.js');
    worker.onmessage = (ev) => {
      onStepParsed(ev.data, file);
      worker.terminate();
      worker = null;
    };
    worker.onerror = (err) => {
      console.error(err);
      hideLoading();
      setStatus('Error parsing STEP file. See console for details.');
      worker.terminate();
      worker = null;
    };
    worker.postMessage({ format: 'step', buffer, params: null });
  };
  reader.onerror = () => {
    hideLoading();
    setStatus('Error reading file from disk.');
  };
  reader.readAsArrayBuffer(file);
}

function onStepParsed(result, file) {
  hideLoading();
  if (!result || !result.success) {
    setStatus('Failed to parse STEP file.');
    modelInfoEl.textContent = '';
    return;
  }

  clearModel();

  const group = new THREE.Group();
  const meshList = [];
  let triangleCount = 0;
  for (const resultMesh of result.meshes) {
    const { mesh, edges } = buildMesh(resultMesh, toggleEdgesEl.checked);
    mesh.visible = true;
    mesh.userData.edges = edges || null;
    group.add(mesh);
    if (edges) group.add(edges);
    meshList.push(mesh);
    triangleCount += resultMesh.index.array.length / 3;
  }
  flipGroup.add(group);
  currentGroup = group;
  buildPartsList(meshList);

  fitCameraToModel();
  applyView('iso-frt');

  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  modelInfoEl.innerHTML =
    `<div><b>${escapeHtml(file.name)}</b></div>` +
    `<div>${result.meshes.length} mesh part(s)</div>` +
    `<div>${triangleCount.toLocaleString()} triangles</div>` +
    `<div>${sizeMb} MB on disk</div>`;
  setStatus('Ready.');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function fitCameraToModel() {
  const box = new THREE.Box3().setFromObject(modelRoot);
  if (box.isEmpty()) {
    modelRadius = 100;
    modelCenter.set(0, 0, 0);
    return;
  }
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  modelCenter.copy(sphere.center);
  modelRadius = Math.max(sphere.radius, 1e-3);

  // Re-center: shift the loaded geometry so it sits at flipGroup's own local
  // origin, then move flipGroup to modelCenter. World position is unchanged,
  // but flipGroup's origin (what rotateOnWorldAxis pivots around) now
  // coincides with the model's centroid instead of the STEP file's raw origin.
  flipGroup.children.forEach((child) => child.position.sub(modelCenter));
  flipGroup.position.copy(modelCenter);

  perspCamera.near = modelRadius / 1000;
  perspCamera.far = modelRadius * 1000;
  orthoCamera.near = modelRadius / 1000;
  orthoCamera.far = modelRadius * 1000;
  updateCameraProjection();

  grid.scale.setScalar(modelRadius / 500);
  grid.position.set(modelCenter.x, modelCenter.y, box.min.z);
}

// Adapted from occt-import-js's official three.js example.
function buildMesh(geometryMesh, showEdges) {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(geometryMesh.attributes.position.array, 3));
  if (geometryMesh.attributes.normal) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(geometryMesh.attributes.normal.array, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.name = geometryMesh.name;
  const index = Uint32Array.from(geometryMesh.index.array);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  const defaultMaterial = new THREE.MeshStandardMaterial({
    color: geometryMesh.color
      ? new THREE.Color(geometryMesh.color[0], geometryMesh.color[1], geometryMesh.color[2])
      : 0xb0b3b8,
    metalness: DEFAULT_FINISH.metalness,
    roughness: DEFAULT_FINISH.roughness,
    emissiveIntensity: HIGHLIGHT_EMISSIVE_INTENSITY,
    side: THREE.DoubleSide,
  });

  let materials = [defaultMaterial];
  const edges = showEdges ? new THREE.Group() : null;

  if (geometryMesh.brep_faces && geometryMesh.brep_faces.length > 0) {
    for (const faceColor of geometryMesh.brep_faces) {
      const color = faceColor.color
        ? new THREE.Color(faceColor.color[0], faceColor.color[1], faceColor.color[2])
        : defaultMaterial.color;
      materials.push(
        new THREE.MeshStandardMaterial({
          color,
          emissiveIntensity: HIGHLIGHT_EMISSIVE_INTENSITY,
          metalness: DEFAULT_FINISH.metalness,
          roughness: DEFAULT_FINISH.roughness,
          side: THREE.DoubleSide,
        })
      );
    }
    const triangleCount = geometryMesh.index.array.length / 3;
    let triangleIndex = 0;
    let faceColorGroupIndex = 0;
    while (triangleIndex < triangleCount) {
      const firstIndex = triangleIndex;
      let lastIndex = null;
      let materialIndex = null;
      if (faceColorGroupIndex >= geometryMesh.brep_faces.length) {
        lastIndex = triangleCount;
        materialIndex = 0;
      } else if (triangleIndex < geometryMesh.brep_faces[faceColorGroupIndex].first) {
        lastIndex = geometryMesh.brep_faces[faceColorGroupIndex].first;
        materialIndex = 0;
      } else {
        lastIndex = geometryMesh.brep_faces[faceColorGroupIndex].last + 1;
        materialIndex = faceColorGroupIndex + 1;
        faceColorGroupIndex++;
      }
      geometry.addGroup(firstIndex * 3, (lastIndex - firstIndex) * 3, materialIndex);
      triangleIndex = lastIndex;

      if (edges) {
        const innerGeometry = new THREE.BufferGeometry();
        innerGeometry.setAttribute('position', geometry.attributes.position);
        if (geometry.attributes.normal) innerGeometry.setAttribute('normal', geometry.attributes.normal);
        innerGeometry.setIndex(new THREE.BufferAttribute(index.slice(firstIndex * 3, lastIndex * 3), 1));
        const innerEdgesGeometry = new THREE.EdgesGeometry(innerGeometry, 25);
        const edge = new THREE.LineSegments(innerEdgesGeometry, outlineMaterial);
        edges.add(edge);
      }
    }
  } else if (edges) {
    const edgesGeometry = new THREE.EdgesGeometry(geometry, 25);
    edges.add(new THREE.LineSegments(edgesGeometry, outlineMaterial));
  }

  const mesh = new THREE.Mesh(geometry, materials.length > 1 ? materials : materials[0]);
  mesh.name = geometryMesh.name;
  if (edges) edges.renderOrder = mesh.renderOrder + 1;

  return { mesh, geometry, edges };
}

// ---------- PNG export ----------

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function getCameraInfoLines() {
  const p = camera.position;
  const r = camera.rotation;
  const toDeg = (rad) => ((rad * 180) / Math.PI).toFixed(1);
  return [
    `Camera position (mm)   X ${p.x.toFixed(1)}   Y ${p.y.toFixed(1)}   Z ${p.z.toFixed(1)}`,
    `Camera angle            X ${toDeg(r.x)}°   Y ${toDeg(r.y)}°   Z ${toDeg(r.z)}°`,
    // The camera never moves when you use Rotate Model (it spins the model
    // itself, in place) — so without this line the export would have no
    // record of that rotation at all, even though it changes what's shown.
    `Model rotation          X ${rotationTotals.x}°   Y ${rotationTotals.y}°   Z ${rotationTotals.z}°`,
  ];
}

// Matches a mesh's live metalness/roughness back to a finish name so the
// label reads "Metal", not "m0.82/r0.42" — falls back to the raw numbers for
// anything that doesn't line up with a preset (e.g. mid-drag HSB tweaks).
function getFinishLabel(metalness, roughness) {
  const eps = 0.02;
  for (const [name, preset] of Object.entries(FINISH_PRESETS)) {
    if (Math.abs(metalness - preset.metalness) < eps && Math.abs(roughness - preset.roughness) < eps) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  if (Math.abs(metalness - DEFAULT_FINISH.metalness) < eps && Math.abs(roughness - DEFAULT_FINISH.roughness) < eps) {
    return 'Default';
  }
  return `Custom (m${metalness.toFixed(2)}/r${roughness.toFixed(2)})`;
}

// Groups every currently-visible part by its exact (color, finish) so the
// label stays short and readable even on a model with thousands of parts —
// most of the time everything collapses to one or a handful of rows, which
// is exactly what you'd need to recreate the look.
const MATERIAL_SUMMARY_MAX_ROWS = 8;

function getMaterialSummaryLines() {
  const visibleMeshes = getPickableMeshes();
  if (visibleMeshes.length === 0) return [];

  const counts = new Map();
  visibleMeshes.forEach((mesh) => {
    const mat = meshMaterials(mesh)[0];
    const colorHex = `#${mat.color.getHexString()}`;
    const finishLabel = getFinishLabel(mat.metalness, mat.roughness);
    const key = `${colorHex}|${finishLabel}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { count: 1, colorHex, finishLabel });
  });

  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  const shown = sorted.slice(0, MATERIAL_SUMMARY_MAX_ROWS);
  const extra = sorted.length - shown.length;

  const countWidth = Math.max(...shown.map((e) => String(e.count).length));
  const finishWidth = Math.max(...shown.map((e) => e.finishLabel.length));
  const lines = [`Materials (${visibleMeshes.length} part${visibleMeshes.length === 1 ? '' : 's'})`];
  shown.forEach((e) => {
    const countStr = String(e.count).padStart(countWidth);
    const finishStr = e.finishLabel.padEnd(finishWidth);
    lines.push(`  ${countStr}×  ${finishStr}  ${e.colorHex}`);
  });
  if (extra > 0) lines.push(`  +${extra} more`);
  return lines;
}

function getExportLabelLines() {
  const exposureValue = parseFloat(exposureSlider.value).toFixed(2);
  return [...getCameraInfoLines(), `Lighting                ${exposureValue}×`, ...getMaterialSummaryLines()];
}

// Renders one sub-rectangle ("tile") of the full target image using
// camera.setViewOffset (the caller sets/clears the offset), reads it back,
// and copies it — flipped to top-down and with alpha un-premultiplied —
// into the right spot of the full-image pixel buffer.
function renderTileIntoBuffer(offRenderer, tileW, tileH, tileX, tileY, fullW, target) {
  offRenderer.setSize(tileW, tileH, false);
  offRenderer.render(scene, camera);

  const gl = offRenderer.getContext();
  const raw = new Uint8Array(tileW * tileH * 4);
  gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, raw);

  const rowBytes = tileW * 4;
  for (let ty = 0; ty < tileH; ty++) {
    const srcRow = ty * rowBytes; // GL rows are bottom-up
    const fullRow = tileY + (tileH - 1 - ty); // top-down row in the full image
    const dstRowStart = fullRow * fullW * 4 + tileX * 4;
    for (let tx = 0; tx < tileW; tx++) {
      const si = srcRow + tx * 4;
      const di = dstRowStart + tx * 4;
      const a = raw[si + 3];
      if (a > 0 && a < 255) {
        const f = 255 / a;
        target[di] = raw[si] * f;
        target[di + 1] = raw[si + 1] * f;
        target[di + 2] = raw[si + 2] * f;
      } else {
        target[di] = raw[si];
        target[di + 1] = raw[si + 1];
        target[di + 2] = raw[si + 2];
      }
      target[di + 3] = a;
    }
  }
}

// Large WebGL framebuffers (tens of megapixels, as 3x-4x supersampled export
// needs) silently corrupt on many GPU/browser combos — no WebGL error, just
// wrong pixels — well below gl.MAX_TEXTURE_SIZE/MAX_RENDERBUFFER_SIZE (this
// was found empirically: worked fine under ~58 megapixels, broke above it on
// the machine this was built on, and that ceiling isn't reliably predictable
// across GPUs). Rendering in small tiles via camera.setViewOffset keeps every
// individual render comfortably within any GPU's limits regardless of the
// final image size, so this works reliably no matter how high `scale` goes.
const EXPORT_TILE_SIZE = 2048;

function downloadViewAsPng(scale = 1) {
  const basePixelRatio = renderer.getPixelRatio();
  const dpr = basePixelRatio * scale;
  const w = Math.round(viewport.clientWidth * dpr);
  const h = Math.round(viewport.clientHeight * dpr);

  const offCanvas = document.createElement('canvas');
  const offRenderer = new THREE.WebGLRenderer({
    canvas: offCanvas,
    antialias: false, // supersampling itself smooths edges at this resolution
    alpha: true,
    preserveDrawingBuffer: true,
  });
  offRenderer.outputEncoding = THREE.sRGBEncoding;
  offRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  offRenderer.toneMappingExposure = renderer.toneMappingExposure;
  offRenderer.setPixelRatio(1);
  offRenderer.setClearColor(0x000000, 0);

  const flipped = new Uint8ClampedArray(w * h * 4);
  const cols = Math.ceil(w / EXPORT_TILE_SIZE);
  const rows = Math.ceil(h / EXPORT_TILE_SIZE);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const tileX = rx * EXPORT_TILE_SIZE;
      const tileY = ry * EXPORT_TILE_SIZE;
      const tileW = Math.min(EXPORT_TILE_SIZE, w - tileX);
      const tileH = Math.min(EXPORT_TILE_SIZE, h - tileY);
      camera.setViewOffset(w, h, tileX, tileY, tileW, tileH);
      renderTileIntoBuffer(offRenderer, tileW, tileH, tileX, tileY, w, flipped);
    }
  }
  camera.clearViewOffset();
  offRenderer.dispose();

  // The camera-info text below is drawn as a flat 2D overlay on this plain
  // canvas, never as an object inside the 3D scene, so it can never land "on"
  // the model or get occluded/lit by it.
  const composed = document.createElement('canvas');
  composed.width = w;
  composed.height = h;
  const ctx = composed.getContext('2d');
  ctx.putImageData(new ImageData(flipped, w, h), 0, 0);

  const lines = getExportLabelLines();
  const fontSize = Math.round(12 * dpr);
  const lineHeight = Math.round(fontSize * 1.6);
  const padX = Math.round(10 * dpr);
  const padY = Math.round(8 * dpr);
  const margin = Math.round(16 * dpr);

  // Monospace so the columns of numbers/labels actually line up — this is a
  // technical readout meant to be read precisely, not display copy.
  ctx.font = `${fontSize}px "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;
  ctx.textBaseline = 'top';
  const boxWidth = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const boxHeight = lineHeight * lines.length + padY * 2 - (lineHeight - fontSize);
  const boxX = margin;
  const boxY = h - margin - boxHeight;

  ctx.fillStyle = 'rgba(20, 21, 24, 0.78)';
  roundRectPath(ctx, boxX, boxY, boxWidth, boxHeight, Math.round(6 * dpr));
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => {
    ctx.fillText(line, boxX + padX, boxY + padY + i * lineHeight);
  });

  composed.toBlob((blob) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const scaleTag = scale !== 1 ? `-${scale}x` : '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `step-view${scaleTag}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

document.querySelectorAll('#png-scale-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => downloadViewAsPng(parseFloat(btn.dataset.scale)));
});

// ---------- UI wiring ----------

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) loadStepFile(e.target.files[0]);
});

['dragenter', 'dragover'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadStepFile(file);
});

toggleWireframeEl.addEventListener('change', () => {
  modelRoot.traverse((obj) => {
    if (obj.isMesh) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => (m.wireframe = toggleWireframeEl.checked));
    }
  });
});

toggleEdgesEl.addEventListener('change', () => {
  getPickableMeshesIncludingHidden().forEach((mesh) => {
    if (mesh.userData.edges) mesh.userData.edges.visible = toggleEdgesEl.checked && mesh.visible;
  });
});

// Scales ambient (hemisphere) + fill light together — raising the shadow
// floor is what actually cuts contrast for metal/shiny finishes. The key
// light and exposure are left alone; this only affects every material
// uniformly without touching each part's individually-chosen finish.
function applyLightingIntensity(v) {
  hemiLight.intensity = BASE_HEMI_INTENSITY * v;
  fillLight.intensity = BASE_FILL_INTENSITY * v;
  exposureValueEl.textContent = `${v.toFixed(2)}×`;
}
exposureSlider.addEventListener('input', () => applyLightingIntensity(parseFloat(exposureSlider.value)));
applyLightingIntensity(parseFloat(exposureSlider.value)); // match the slider's HTML default on load

buildColorGrid();
updateApplyAllState();
updateSelectedPartLabel();
setStatus('Ready. Load a .step or .stp file to begin.');
applyView('iso-frt');
