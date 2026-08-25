// The 3D office floor — a Three.js scene of five lit rooms with blocky agents at
// desks, replacing the flat SVG floor. Pure geometry, no external assets: every
// desk, wall, and figure is BoxGeometry, so the whole scene ships inside the single
// inlined index.html the server already serves.
//
// Kept framework-free (plain TS, no React) so the same engine can be driven by the
// React wrapper OR by the imperative window.domThree API the event bus expects.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { ZONES } from "./sessions.js";

export type AgentState = "idle" | "thinking" | "awaiting" | "speaking" | "dreaming";
export type SceneAgent = { id: string; name: string; zone: string; slot: number; state: AgentState; color?: string };

/** SVG floor units per world unit. The 1440x900 floor becomes 24x15 world units,
 *  which frames correctly under the spec's camera (fov 45 at [0,18,12]). */
const U = 60;
// Deliberately low: at the specced 2.6 the front row's back wall completely hides
// the back row's floor from any camera inside the allowed polar range.
const WALL_H = 1.75;
const ACCENT: Record<string, number> = {
  coordinator: 0xe879f9, planning: 0x818cf8, application: 0x4ade80, coding: 0x22d3ee, subagents: 0xc084fc,
};
/** Round-robin body colours, assigned by index within a zone. */
const VARIANTS = [0x22d3ee, 0xc084fc, 0x4ade80, 0xe879f9];
const SCREEN: Record<AgentState, { color: number; intensity: number }> = {
  idle: { color: 0x1a2a1a, intensity: 0.15 },
  thinking: { color: 0x22d3ee, intensity: 0.8 },
  awaiting: { color: 0xfbbf24, intensity: 0.7 },
  speaking: { color: 0xe879f9, intensity: 0.6 },
  // Dreaming: a dim violet screen. The figure itself carries the signal (a slow
  // breathing pulse), so the monitor stays quiet.
  dreaming: { color: 0xa78bfa, intensity: 0.35 },
};

/** World-space rect for a zone, derived from the SVG layout so the 3D rooms sit in
 *  exactly the arrangement the flat floor uses (coordinator/planning/application on
 *  the back row, coding/sub-agents on the front row). */
function zoneRect(z: (typeof ZONES)[number]) {
  return {
    cx: (z.x + z.w / 2 - 720) / U, cz: (z.y + z.d / 2 - 450) / U,
    w: z.w / U, d: z.d / U,
    x0: (z.x - 720) / U, z0: (z.y - 450) / U,
  };
}
function slotPos(z: (typeof ZONES)[number], slot: number) {
  const sl = z.slots[Math.max(0, Math.min(slot, z.slots.length - 1))];
  // The SVG slot anchors the desk's top-left; +60/-40 centres the desk on its tile.
  return { x: (sl[0] + 60 - 720) / U, z: (sl[1] - 40 - 450) / U };
}

/** Pixel-art tile sheet. Drawn at 32x32 and sampled with NearestFilter at both
 *  ends, which is what keeps it reading as pixel art instead of a blurred gradient
 *  as it recedes from the camera. */
function tileTexture(tile: string, grout: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = tile; g.fillRect(0, 0, 32, 32);
  g.fillStyle = grout;
  g.fillRect(0, 0, 32, 2);
  g.fillRect(0, 0, 2, 32);
  return pixelate(new THREE.CanvasTexture(c));
}

/** Dark wood-like desk surface: a flat base with a few thin grain lines. */
function woodTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1e1624"; g.fillRect(0, 0, 32, 32);
  g.fillStyle = "#2a1f31";
  for (const y of [5, 12, 19, 27]) g.fillRect(0, y, 32, 1);
  g.fillStyle = "#170f1c";
  for (const y of [9, 23]) g.fillRect(0, y, 32, 1);
  return pixelate(new THREE.CanvasTexture(c));
}

/** NearestFilter on BOTH min and mag — magFilter alone still blurs at distance. */
function pixelate(t: THREE.Texture): THREE.Texture {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

/** Geometry and materials shared by every desk — one allocation for the whole
 *  scene instead of one per agent. (The spec's InstancedMesh threshold of >8 desks
 *  per zone is never reached: coding, the largest zone, has exactly 8 slots.
 *  Sharing achieves the same draw-call saving without the per-instance bookkeeping
 *  that would fight the per-desk emissive screen colours.) */
type Shared = ReturnType<typeof makeShared>;
function makeShared() {
  return {
    geo: {
      top: new THREE.BoxGeometry(1.2, 0.08, 0.7),
      leg: new THREE.BoxGeometry(0.08, 0.6, 0.08),
      monBase: new THREE.BoxGeometry(0.1, 0.3, 0.1),
      monScreen: new THREE.BoxGeometry(0.62, 0.38, 0.04),
      keyboard: new THREE.BoxGeometry(0.6, 0.02, 0.25),
      body: new THREE.BoxGeometry(0.5, 0.7, 0.3),
      head: new THREE.BoxGeometry(0.4, 0.4, 0.4),
      arm: new THREE.BoxGeometry(0.15, 0.6, 0.15),
      leg2: new THREE.BoxGeometry(0.18, 0.42, 0.18),
      foot: new THREE.BoxGeometry(0.2, 0.1, 0.26),
      eye: new THREE.BoxGeometry(0.07, 0.07, 0.02),
      badge: new THREE.BoxGeometry(0.18, 0.18, 0.18),
    },
    mat: {
      // MeshLambert throughout the solid props: no specular term, so every face
      // reads as one flat colour — the blocky look the reference has.
      deskTop: new THREE.MeshLambertMaterial({ map: woodTexture() }),
      deskLeg: new THREE.MeshLambertMaterial({ color: 0x1a1220 }),
      monBase: new THREE.MeshLambertMaterial({ color: 0x1a1a2a }),
      keyboard: new THREE.MeshLambertMaterial({ color: 0x222232 }),
      head: new THREE.MeshLambertMaterial({ color: 0xe8e0d0 }),
      eye: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      limb: new THREE.MeshLambertMaterial({ color: 0x3a3a4a }),
      wall: new THREE.MeshLambertMaterial({ color: 0x252535 }),
      pillar: new THREE.MeshLambertMaterial({ color: 0x1a1a2a }),
      badge: new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 0.9 }),
    },
  };
}

function labelEl(html: string, cls: string) {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  return d;
}

type Entry = {
  agent: SceneAgent;
  group: THREE.Group;
  screen: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  figure: THREE.Group;
  ring: THREE.Points | null;
  badge: THREE.Mesh | null;
  label: CSS2DObject;
  baseY: number;
  own: (THREE.BufferGeometry | THREE.Material)[]; // per-agent allocations to dispose
};

export function createOfficeScene(container: HTMLElement) {
  const scene = new THREE.Scene();
  const S = makeShared();
  const floorTexSrc = tileTexture("#0d0d14", "#1a1a28");
  const wallTexSrc = tileTexture("#141420", "#1e1e2e");

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  // Deliberately 1, not devicePixelRatio: supersampling averages the tile
  // texels back into a smooth blur, undoing the pixel-art look.
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(labelRenderer.domElement);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 22, 16);
  camera.lookAt(0, 0, -2);

  const controls = new OrbitControls(camera, labelRenderer.domElement.parentElement === container ? renderer.domElement : renderer.domElement);
  controls.target.set(0, 0, -2);
  controls.minPolarAngle = Math.PI / 6;
  controls.maxPolarAngle = Math.PI / 2.2;
  controls.minDistance = 8;
  controls.maxDistance = 35;
  controls.enablePan = true;
  controls.panSpeed = 0.5;
  controls.autoRotate = false;
  controls.enableDamping = true;

  // Brightness pass: the requested 0.3->0.8 / 0.6->1.2 / 0.8->2.0 are increases
  // over the ORIGINAL spec values, but this file never used those (they render
  // near-black under three's physical light units). Applying the same ratios to
  // the values actually in use — 2.67x ambient, 2x key, 2.5x the zone lights —
  // which is what "increase" means here.
  scene.add(new THREE.AmbientLight(0x3a3a4e, 2.2));
  scene.add(new THREE.HemisphereLight(0x5a5a7a, 0x14141c, 1.0));
  const sun = new THREE.DirectionalLight(0xdfe6ff, 3.0);
  sun.position.set(-10, 20, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
  scene.add(sun);

  // --- rooms ---------------------------------------------------------------
  const zoneLabels: Record<string, HTMLElement> = {};
  const roomDisposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  for (const z of ZONES) {
    const r = zoneRect(z);
    const accent = ACCENT[z.id] ?? 0x6b6b7b;

    const floorGeo = new THREE.PlaneGeometry(r.w, r.d);
    const floorTex = floorTexSrc.clone();
    floorTex.needsUpdate = true;
    floorTex.repeat.set(r.w, r.d);
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTex });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(r.cx, 0, r.cz);
    floor.receiveShadow = true;
    scene.add(floor);
    roomDisposables.push(floorGeo, floorMat, floorTex);

    // Back wall (far -z) and left wall (-x). No front/right wall, so the camera
    // looks straight into every room.
    const wallTex = wallTexSrc.clone();
    wallTex.needsUpdate = true;
    wallTex.repeat.set(r.w * 0.75, WALL_H * 0.75);
    const wallMat = new THREE.MeshLambertMaterial({ map: wallTex, color: 0x252535 });
    roomDisposables.push(wallTex, wallMat);
    const backGeo = new THREE.BoxGeometry(r.w, WALL_H, 0.15);
    const back = new THREE.Mesh(backGeo, wallMat);
    back.position.set(r.cx, WALL_H / 2, r.z0);
    back.receiveShadow = true; back.castShadow = true;
    scene.add(back);
    const leftGeo = new THREE.BoxGeometry(0.15, WALL_H, r.d);
    const left = new THREE.Mesh(leftGeo, wallMat);
    left.position.set(r.x0, WALL_H / 2, r.cz);
    left.receiveShadow = true; left.castShadow = true;
    scene.add(left);
    roomDisposables.push(backGeo, leftGeo);

    // Ceiling strip light — pure emissive, throws no shadow.
    const stripGeo = new THREE.BoxGeometry(r.w * 0.92, 0.06, 0.3);
    const stripMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 2 });
    const strip = new THREE.Mesh(stripGeo, stripMat);
    // Against the back wall, NOT the room centre: at this camera angle a
    // centred ceiling strip occludes the desks and agents underneath it.
    strip.position.set(r.cx, WALL_H - 0.1, r.z0 + 0.45);
    scene.add(strip);
    roomDisposables.push(stripGeo, stripMat);

    // Neon floor border. LineSegments can't do linewidth > 1 on most drivers, so
    // each edge is a thin emissive plane laid flat just clear of the floor.
    const NEON = 0.05;
    const neonMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1 });
    roomDisposables.push(neonMat);
    for (const [ex, ez, ew, ed] of [
      [r.cx, r.z0, r.w, NEON], [r.cx, r.z0 + r.d, r.w, NEON],
      [r.x0, r.cz, NEON, r.d], [r.x0 + r.w, r.cz, NEON, r.d],
    ]) {
      const g = new THREE.PlaneGeometry(ew, ed);
      const m = new THREE.Mesh(g, neonMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(ex, 0.02, ez);
      scene.add(m);
      roomDisposables.push(g);
    }

    // Corner pillars.
    const pillarGeo = new THREE.BoxGeometry(0.3, WALL_H, 0.3);
    for (const [px, pz] of [[r.x0, r.z0], [r.x0 + r.w, r.z0], [r.x0, r.z0 + r.d], [r.x0 + r.w, r.z0 + r.d]]) {
      const pil = new THREE.Mesh(pillarGeo, S.mat.pillar);
      pil.position.set(px, WALL_H / 2, pz);
      pil.castShadow = true; pil.receiveShadow = true;
      scene.add(pil);
    }
    roomDisposables.push(pillarGeo);

    // One accent point light per zone at ceiling height — the neon wash.
    // 1.5x the old 26 rather than the full 2.5x: at 65 the accent wash saturates
    // the agents and their body colour (which encodes identity) reads as the room
    // colour instead of their own.
    const pl = new THREE.PointLight(accent, 40, 13, 2);
    pl.position.set(r.cx, WALL_H - 0.35, r.cz);
    pl.castShadow = false;
    scene.add(pl);

    const el = labelEl(`<span class="zl-name">${z.name}</span><span class="zl-count">0/${z.slots.length}</span>`, "zone-label");
    (el.querySelector(".zl-name") as HTMLElement).style.color = `#${accent.toString(16).padStart(6, "0")}`;
    zoneLabels[z.id] = el;
    const lo = new CSS2DObject(el);
    lo.position.set(r.cx, WALL_H + 0.45, r.z0);
    scene.add(lo);
  }

  /** A dim, unoccupied desk on every slot no agent holds. Rebuilt whenever the
   *  population changes; cheap, since it is at most 19 desks of shared geometry. */
  const emptyRoot = new THREE.Group();
  scene.add(emptyRoot);
  // Vacant desks are the SAME desk as an occupied one — shared wood top and legs —
  // so every slot reads as furniture. Only the monitor differs: dark, not lit.
  const emptyScreenMat = new THREE.MeshLambertMaterial({ color: 0x14141c });

  function refreshEmptyDesks() {
    emptyRoot.clear();
    for (const z of ZONES) {
      const taken = new Set([...entries.values()].filter((e) => e.agent.zone === z.id).map((e) => e.agent.slot));
      z.slots.forEach((_sl, i) => {
        if (taken.has(i)) return;
        const pos = slotPos(z, i);
        const g = new THREE.Group();
        g.position.set(pos.x, 0, pos.z);
        // Tagged so a tap on a vacant desk reports (zone, slot) — the same
        // place-a-manual-agent affordance the SVG floor's "+" desks offer.
        g.userData.freeDesk = { zone: z.id, slot: i };
        const top = new THREE.Mesh(S.geo.top, S.mat.deskTop);
        top.position.y = 0.64; top.receiveShadow = true; top.castShadow = true;
        // no figure here, but the desk still catches the room's accent light
        g.add(top);
        for (const [lx, lz] of [[-0.54, -0.29], [0.54, -0.29], [-0.54, 0.29], [0.54, 0.29]]) {
          const leg = new THREE.Mesh(S.geo.leg, S.mat.deskLeg);
          leg.position.set(lx, 0.3, lz);
          g.add(leg);
        }
        const base = new THREE.Mesh(S.geo.monBase, S.mat.monBase);
        base.position.set(0, 0.76, 0.2);
        g.add(base);
        const sc = new THREE.Mesh(S.geo.monScreen, emptyScreenMat);
        sc.position.set(0, 1.06, 0.2);
        g.add(sc);
        g.traverse((o) => { o.userData.freeDesk = { zone: z.id, slot: i }; });
        emptyRoot.add(g);
      });
    }
  }

  // --- agents ---------------------------------------------------------------
  const entries = new Map<string, Entry>();
  const pickables: THREE.Object3D[] = [];

  function buildDesk(color: number, state: AgentState, own: Entry["own"]) {
    const g = new THREE.Group();
    const top = new THREE.Mesh(S.geo.top, S.mat.deskTop);
    top.position.y = 0.64; top.castShadow = true; top.receiveShadow = true;
    g.add(top);
    for (const [lx, lz] of [[-0.54, -0.29], [0.54, -0.29], [-0.54, 0.29], [0.54, 0.29]]) {
      const leg = new THREE.Mesh(S.geo.leg, S.mat.deskLeg);
      leg.position.set(lx, 0.3, lz); leg.castShadow = true;
      g.add(leg);
    }
    const base = new THREE.Mesh(S.geo.monBase, S.mat.monBase);
    base.position.set(0, 0.76, 0.2); base.castShadow = true;
    g.add(base);
    const sc = SCREEN[state];
    const scMat = new THREE.MeshStandardMaterial({ color: sc.color, emissive: sc.color, emissiveIntensity: sc.intensity, roughness: 0.4 });
    own.push(scMat);
    const screen = new THREE.Mesh(S.geo.monScreen, scMat);
    screen.position.set(0, 1.06, 0.2);
    g.add(screen);
    const kb = new THREE.Mesh(S.geo.keyboard, S.mat.keyboard);
    kb.position.set(0, 0.69, -0.1); kb.receiveShadow = true;
    g.add(kb);
    return { group: g, screen };
  }

  function buildFigure(color: number, own: Entry["own"]) {
    // Stacked from the floor up so the whole figure stands on y=0:
    // feet 0-0.10, legs 0.10-0.52, torso 0.52-1.22, head 1.22-1.62.
    const g = new THREE.Group();
    // Slight self-emission so the body keeps its own colour under the room's wash.
    const bodyMat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.35 });
    own.push(bodyMat);
    const body = new THREE.Mesh(S.geo.body, bodyMat);
    body.position.y = 0.87; body.castShadow = true;
    g.add(body);

    const head = new THREE.Mesh(S.geo.head, S.mat.head);
    head.position.y = 1.42; head.castShadow = true;
    g.add(head);
    // Two pixel eyes on the head's front face (+z), unlit so they always read.
    for (const ex of [-0.09, 0.09]) {
      const eye = new THREE.Mesh(S.geo.eye, S.mat.eye);
      eye.position.set(ex, 1.46, 0.201);
      g.add(eye);
    }

    // Arms hang at the sides, angled slightly forward.
    for (const ax of [-0.325, 0.325]) {
      const arm = new THREE.Mesh(S.geo.arm, bodyMat);
      arm.position.set(ax, 0.92, 0.05);
      arm.rotation.x = -0.18;
      arm.castShadow = true;
      g.add(arm);
    }
    // Legs are narrower than the torso, with feet as their own blocks. Both are
    // darkened shades of the body colour rather than a shared flat grey — against
    // a dark floor a neutral limb reads as shadow and the legs vanish.
    const legMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.6) });
    const footMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.32) });
    own.push(legMat, footMat);
    for (const lx of [-0.13, 0.13]) {
      const leg = new THREE.Mesh(S.geo.leg2, legMat);
      leg.position.set(lx, 0.31, 0); leg.castShadow = true;
      g.add(leg);
      const foot = new THREE.Mesh(S.geo.foot, footMat);
      foot.position.set(lx, 0.05, 0.03); foot.castShadow = true;
      g.add(foot);
    }
    return g;
  }

  /** 8 points in a circle above the head — the "thinking" spinner. */
  function buildRing(color: number, own: Entry["own"]) {
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push(Math.cos(a) * 0.28, 0, Math.sin(a) * 0.28);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.09, sizeAttenuation: true });
    own.push(geo, mat);
    const p = new THREE.Points(geo, mat);
    p.position.y = 1.85;
    return p;
  }

  function applyState(e: Entry, state: AgentState) {
    e.agent.state = state;
    const sc = SCREEN[state];
    e.screen.material.color.setHex(sc.color);
    e.screen.material.emissive.setHex(sc.color);
    e.screen.material.emissiveIntensity = sc.intensity;
    if (e.ring) e.ring.visible = state === "thinking";
    if (e.badge) e.badge.visible = state === "awaiting";
    if (state !== "thinking") e.figure.position.y = e.baseY;
  }

  function zoneOf(id: string) { return ZONES.find((z) => z.id === id) || ZONES[3]; }

  function add(agent: SceneAgent) {
    if (entries.has(agent.id)) { update(agent.id, agent.state); return; }
    const z = zoneOf(agent.zone);
    const pos = slotPos(z, agent.slot);
    const idx = [...entries.values()].filter((e) => e.agent.zone === agent.zone).length;
    const color = agent.color ? new THREE.Color(agent.color).getHex() : VARIANTS[idx % VARIANTS.length];
    const own: Entry["own"] = [];

    const group = new THREE.Group();
    group.position.set(pos.x, 0, pos.z);
    const desk = buildDesk(color, agent.state, own);
    group.add(desk.group);
    const figure = buildFigure(color, own);
    // Far side of the desk facing the camera. Full scale and further back than
    // before, so the torso clears the 0.64 desktop instead of hiding behind it.
    figure.position.set(0, 0, -0.95);
    group.add(figure);

    const ring = buildRing(color, own);
    ring.visible = agent.state === "thinking";
    figure.add(ring);
    const badge = new THREE.Mesh(S.geo.badge, S.mat.badge);
    badge.position.y = 1.98;
    badge.visible = agent.state === "awaiting";
    figure.add(badge);

    const el = labelEl(`<span>${agent.name}</span>`, "agent-badge");
    const label = new CSS2DObject(el);
    label.position.set(0, 1.80, -0.95);
    group.add(label);

    group.userData.agentId = agent.id;
    group.traverse((o) => { o.userData.agentId = agent.id; });
    scene.add(group);
    pickables.push(group);

    const e: Entry = { agent: { ...agent }, group, screen: desk.screen, figure, ring, badge, label, baseY: figure.position.y, own };
    entries.set(agent.id, e);
    applyState(e, agent.state);
    refreshCounts();
    refreshEmptyDesks();
  }

  function update(id: string, state: AgentState) {
    const e = entries.get(id);
    if (e) applyState(e, state);
  }

  function disposeObject(root: THREE.Object3D, own: Entry["own"]) {
    // Only per-agent allocations are disposed; the shared geometry/material cache
    // outlives individual agents and is released in destroy().
    for (const d of own) d.dispose();
    root.traverse((o) => {
      const any = o as unknown as { element?: HTMLElement };
      if (any.element && any.element.parentElement) any.element.parentElement.removeChild(any.element);
    });
  }

  function remove(id: string) {
    const e = entries.get(id);
    if (!e) return;
    scene.remove(e.group);
    const i = pickables.indexOf(e.group);
    if (i !== -1) pickables.splice(i, 1);
    disposeObject(e.group, e.own);
    entries.delete(id);
    refreshCounts();
    refreshEmptyDesks();
  }

  function list(): SceneAgent[] { return [...entries.values()].map((e) => ({ ...e.agent })); }

  function clear() { for (const id of [...entries.keys()]) remove(id); }

  /** Replace the whole population — how a floor (session) switch is applied. */
  function setAgents(agents: SceneAgent[]) {
    const want = new Set(agents.map((a) => a.id));
    for (const id of [...entries.keys()]) if (!want.has(id)) remove(id);
    for (const a of agents) {
      const e = entries.get(a.id);
      if (!e) add(a);
      else if (e.agent.state !== a.state) applyState(e, a.state);
    }
  }

  function refreshCounts() {
    for (const z of ZONES) {
      const n = [...entries.values()].filter((e) => e.agent.zone === z.id).length;
      const el = zoneLabels[z.id]?.querySelector(".zl-count") as HTMLElement | null;
      if (el) el.textContent = `${n}/${z.slots.length}`;
    }
  }

  // --- picking --------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = { x: 0, y: 0 };
  const onDown = (ev: PointerEvent) => { downAt = { x: ev.clientX, y: ev.clientY }; };
  const onUp = (ev: PointerEvent) => {
    // Ignore the pointerup that ends an orbit drag — only a real tap selects.
    if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...pickables, emptyRoot], true)[0];
    const id = hit?.object?.userData?.agentId as string | undefined;
    if (id) {
      container.dispatchEvent(new CustomEvent("agentClick", { detail: { id, tabId: entries.get(id)?.agent.id }, bubbles: true }));
      return;
    }
    const free = hit?.object?.userData?.freeDesk as { zone: string; slot: number } | undefined;
    if (free) container.dispatchEvent(new CustomEvent("deskClick", { detail: free, bubbles: true }));
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);

  // --- loop -----------------------------------------------------------------
  let raf = 0;
  let last = 0;
  let labelsFar = false;
  const clock = new THREE.Clock();
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    // Cap to ~60fps; on a 120Hz display this halves the work for no visible change.
    if (now - last < 15.5) return;
    last = now;
    const t = clock.getElapsedTime();
    for (const e of entries.values()) {
      if (e.agent.state === "thinking") {
        e.figure.position.y = e.baseY + Math.sin(t * Math.PI * 2) * 0.1;
        if (e.ring) e.ring.rotation.y = t * 1.6;
      } else if (e.agent.state === "dreaming") {
        // A quarter the rate of "thinking" and a third the travel: it reads as
        // breathing rather than working, which is exactly the distinction.
        e.figure.position.y = e.baseY + Math.sin(t * Math.PI * 0.5) * 0.035;
        const glow = 0.18 + (Math.sin(t * Math.PI * 0.5) + 1) * 0.12;
        e.screen.material.emissiveIntensity = glow;
      } else if (e.agent.state === "awaiting" && e.badge) {
        e.badge.scale.setScalar(1 + Math.sin(t * Math.PI * 4) * 0.2);
        e.badge.rotation.y = t;
      }
    }
    controls.update();
    // Name badges are unreadable past ~24 units out and just crowd the frame.
    const far = camera.position.distanceTo(controls.target) > 24;
    if (far !== labelsFar) {
      labelsFar = far;
      for (const e of entries.values()) (e.label.element as HTMLElement).classList.toggle("far", far);
    }
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  // --- sizing ---------------------------------------------------------------
  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  function destroy() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    renderer.domElement.removeEventListener("pointerdown", onDown);
    renderer.domElement.removeEventListener("pointerup", onUp);
    clear();
    emptyRoot.clear();
    emptyScreenMat.dispose();
    for (const d of roomDisposables) d.dispose();
    for (const g of Object.values(S.geo)) g.dispose();
    for (const m of Object.values(S.mat)) m.dispose();
    floorTexSrc.dispose();
    wallTexSrc.dispose();
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    labelRenderer.domElement.remove();
  }

  return { scene, camera, renderer, controls, add, update, remove, list, clear, setAgents, destroy, resize };
}

/** True when the browser can actually create a WebGL context. Callers fall back to
 *  the SVG floor when this is false. */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}
