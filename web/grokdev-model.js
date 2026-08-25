// grokdev-model.js — grokdev: a glossy white orb with two slanted black
// capsule eyes. The grok icon, made flesh. Ported from the original grokdev
// /live cognition page so the brand unit is the same character everywhere.
// It idles by looking around, breathing and blinking; while speaking the gaze
// snaps faster and the eyes pulse signal-green.
// Returns { group, update(t,{speaking}) } via createGrokdev(), or a full
// staged scene via mountScene(canvas).
import * as THREE from "three";

export const PALETTE = {
  shell: 0xf2f2f2,   // glossy white body
  eye: 0x060606,     // black glass capsules
  glow: 0x39ff88,    // signal green (excited/speaking)
  bg: 0x0a0b0e,
};

export function createGrokdev() {
  // outer group = caller's transform handle (position/scale set once by the
  // scene). All animation happens on the inner rig so those offsets survive.
  const group = new THREE.Group();
  const rig = new THREE.Group();
  group.add(rig);

  const R = 1.62;

  /* body: glossy white blob */
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: PALETTE.shell, roughness: 0.3, metalness: 0,
    clearcoat: 0.8, clearcoatRoughness: 0.2,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 96), bodyMat);
  body.castShadow = true;
  rig.add(body);

  /* eyes: two slanted black glass capsules flattened against the surface,
     like the icon. holder = position + blink scale; inner mesh = slant.
     NOTE: no bevel ring — a near-coplanar white rim occludes the black
     capsule at glancing angles and wrecks the face. */
  // matte-leaning black: the z-flattened capsule squashes normals, so a glossy
  // clearcoat turns whichever eye faces the key light into a grey mirror — keep
  // the sheen low and both eyes read as the same solid black from every angle
  const eyeMat = new THREE.MeshPhysicalMaterial({
    color: 0x050505, roughness: 0.55, metalness: 0,
    clearcoat: 0.35, clearcoatRoughness: 0.5,
    emissive: 0x000000, emissiveIntensity: 1,
  });
  function makeEye(r, len, x, y, tilt) {
    const holder = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 8, 32), eyeMat);
    m.rotation.z = tilt; m.scale.set(1, 1, 0.25); // z-flatten only — never stretch
    holder.add(m);                                // x/y or the round caps deform
    const z = Math.sqrt(Math.max(0.1, R * R - x * x - y * y));
    holder.position.set(x, y, z - 0.01);
    holder.rotation.y = Math.asin(x / R) * 0.9;   // follow curvature
    holder.rotation.x = -Math.asin(y / R) * 0.9;
    rig.add(holder);
    return holder;
  }
  /* two clean capsules of the same family, like the icon: same width, same
     "\" slant, left one slightly lower. The left eye faces the camera almost
     head-on while the right is foreshortened by the curvature, so equal radii
     is what actually reads as equal width on screen. */
  const eyeL = makeEye(0.175, 0.46, -0.28, -0.16, 0.52);
  const eyeR = makeEye(0.17, 0.48, 0.52, 0.28, 0.55);

  /* ---------- animation state (t in seconds) ---------- */
  let yaw = 0, pitch = 0, tyaw = 0, tpitch = 0, nextRetarget = 0;
  let blinkStart = -1e9, nextBlink = 2.5;
  let excite = 0, lastT = 0;
  const gcol = new THREE.Color(PALETTE.glow);

  /* blink — time-based so throttled tabs don't get stuck mid-blink */
  function blinkAmount(t) {
    const bt = t - blinkStart;
    if (bt < 0 || bt > 0.36) return 1;
    if (bt < 0.11) return 1 - (bt / 0.11) * 0.92;   // close
    if (bt < 0.18) return 0.08;                     // hold
    return 0.08 + ((bt - 0.18) / 0.18) * 0.92;      // open
  }

  const bot = {
    group, eyeL, eyeR,
    flash: null, // optional green PointLight, wired by mountScene
    update(t, opts = {}) {
      const dt = Math.min(0.1, Math.max(0.001, t - lastT)); lastT = t;
      if (opts.speaking) excite = Math.max(excite, 0.9);

      // idle look-around targets
      if (t >= nextRetarget) {
        tyaw = (Math.random() - 0.5) * 0.55;
        tpitch = (Math.random() - 0.5) * 0.28;
        nextRetarget = t + 2.5 + Math.random() * 4;
      }
      // look around (snappier when excited)
      const k = 0.02 + excite * 0.06;
      yaw += (tyaw - yaw) * k; pitch += (tpitch - pitch) * k;
      rig.rotation.y = yaw + Math.sin(t * 0.4) * 0.06 + (excite > 0.4 ? (Math.random() - 0.5) * 0.02 * excite : 0);
      rig.rotation.x = pitch * 0.6 + Math.sin(t * 0.7) * 0.03;
      rig.position.y = Math.sin(t * 1.1) * 0.07;
      // breathing + excite pulse
      const s = 1 + Math.sin(t * 1.6) * 0.012 + excite * 0.02 * Math.sin(t * 30);
      rig.scale.setScalar(s);
      // blink
      if (t >= nextBlink) { blinkStart = t; nextBlink = t + 2.6 + Math.random() * 4.5; }
      const blink = blinkAmount(t);
      eyeL.scale.y = blink; eyeR.scale.y = blink;
      // excitement: eyes stay black in normal ops; only real spikes flash green.
      // while speaking the spike is modulated so it reads as a voice meter.
      const spike = Math.max(0, excite - 0.45) * 1.6 * (opts.speaking ? 0.7 + 0.3 * Math.abs(Math.sin(t * 9)) : 1);
      eyeMat.emissive.copy(gcol).multiplyScalar(spike);
      if (bot.flash) bot.flash.intensity = spike * 2.6;
      excite = Math.max(0, excite - dt * 0.36);
    },
  };
  return bot;
}

// Full ready-to-render scene (lights + shadow ground + framing).
export function mountScene(canvas, { transparent = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (!transparent) renderer.setClearColor(PALETTE.bg, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.3, 7.2);
  camera.lookAt(0, 0, 0);

  /* lighting: soft studio, like the original render */
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(-2.5, 3.5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.camera.left = -6; key.shadow.camera.right = 6;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004; key.shadow.radius = 6;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(2.5, -0.5, 3); scene.add(fill);
  const rim = new THREE.DirectionalLight(0x9fb4cc, 0.5); rim.position.set(2, 1.5, -4); scene.add(rim);
  const flash = new THREE.PointLight(PALETTE.glow, 0, 12); flash.position.set(0, 0.4, 3); scene.add(flash);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2.1;
  ground.receiveShadow = true;
  scene.add(ground);

  const bot = createGrokdev();
  bot.flash = flash;
  scene.add(bot.group);

  function resize() {
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const clock = new THREE.Clock();
  let speaking = false;
  function loop() {
    requestAnimationFrame(loop);
    bot.update(clock.getElapsedTime(), { speaking });
    renderer.render(scene, camera);
  }
  resize(); addEventListener("resize", resize); loop();

  // ground is exposed so a scene that repositions/scales the bot can pull the
  // shadow plane up to sit right under it (a low-hanging shadow reads as the
  // model bleeding past the HUD's bottom line)
  return { setSpeaking: (v) => { speaking = v; }, resize, scene, camera, renderer, bot, ground };
}
