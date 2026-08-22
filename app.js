// STEP file viewer: three.js rendering + occt-import-js (WASM) parsing via Worker.

const sidebarEl = document.getElementById('sidebar');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileNameEl = document.getElementById('file-name');
const statusEl = document.getElementById('status');
const modelInfoEl = document.getElementById('model-info');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const loadingElapsedEl = document.getElementById('loading-elapsed');
const toggleEdgesEl = document.getElementById('toggle-edges');
const toggleWireframeEl = document.getElementById('toggle-wireframe');
const toggleOrthoEl = document.getElementById('toggle-ortho');
const cameraAzimuthInput = document.getElementById('camera-azimuth-input');
const cameraElevationInput = document.getElementById('camera-elevation-input');
const cameraDistanceInput = document.getElementById('camera-distance-input');
const copyCameraAngleBtn = document.getElementById('copy-camera-angle');
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
const softnessSlider = document.getElementById('softness-slider');
const softnessValueEl = document.getElementById('softness-value');
const softnessRowEl = document.getElementById('softness-row');
const appearanceColorPicker = document.getElementById('appearance-color-picker');
const appearanceColorHexInput = document.getElementById('appearance-color-hex');
const saveSettingsBtn = document.getElementById('save-settings');
const loadSettingsBtn = document.getElementById('load-settings');
const settingsFileInput = document.getElementById('settings-file-input');
const lightAzimuthSlider = document.getElementById('light-azimuth-slider');
const lightAzimuthValueEl = document.getElementById('light-azimuth-value');
const lightElevationSlider = document.getElementById('light-elevation-slider');
const lightElevationValueEl = document.getElementById('light-elevation-value');
const resetLightBtn = document.getElementById('reset-light');
const toggleAllSectionsBtn = document.getElementById('toggle-all-sections');
const toggleShadowsEl = document.getElementById('toggle-shadows');
const toggleBackgroundEl = document.getElementById('toggle-background');
const backgroundColorRowEl = document.getElementById('background-color-row');
const backgroundColorPicker = document.getElementById('background-color-picker');
const backgroundColorHexInput = document.getElementById('background-color-hex');

// ---------- three.js scene setup ----------

// alpha + preserveDrawingBuffer are needed so the PNG export below can read
// back a transparent-background frame from this same canvas/context.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setClearColor(0xffffff); // overridden immediately below by the Background color control's default
// VSM (not PCFSoft) because it's the shadow type whose blur radius is
// actually controllable via light.shadow.radius — PCFSoft ignores that
// property, which is what the Light Softness slider below drives.
renderer.shadowMap.type = THREE.VSMShadowMap;
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
keyLight.castShadow = false; // flipped by the Cast Shadows toggle
keyLight.shadow.bias = -0.0015; // avoids shadow-acne self-shadowing artifacts
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.blurSamples = 16; // smoother blur at higher Light Softness values
scene.add(keyLight);
scene.add(keyLight.target);

const fillLight = new THREE.DirectionalLight(0xffffff, BASE_FILL_INTENSITY);
scene.add(fillLight);
scene.add(fillLight.target);

const grid = new THREE.GridHelper(1000, 20, 0x444444, 0x2c2e33);
grid.rotation.x = Math.PI / 2; // lie flat in the XY plane (Z-up)
grid.visible = false;
scene.add(grid);

// ShadowMaterial renders fully transparent except where a shadow lands on
// it — so this plane is invisible on its own (in the live view AND in a
// transparent-background PNG export) and only ever shows up as a soft dark
// patch under the model when Cast Shadows is on. PlaneGeometry already lies
// flat in the XY plane with its normal along +Z, which is exactly "ground"
// for this Z-up scene, so no rotation is needed (unlike GridHelper above).
const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35 }));
groundPlane.receiveShadow = true;
groundPlane.visible = false; // shown only while Cast Shadows is checked
scene.add(groundPlane);

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
  if (selectedMesh) syncAppearanceColorInputs(meshMaterials(selectedMesh)[0].color.getHex());
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

showAllPartsBtn.addEventListener('click', (e) => {
  e.preventDefault(); // it lives inside the Parts <summary> — don't let the click also collapse the section
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
  if (!isDraggingLight) {
    renderer.domElement.style.cursor = currentGroup && pickLightGizmo(e.clientX, e.clientY) ? 'grab' : '';
  }
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
  if (e.button === 0 && currentGroup && pickLightGizmo(e.clientX, e.clientY)) {
    isDraggingLight = true;
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
    updateLightFromPointer(e.clientX, e.clientY);
    return;
  }
  pointerDownPos = { x: e.clientX, y: e.clientY, button: e.button, shiftKey: e.shiftKey };
});
window.addEventListener('pointermove', (e) => {
  if (isDraggingLight) updateLightFromPointer(e.clientX, e.clientY);
});
window.addEventListener('pointerup', () => {
  if (!isDraggingLight) return;
  isDraggingLight = false;
  controls.enabled = true;
  renderer.domElement.style.cursor = '';
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

const COLOR_PALETTE = ['#e53935', '#43a047', '#1e88e5', '#c0c0c0', '#9e9e9e', '#455a64'];

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

// Finish buttons apply to every part immediately (matching "Apply to All
// Parts") rather than just previewing on a selection — a quick one-click
// preset. "Apply to Selected"/"Apply to All Parts" below remain for
// re-applying the current finish+color pick together, e.g. after also
// choosing a color, or to just one part on its own.
document.querySelectorAll('#finish-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    pendingFinish = btn.dataset.finish;
    document.querySelectorAll('#finish-grid .btn').forEach((b) => b.classList.toggle('active', b === btn));
    getPickableMeshesIncludingHidden().forEach((mesh) => applyFinishToMesh(mesh, pendingFinish));
    updateApplyAllState();
  });
});

function buildColorGrid() {
  COLOR_PALETTE.forEach((hex) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch';
    btn.style.background = hex;
    btn.title = hex;
    btn.addEventListener('click', () => choosePendingColor(parseInt(hex.slice(1), 16)));
    colorGridEl.appendChild(btn);
  });
}

// Pure display sync — shows a color in the hex field + native picker
// without touching pendingColorHex or applying anything. Used when a part
// is selected, to show its current color as a starting point.
function syncAppearanceColorInputs(hex) {
  const normalized = `#${hex.toString(16).padStart(6, '0')}`;
  appearanceColorPicker.value = normalized;
  appearanceColorHexInput.value = normalized;
}

// The single path every color choice goes through — a swatch click, the
// native picker, or typing a hex code — so they all behave identically:
// preview live on the current selection (if any), and highlight the
// matching swatch if the color happens to be one of the presets.
function choosePendingColor(hex) {
  pendingColorHex = hex;
  document.querySelectorAll('.color-swatch').forEach((b) => {
    b.classList.toggle('active', parseInt(b.title.slice(1), 16) === hex);
  });
  syncAppearanceColorInputs(hex);
  if (selectedMesh) applyColorToMesh(selectedMesh, hex);
  updateApplyAllState();
}

appearanceColorPicker.addEventListener('input', () => {
  choosePendingColor(parseHexColor(appearanceColorPicker.value));
});

appearanceColorHexInput.addEventListener('change', () => {
  const hex = parseHexColor(appearanceColorHexInput.value);
  if (hex === null) {
    appearanceColorHexInput.value = appearanceColorPicker.value;
    return;
  }
  choosePendingColor(hex);
});

applySelectedBtn.addEventListener('click', () => {
  if (selectedMesh) applyPendingToMesh(selectedMesh);
});

applyAllBtn.addEventListener('click', () => {
  getPickableMeshesIncludingHidden().forEach((mesh) => applyPendingToMesh(mesh));
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

// ---------- key light direction (visible, draggable gizmo) ----------

// Kept independent of the camera on purpose: a light that always sits at the
// camera (a "headlight") gives identical shading in every view, which makes
// it impossible to dial in a raking highlight or a shadowed side without
// also changing what you're looking at. Azimuth/elevation are in the same
// Z-up world space as everything else, orbiting controls.target.
// Deliberately NOT the default view's isometric angle (-135°/35.26°) — an
// isometric direction is, by definition, equidistant from all three visible
// faces of an axis-aligned box, so a light placed exactly there lights all
// three identically (same dot product with every face normal), leaving a
// default test cube with no visible shading difference between its faces.
// This angle is offset enough to give each face a clearly distinct grey.
const DEFAULT_LIGHT = { azimuthDeg: -110, elevationDeg: 55 };
const lightState = { ...DEFAULT_LIGHT };
// Every view frames the model with ~15% headroom around its bounding sphere
// (see fitCameraToModel/applyView/setProjectionMode's 1.15x margins), so an
// orbit AT that same radius (no flat offset — this must scale with the
// model, not a fixed distance) stays inside frame in every preset view,
// including the tighter orthographic frustum, regardless of the model's
// absolute size.
const LIGHT_ORBIT_MARGIN = 1.0;

// The inverse of anglesFromDirection below — also dual-purpose (key light,
// and the editable camera angle fields further down).
function directionFromAngles(azimuthDeg, elevationDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

// Generic direction-vector → azimuth/elevation converter — used for the key
// light's angle, and reused below for the camera's angle relative to
// whatever it's orbiting (controls.target), since both are just "a point on
// a sphere around a center" in the same Z-up spherical convention.
function anglesFromDirection(dir) {
  const elevationDeg = (Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1)) * 180) / Math.PI;
  const azimuthDeg = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  return { azimuthDeg, elevationDeg };
}

// A small bright sphere marks the key light's position, plus a thin line
// back to the model center so its direction reads clearly from any angle.
// A separate, larger, fully-transparent sphere sits underneath purely as a
// generous drag target — the visible sphere alone is too small to grab reliably.
const lightGizmo = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 20),
  new THREE.MeshBasicMaterial({ color: 0xffd76a, depthTest: false, depthWrite: false })
);
lightGizmo.renderOrder = 999;
scene.add(lightGizmo);

const lightGizmoLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.45, depthTest: false })
);
lightGizmoLine.renderOrder = 998;
scene.add(lightGizmoLine);

const lightGizmoHit = new THREE.Mesh(
  new THREE.SphereGeometry(1, 12, 12),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false })
);
scene.add(lightGizmoHit);

function setLightGizmoVisible(visible) {
  lightGizmo.visible = visible;
  lightGizmoLine.visible = visible;
}
setLightGizmoVisible(false); // shown once a model is loaded

function lightOrbitDistance() {
  return modelRadius * LIGHT_ORBIT_MARGIN;
}

function updateLightGizmoTransform() {
  lightGizmo.position.copy(keyLight.position);
  lightGizmoHit.position.copy(keyLight.position);
  const displayScale = Math.max(modelRadius * 0.05, 0.5);
  lightGizmo.scale.setScalar(displayScale);
  lightGizmoHit.scale.setScalar(displayScale * 2.5); // generous grab radius, invisible

  const target = controls.target;
  const pos = lightGizmoLine.geometry.attributes.position;
  pos.setXYZ(0, target.x, target.y, target.z);
  pos.setXYZ(1, keyLight.position.x, keyLight.position.y, keyLight.position.z);
  pos.needsUpdate = true;
}

function pointerToNDC(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

function pickLightGizmo(clientX, clientY) {
  raycaster.setFromCamera(pointerToNDC(clientX, clientY), camera);
  return raycaster.intersectObject(lightGizmoHit, false).length > 0;
}

// Casts the pointer against an imaginary sphere centered on the model
// (radius = the light's orbit distance) so the light tracks the cursor
// directly, arcball-style, rather than by incremental drag deltas.
function updateLightFromPointer(clientX, clientY) {
  raycaster.setFromCamera(pointerToNDC(clientX, clientY), camera);
  const dist = lightOrbitDistance();
  const sphere = new THREE.Sphere(controls.target, dist);
  const hitPoint = new THREE.Vector3();
  let dir;
  if (raycaster.ray.intersectSphere(sphere, hitPoint)) {
    dir = hitPoint.sub(controls.target).normalize();
  } else {
    // Dragged past the sphere's silhouette — fall back to the closest point
    // on the ray to the model center, so the light still follows smoothly.
    const closest = new THREE.Vector3();
    raycaster.ray.closestPointToPoint(controls.target, closest);
    dir = closest.sub(controls.target).normalize();
  }
  const angles = anglesFromDirection(dir);
  lightState.azimuthDeg = roundClean(angles.azimuthDeg);
  lightState.elevationDeg = roundClean(THREE.MathUtils.clamp(angles.elevationDeg, -89, 89));
  syncLightSlidersFromState();
}

let isDraggingLight = false;

function updateKeyLights() {
  const target = controls.target;
  const dist = lightOrbitDistance();

  const keyDir = directionFromAngles(lightState.azimuthDeg, lightState.elevationDeg);
  keyLight.position.copy(target).addScaledVector(keyDir, dist);
  keyLight.target.position.copy(target);

  // Fill stays a softer, lower light on the opposite side of the key light —
  // the same relationship the old camera-locked rig had, just anchored to
  // the key light's angle instead of the camera's.
  const fillDir = directionFromAngles(lightState.azimuthDeg + 180, lightState.elevationDeg * 0.5);
  fillLight.position.copy(target).addScaledVector(fillDir, dist);
  fillLight.target.position.copy(target);

  updateLightGizmoTransform();
}

renderer.setAnimationLoop(() => {
  controls.update();
  updateKeyLights();
  updateCameraAngleInputs();
  if (!isDraggingLight) updateHoverPick();
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

  // "Hero" views: shallower than true isometric (35.26°), closer to a
  // product-photography angle — flat/wide hardware (a card, a server tray)
  // reads better here than at the steeper CAD-isometric elevation, which
  // foreshortens thin parts oddly. Same 4 corners as Isometric, at 18°
  // elevation, plus a Top view tilted 30° toward the front or back (60°
  // elevation, no left-right skew) for showing a fan shroud/heatsink layout
  // with some depth instead of a flat orthographic Top.
  'hero-fr':        { dir: [0.673, -0.673, 0.309], up: [0, 0, 1] }, // front-right, 18°
  'hero-fl':        { dir: [-0.673, -0.673, 0.309], up: [0, 0, 1] }, // front-left, 18°
  'hero-br':        { dir: [0.673, 0.673, 0.309],  up: [0, 0, 1] }, // back-right, 18°
  'hero-bl':        { dir: [-0.673, 0.673, 0.309], up: [0, 0, 1] }, // back-left, 18°
  'hero-top-front': { dir: [0, -0.5, 0.866],       up: [0, 0, 1] }, // top tilted 30° toward front, 60°
  'hero-top-back':  { dir: [0, 0.5, 0.866],        up: [0, 0, 1] }, // top tilted 30° toward back, 60°
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

document.querySelectorAll('#iso-grid .btn, #ortho-grid .btn, #hero-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => applyView(btn.dataset.view));
});

// Camera angle as azimuth/elevation/distance from whatever it's orbiting —
// portable to any other 3D software, unlike raw camera rotation (an
// internal Euler XYZ tied to this app's particular rotation-order
// convention). Orbiting with the mouse, clicking a view preset, or panning
// all move the camera, so this is recomputed every frame rather than only
// on specific events.
function getCameraSphericalInfo() {
  const offset = camera.position.clone().sub(controls.target);
  const distance = offset.length();
  const { azimuthDeg, elevationDeg } = anglesFromDirection(offset.normalize());
  return { azimuthDeg, elevationDeg, distance };
}

function formatCameraAngleText() {
  const { azimuthDeg, elevationDeg, distance } = getCameraSphericalInfo();
  return `Az ${azimuthDeg.toFixed(1)}°  El ${elevationDeg.toFixed(1)}°  Dist ${distance.toFixed(0)}mm`;
}

// Skips a field the user is actively typing in, same reasoning as the
// Rotate Model angle fields never getting clobbered mid-edit — except those
// only change on button clicks, while the camera moves every frame (orbit),
// so this guard actually matters here.
function updateCameraAngleInputs() {
  const { azimuthDeg, elevationDeg, distance } = getCameraSphericalInfo();
  if (document.activeElement !== cameraAzimuthInput) cameraAzimuthInput.value = azimuthDeg.toFixed(1);
  if (document.activeElement !== cameraElevationInput) cameraElevationInput.value = elevationDeg.toFixed(1);
  if (document.activeElement !== cameraDistanceInput) cameraDistanceInput.value = distance.toFixed(0);
}

// Orbits the camera to an exact azimuth/elevation/distance around
// controls.target — the inverse of getCameraSphericalInfo, same relationship
// as applyView()'s dir-vector placement but from typed numbers instead of a
// fixed preset. Elevation is clamped shy of the poles (matches the light
// direction fields) since azimuth becomes meaningless exactly at ±90°.
function applyCameraSpherical(azimuthDeg, elevationDeg, distance) {
  const clampedElevation = THREE.MathUtils.clamp(elevationDeg, -89, 89);
  const clampedDistance = Math.max(distance, modelRadius * 0.01);
  const dir = directionFromAngles(azimuthDeg, clampedElevation);
  camera.up.set(0, 0, 1);
  camera.position.copy(controls.target).addScaledVector(dir, clampedDistance);
  camera.lookAt(controls.target);
  controls.update();
}

[cameraAzimuthInput, cameraElevationInput, cameraDistanceInput].forEach((input) => {
  input.addEventListener('change', () => {
    const azimuthDeg = parseFloat(cameraAzimuthInput.value);
    const elevationDeg = parseFloat(cameraElevationInput.value);
    const distance = parseFloat(cameraDistanceInput.value);
    if (Number.isNaN(azimuthDeg) || Number.isNaN(elevationDeg) || Number.isNaN(distance) || distance <= 0) {
      updateCameraAngleInputs(); // invalid entry — revert to the camera's actual current angle
      return;
    }
    applyCameraSpherical(azimuthDeg, elevationDeg, distance);
  });
});

// Same nudge-by-a-fixed-step pattern as Rotate Model's ±7.5° buttons.
// Distance nudges by ±10% (multiplicative) rather than a fixed mm amount,
// since a fixed step wouldn't scale sensibly between a tiny part and a
// full server chassis — same reasoning as the light/hero-view orbit radius
// scaling off modelRadius instead of a flat offset.
document.querySelectorAll('#camera-angle-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const axis = btn.dataset.cameraAxis;
    const nudge = parseFloat(btn.dataset.nudge);
    const current = getCameraSphericalInfo();
    if (axis === 'distance') {
      applyCameraSpherical(current.azimuthDeg, current.elevationDeg, current.distance * nudge);
    } else if (axis === 'azimuth') {
      applyCameraSpherical(current.azimuthDeg + nudge, current.elevationDeg, current.distance);
    } else {
      applyCameraSpherical(current.azimuthDeg, current.elevationDeg + nudge, current.distance);
    }
  });
});

copyCameraAngleBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(formatCameraAngleText()).then(() => {
    const original = copyCameraAngleBtn.textContent;
    copyCameraAngleBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyCameraAngleBtn.textContent = original;
    }, 1200);
  });
});

resetFitBtn.addEventListener('click', () => applyView('iso-flt'));

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

// A large or geometrically complex STEP file can take many minutes to
// tessellate in a single-threaded, in-browser WASM parser, with no progress
// callbacks available from occt-import-js along the way — so without a
// ticking clock, a slow-but-working parse and a genuinely dead one look
// identical. This is the app's only defense against that: proof the page
// itself is still alive and time is passing, even though it can't report
// how much work remains.
let loadingStartTime = null;
let loadingTimerId = null;

function updateLoadingElapsed() {
  if (loadingStartTime === null) return;
  const elapsedSec = Math.round((performance.now() - loadingStartTime) / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  loadingElapsedEl.textContent = `Elapsed: ${elapsedStr} — still working. Very large or complex assemblies can take several minutes.`;
}

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.add('visible');
  loadingStartTime = performance.now();
  updateLoadingElapsed();
  if (loadingTimerId) clearInterval(loadingTimerId);
  loadingTimerId = setInterval(updateLoadingElapsed, 1000);
}

function hideLoading() {
  loadingOverlay.classList.remove('visible');
  if (loadingTimerId) {
    clearInterval(loadingTimerId);
    loadingTimerId = null;
  }
  loadingStartTime = null;
  loadingElapsedEl.textContent = '';
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
  setLightGizmoVisible(false);
}

// Files above this size aren't guaranteed to fail (it's really the part
// count / geometric complexity that determines whether this in-browser,
// single-threaded WASM parser can handle a file, not raw byte size alone),
// but it's the only signal available before parsing even starts, so it's
// worth a heads-up rather than launching straight into a silent multi-minute wait.
const LARGE_FILE_WARNING_BYTES = 30 * 1024 * 1024;

function loadStepFile(file) {
  fileNameEl.textContent = file.name;
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  const sizeNote =
    file.size > LARGE_FILE_WARNING_BYTES
      ? ` (${sizeMb} MB — large, may take several minutes and very complex assemblies may not fully render)`
      : ` (${sizeMb} MB)`;
  showLoading(`Parsing ${file.name}${sizeNote}...`);
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
  let emptyMeshCount = 0;
  for (const resultMesh of result.meshes) {
    const { mesh, edges } = buildMesh(resultMesh, toggleEdgesEl.checked);
    mesh.visible = true;
    mesh.userData.edges = edges || null;
    group.add(mesh);
    if (edges) group.add(edges);
    meshList.push(mesh);
    const meshTriangles = resultMesh.index.array.length / 3;
    triangleCount += meshTriangles;
    if (meshTriangles === 0) emptyMeshCount++;
  }
  flipGroup.add(group);
  currentGroup = group;
  buildPartsList(meshList);
  setLightGizmoVisible(true);

  fitCameraToModel();
  applyView('iso-flt');

  // occt-import-js can report success and a full part list while still
  // silently failing to tessellate some or all of them into actual
  // triangles (seen on a 17,678-part assembly that likely exceeded this
  // single-threaded WASM parser's memory budget) — a real, distinct failure
  // mode from a parse error, and one that otherwise looks identical to "it
  // loaded fine but there's nothing worth looking at," i.e. an empty
  // viewport with no explanation. Surface it instead of staying silent.
  const totalParts = result.meshes.length;
  let statusMessage = 'Ready.';
  let warningHtml = '';
  if (totalParts > 0 && emptyMeshCount === totalParts) {
    statusMessage = 'Parsed, but no part produced visible geometry — see warning below.';
    warningHtml =
      `<div class="model-warning">Warning: all ${totalParts.toLocaleString()} part(s) parsed with zero ` +
      `triangles. This file is likely too complex for this browser-based viewer — try a simplified ` +
      `export (fewer individual fasteners/instances) or a desktop CAD tool.</div>`;
  } else if (emptyMeshCount > 0) {
    statusMessage = 'Ready — some parts have no geometry (see warning below).';
    warningHtml =
      `<div class="model-warning">Warning: ${emptyMeshCount.toLocaleString()} of ${totalParts.toLocaleString()} ` +
      `part(s) parsed with zero triangles and won't be visible.</div>`;
  }

  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  modelInfoEl.innerHTML =
    `<div><b>${escapeHtml(file.name)}</b></div>` +
    `<div>${totalParts.toLocaleString()} mesh part(s)</div>` +
    `<div>${triangleCount.toLocaleString()} triangles</div>` +
    `<div>${sizeMb} MB on disk</div>` +
    warningHtml;
  setStatus(statusMessage);
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

  groundPlane.scale.setScalar(modelRadius * 20);
  groundPlane.position.set(modelCenter.x, modelCenter.y, box.min.z);

  // The shadow camera is a separate orthographic frustum the key light uses
  // to render its shadow map — sized here so it always just covers the
  // model's bounding sphere, however big or small the loaded part is.
  const shadowCam = keyLight.shadow.camera;
  const shadowExtent = modelRadius * 1.3;
  shadowCam.left = -shadowExtent;
  shadowCam.right = shadowExtent;
  shadowCam.top = shadowExtent;
  shadowCam.bottom = -shadowExtent;
  shadowCam.near = modelRadius * 0.01;
  shadowCam.far = modelRadius * 3;
  shadowCam.updateProjectionMatrix();
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
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (edges) edges.renderOrder = mesh.renderOrder + 1;

  return { mesh, geometry, edges };
}

// A procedural cube stands in until a real file is loaded, so there's
// always something on screen to try the controls on. Each face is its own
// mesh/"part" — same as a multi-part STEP file's meshes — so every part
// interaction (select, hide, material, edges) works on each face
// independently, including recoloring them individually.
// clearModel() (called at the top of onStepParsed) tears it down exactly
// like any other loaded model, so loading a real file replaces it for free.
const CUBE_HALF_SIZE = 35;
const CUBE_FACES = [
  { name: 'Top', normal: [0, 0, 1] },
  { name: 'Bottom', normal: [0, 0, -1] },
  { name: 'Front', normal: [0, -1, 0] },
  { name: 'Back', normal: [0, 1, 0] },
  { name: 'Right', normal: [1, 0, 0] },
  { name: 'Left', normal: [-1, 0, 0] },
];
const PLANE_NORMAL = new THREE.Vector3(0, 0, 1); // PlaneGeometry's default facing, before orienting per face

function loadDefaultTestShape() {
  clearModel();

  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  const group = new THREE.Group();
  const meshList = [];

  CUBE_FACES.forEach((face) => {
    const normal = new THREE.Vector3(...face.normal);
    const geometry = new THREE.PlaneGeometry(CUBE_HALF_SIZE * 2, CUBE_HALF_SIZE * 2);
    geometry.name = face.name;
    // Bake the face's orientation and offset into the geometry itself
    // (rather than the mesh's transform) — same convention as a STEP file's
    // meshes, whose vertex positions already sit in world/model space.
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(PLANE_NORMAL, normal));
    geometry.translate(...normal.clone().multiplyScalar(CUBE_HALF_SIZE).toArray());

    const material = new THREE.MeshStandardMaterial({
      color: 0xb0b3b8,
      metalness: DEFAULT_FINISH.metalness,
      roughness: DEFAULT_FINISH.roughness,
      emissiveIntensity: HIGHLIGHT_EMISSIVE_INTENSITY,
      side: THREE.DoubleSide, // visible from inside too, e.g. after shift+click-hiding an adjacent face
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = face.name;
    mesh.visible = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edges = toggleEdgesEl.checked
      ? new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), outlineMaterial)
      : null;
    if (edges) edges.renderOrder = mesh.renderOrder + 1;
    mesh.userData.edges = edges;

    group.add(mesh);
    if (edges) group.add(edges);
    meshList.push(mesh);
  });

  flipGroup.add(group);
  currentGroup = group;
  buildPartsList(meshList);
  setLightGizmoVisible(true);

  fitCameraToModel();
  applyView('iso-flt');

  modelInfoEl.innerHTML =
    `<div><b>Test cube</b></div>` +
    `<div>Default placeholder — load a file to replace it.</div>` +
    `<div>6 faces, individually selectable in Parts below.</div>`;
  setStatus('Ready.');
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

// Strips the .step/.stp extension off the loaded file's name for reuse in
// exported filenames (PNGs, settings JSON) — falls back to a generic name
// before any file has been loaded.
function getModelBaseName(fallback) {
  return (fileNameEl.textContent || fallback).replace(/\.(step|stp)$/i, '');
}

function getCameraInfoLines() {
  const p = camera.position;
  return [
    `Camera position (mm)   X ${p.x.toFixed(1)}   Y ${p.y.toFixed(1)}   Z ${p.z.toFixed(1)}`,
    // Az/El/Distance from target, not raw camera rotation — portable to any
    // other 3D software's own camera controls, unlike an internal Euler XYZ.
    `Camera angle            ${formatCameraAngleText()}`,
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
  const shadowInfo = toggleShadowsEl.checked ? `, Shadow softness ${parseFloat(softnessSlider.value).toFixed(1)}` : '';
  const lightLine =
    `Lighting                ${exposureValue}×` +
    `  (Az ${lightState.azimuthDeg.toFixed(1)}°, El ${lightState.elevationDeg.toFixed(1)}°${shadowInfo})`;
  return [...getCameraInfoLines(), lightLine, ...getMaterialSummaryLines()];
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
  // Mirrors the live Background color exactly, including its enabled state —
  // unchecked (transparent) still drops cleanly onto slides/docs; checked
  // bakes that color in as an opaque background. Either way, a cast shadow
  // composites correctly: ShadowMaterial's alpha works the same over a solid
  // color or over full transparency.
  const bgHex = renderer.getClearColor(new THREE.Color()).getHex();
  offRenderer.setClearColor(bgHex, toggleBackgroundEl.checked ? 1 : 0);
  offRenderer.shadowMap.enabled = renderer.shadowMap.enabled;
  offRenderer.shadowMap.type = renderer.shadowMap.type;

  // The light gizmo is a UI aid, not part of the model — never bake it into the export.
  const gizmoWasVisible = lightGizmo.visible;
  setLightGizmoVisible(false);

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
  setLightGizmoVisible(gizmoWasVisible);

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
    const baseName = getModelBaseName('step-view');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName}${scaleTag}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

document.querySelectorAll('#png-scale-grid .btn').forEach((btn) => {
  btn.addEventListener('click', () => downloadViewAsPng(parseFloat(btn.dataset.scale)));
});

// ---------- settings export/import ----------

// The model's own quaternion is the ground truth for restoring rotation
// exactly; rotationTotals is just the odometer readout shown in the angle
// fields (world-axis rotations don't commute, so totals alone can't
// reconstruct orientation — see the comment above rotationTotals).
function collectSettings() {
  const meshes = getPickableMeshesIncludingHidden();
  return {
    type: 'step-viewer-settings',
    version: 1,
    camera: {
      projection: camera.isOrthographicCamera ? 'orthographic' : 'perspective',
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      up: camera.up.toArray(),
      zoom: camera.isOrthographicCamera ? camera.zoom : 1,
    },
    modelRotation: {
      quaternion: flipGroup.quaternion.toArray(),
      totals: { ...rotationTotals },
    },
    lightingIntensity: parseFloat(exposureSlider.value),
    lightSoftness: parseFloat(softnessSlider.value),
    light: { azimuthDeg: lightState.azimuthDeg, elevationDeg: lightState.elevationDeg },
    display: {
      edges: toggleEdgesEl.checked,
      wireframe: toggleWireframeEl.checked,
      shadows: toggleShadowsEl.checked,
      backgroundEnabled: toggleBackgroundEl.checked,
      backgroundColorHex: `#${renderer.getClearColor(new THREE.Color()).getHexString()}`,
    },
    parts: meshes.map((mesh, i) => {
      const mat = meshMaterials(mesh)[0];
      return {
        index: i,
        name: mesh.name || null,
        visible: mesh.visible,
        colorHex: `#${mat.color.getHexString()}`,
        metalness: mat.metalness,
        roughness: mat.roughness,
      };
    }),
  };
}

// Matches saved parts back to this model's meshes by name first (so settings
// carry over sensibly to a different model that shares part names), falling
// back to index (so a plain re-load of the same file lines up even when
// parts are unnamed or names collide).
function applyPartsSettings(savedParts) {
  const meshes = getPickableMeshesIncludingHidden();
  const byName = new Map();
  meshes.forEach((mesh) => {
    const key = mesh.name || '';
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(mesh);
  });

  savedParts.forEach((sp) => {
    let mesh = null;
    if (sp.name && byName.has(sp.name) && byName.get(sp.name).length) {
      mesh = byName.get(sp.name).shift();
    } else if (meshes[sp.index]) {
      mesh = meshes[sp.index];
    }
    if (!mesh) return;

    setPartVisible(mesh, sp.visible !== false);
    if (sp.colorHex) applyColorToMesh(mesh, parseInt(sp.colorHex.slice(1), 16));
    if (typeof sp.metalness === 'number' && typeof sp.roughness === 'number') {
      meshMaterials(mesh).forEach((m) => {
        m.metalness = sp.metalness;
        m.roughness = sp.roughness;
      });
    }
  });
}

function applySettings(settings) {
  if (!settings || settings.type !== 'step-viewer-settings') {
    setStatus('Not a recognized settings file.');
    return;
  }

  if (settings.display) {
    if (typeof settings.display.edges === 'boolean') {
      toggleEdgesEl.checked = settings.display.edges;
      toggleEdgesEl.dispatchEvent(new Event('change'));
    }
    if (typeof settings.display.wireframe === 'boolean') {
      toggleWireframeEl.checked = settings.display.wireframe;
      toggleWireframeEl.dispatchEvent(new Event('change'));
    }
    if (typeof settings.display.shadows === 'boolean') {
      toggleShadowsEl.checked = settings.display.shadows;
      toggleShadowsEl.dispatchEvent(new Event('change'));
    }
    if (typeof settings.display.backgroundColorHex === 'string') {
      const hex = parseHexColor(settings.display.backgroundColorHex);
      if (hex !== null) applyBackgroundColor(hex);
    }
    if (typeof settings.display.backgroundEnabled === 'boolean') {
      toggleBackgroundEl.checked = settings.display.backgroundEnabled;
      toggleBackgroundEl.dispatchEvent(new Event('change'));
    }
  }

  if (typeof settings.lightingIntensity === 'number') {
    exposureSlider.value = settings.lightingIntensity;
    applyLightingIntensity(settings.lightingIntensity);
  }

  if (typeof settings.lightSoftness === 'number') {
    softnessSlider.value = settings.lightSoftness;
    applyLightSoftness(settings.lightSoftness);
  }

  if (settings.light) {
    if (typeof settings.light.azimuthDeg === 'number') lightState.azimuthDeg = settings.light.azimuthDeg;
    if (typeof settings.light.elevationDeg === 'number') lightState.elevationDeg = settings.light.elevationDeg;
    syncLightSlidersFromState();
  }

  if (settings.modelRotation) {
    if (Array.isArray(settings.modelRotation.quaternion) && settings.modelRotation.quaternion.length === 4) {
      flipGroup.quaternion.fromArray(settings.modelRotation.quaternion);
    }
    const totals = settings.modelRotation.totals;
    if (totals) {
      ['x', 'y', 'z'].forEach((axisName) => {
        if (typeof totals[axisName] === 'number') {
          rotationTotals[axisName] = totals[axisName];
          if (angleInputs[axisName]) angleInputs[axisName].value = totals[axisName];
        }
      });
    }
  }

  if (settings.camera) {
    const wantOrtho = settings.camera.projection === 'orthographic';
    setProjectionMode(wantOrtho);
    toggleOrthoEl.checked = wantOrtho;
    if (Array.isArray(settings.camera.position)) camera.position.fromArray(settings.camera.position);
    if (Array.isArray(settings.camera.up)) camera.up.fromArray(settings.camera.up);
    if (Array.isArray(settings.camera.target)) controls.target.fromArray(settings.camera.target);
    if (wantOrtho && typeof settings.camera.zoom === 'number') camera.zoom = settings.camera.zoom;
    camera.lookAt(controls.target);
    updateCameraProjection();
    controls.update();
  }

  if (Array.isArray(settings.parts) && currentGroup) {
    applyPartsSettings(settings.parts);
  }

  setStatus('Settings loaded.');
}

saveSettingsBtn.addEventListener('click', () => {
  const settings = collectSettings();
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = getModelBaseName('step-viewer');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${baseName}-settings-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
});

loadSettingsBtn.addEventListener('click', () => settingsFileInput.click());
settingsFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applySettings(JSON.parse(reader.result));
    } catch (err) {
      console.error(err);
      setStatus('Error reading settings file.');
    }
  };
  reader.readAsText(file);
  settingsFileInput.value = '';
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

toggleShadowsEl.addEventListener('change', () => {
  const on = toggleShadowsEl.checked;
  renderer.shadowMap.enabled = on;
  keyLight.castShadow = on;
  groundPlane.visible = on;
  softnessRowEl.style.opacity = on ? '1' : '0.4';
});

// VSMShadowMap is the shadow type whose blur radius is actually
// controllable (see the renderer.shadowMap.type comment above) — 0 is a
// crisp, hard-edged shadow; higher values blur it into a soft penumbra.
function applyLightSoftness(v) {
  keyLight.shadow.radius = v;
  softnessValueEl.textContent = v.toFixed(1);
}
softnessSlider.addEventListener('input', () => applyLightSoftness(parseFloat(softnessSlider.value)));
applyLightSoftness(parseFloat(softnessSlider.value));
softnessRowEl.style.opacity = toggleShadowsEl.checked ? '1' : '0.4';

// Accepts "#rrggbb", "rrggbb", or short "#fff"/"fff" forms; returns a
// THREE-style 0xRRGGBB number, or null if the string isn't a valid hex color.
function parseHexColor(str) {
  const s = str.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(s)) return parseInt(s, 16);
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const [r, g, b] = s;
    return parseInt(r + r + g + g + b + b, 16);
  }
  return null;
}

// Sets the background color and respects the enable/disable checkbox's
// current state for the alpha channel — unchecked means transparent, both
// live and (via the offscreen renderer mirroring this below) in PNG exports.
function applyBackgroundColor(hex) {
  const normalized = `#${hex.toString(16).padStart(6, '0')}`;
  backgroundColorPicker.value = normalized;
  backgroundColorHexInput.value = normalized;
  renderer.setClearColor(hex, toggleBackgroundEl.checked ? 1 : 0);
}

backgroundColorPicker.addEventListener('input', () => {
  applyBackgroundColor(parseHexColor(backgroundColorPicker.value));
});

backgroundColorHexInput.addEventListener('change', () => {
  const hex = parseHexColor(backgroundColorHexInput.value);
  if (hex === null) {
    backgroundColorHexInput.value = backgroundColorPicker.value;
    return;
  }
  applyBackgroundColor(hex);
});

toggleBackgroundEl.addEventListener('change', () => {
  backgroundColorRowEl.style.opacity = toggleBackgroundEl.checked ? '1' : '0.4';
  applyBackgroundColor(parseHexColor(backgroundColorHexInput.value));
});

applyBackgroundColor(0xffffff);

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

function syncLightSlidersFromState() {
  lightAzimuthSlider.value = lightState.azimuthDeg;
  lightElevationSlider.value = lightState.elevationDeg;
  lightAzimuthValueEl.textContent = `${Math.round(lightState.azimuthDeg)}°`;
  lightElevationValueEl.textContent = `${Math.round(lightState.elevationDeg)}°`;
}
lightAzimuthSlider.addEventListener('input', () => {
  lightState.azimuthDeg = parseFloat(lightAzimuthSlider.value);
  lightAzimuthValueEl.textContent = `${Math.round(lightState.azimuthDeg)}°`;
});
lightElevationSlider.addEventListener('input', () => {
  lightState.elevationDeg = parseFloat(lightElevationSlider.value);
  lightElevationValueEl.textContent = `${Math.round(lightState.elevationDeg)}°`;
});
resetLightBtn.addEventListener('click', () => {
  lightState.azimuthDeg = DEFAULT_LIGHT.azimuthDeg;
  lightState.elevationDeg = DEFAULT_LIGHT.elevationDeg;
  syncLightSlidersFromState();
});
syncLightSlidersFromState(); // paint the precise default (e.g. 35.26° → "35°"), overriding the HTML placeholder

buildColorGrid();
updateApplyAllState();
updateSelectedPartLabel();
loadDefaultTestShape();

// ---------- collapsible sidebar sections ----------

// Every section defaults open (matching prior behavior); this only ever
// needs to CLOSE the ones a returning user had collapsed last time.
const COLLAPSE_STORAGE_KEY = 'step-viewer-collapsed-sections';

function loadCollapsedSectionIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsedSectionIds(ids) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable (private browsing, etc.) — collapse state just won't persist.
  }
}

function getAllCollapsibleSections() {
  return [...document.querySelectorAll('details.collapsible[id]')];
}

// Label reflects what the button will DO next: if every section is already
// collapsed, offer to expand; otherwise (any open) offer to collapse.
function updateToggleAllSectionsLabel() {
  const allCollapsed = getAllCollapsibleSections().every((d) => !d.open);
  toggleAllSectionsBtn.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

const collapsedSectionIds = loadCollapsedSectionIds();
getAllCollapsibleSections().forEach((details) => {
  if (collapsedSectionIds.has(details.id)) details.open = false;
  details.addEventListener('toggle', () => {
    if (details.open) collapsedSectionIds.delete(details.id);
    else collapsedSectionIds.add(details.id);
    saveCollapsedSectionIds(collapsedSectionIds);
    updateToggleAllSectionsLabel();
  });
});
updateToggleAllSectionsLabel();

toggleAllSectionsBtn.addEventListener('click', () => {
  const shouldExpand = getAllCollapsibleSections().every((d) => !d.open);
  getAllCollapsibleSections().forEach((d) => {
    d.open = shouldExpand;
  });
});
