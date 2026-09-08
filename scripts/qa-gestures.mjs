#!/usr/bin/env node
/**
 * qa-gestures — MacBook trackpad navigation gate for src/gestureNavigation.js.
 *
 * Drives a REAL Brave (or any Chromium the caller points at) through
 * Playwright and replays the exact event shapes a macOS trackpad produces,
 * then asserts on the live camera. The point is that none of these gestures
 * can be verified from unit tests: the policy arithmetic is covered in
 * src/gestureNavigationPolicy.test.mjs, but whether Cesium actually consumes
 * a CTRL+wheel as a zoom, whether ⌥+drag reaches tilt3D, and whether the
 * solved zoomFactor produces the fraction it solved for are all facts about
 * Cesium's aggregator — they only come out of a browser.
 *
 * ── WHY SYNTHETIC WHEEL EVENTS, NOT page.mouse.wheel ────────────────────────
 *
 * Playwright's `mouse.wheel` emits a browser-generated wheel event with no
 * `wheelDeltaY`, no `ctrlKey`, and integral deltas — i.e. it looks exactly
 * like a notched mouse, which is the one device this module does NOT change.
 * Reproducing a trackpad means dispatching WheelEvents whose `deltaY`,
 * `wheelDeltaY` ratio and `ctrlKey` match what Chromium synthesizes on macOS,
 * so the checks below construct them directly on the canvas.
 *
 * Usage:
 *   node scripts/qa-gestures.mjs [--url http://localhost:4173]
 *                                [--browser "/Applications/Brave Browser.app/..."]
 *                                [--headed]
 * Requires a running dev server (npm run dev -- --host localhost --port 4173).
 */
import { chromium } from 'playwright-core';

const argv = process.argv;
const arg = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);

const url = arg('--url', 'http://localhost:4173');
const executablePath = arg(
  '--browser',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
);
const headless = !argv.includes('--headed');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const browser = await chromium.launch({
  executablePath,
  headless,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`));
  // The first-run mission launcher is a full-width card over the middle of
  // the globe. It is correct product behaviour and it swallows real mouse
  // input, so this harness starts from the returning-visitor state — the
  // same session flag every close path in src/firstRunExperience.js writes.
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('vtr:first-run-mission-session:v1', 'dismissed');
    } catch { /* private mode — the checks below will surface it */ }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__visonTR?.gestureNavigation, { timeout: 120_000 });
  // Boot fly-in, tile warm and deferred init all have to finish before the
  // camera is a trustworthy witness.
  await page.waitForTimeout(15_000);

  /** Park the camera somewhere deterministic and cancel any flight in flight. */
  const park = (height = 3_000, pitchDegrees = -35) => page.evaluate(({ h, p }) => {
    const viewer = window.__visonTR.viewer;
    viewer.camera.cancelFlight();
    viewer.trackedEntity = undefined;
    // Cesium is not exposed on window, so build the destination from the
    // scene's own ellipsoid — the same route scripts/qa-perf.mjs takes.
    const ellipsoid = viewer.scene.globe.ellipsoid;
    viewer.camera.setView({
      destination: ellipsoid.cartographicToCartesian({
        longitude: (-97.7431 * Math.PI) / 180,
        latitude: (30.2672 * Math.PI) / 180,
        height: h,
      }),
      orientation: {
        heading: 0,
        pitch: (p * Math.PI) / 180,
        roll: 0,
      },
    });
    viewer.scene.render();
  }, { h: height, p: pitchDegrees });

  /** Read the live camera in plain units. */
  const readCamera = () => page.evaluate(() => {
    const camera = window.__visonTR.viewer.camera;
    const carto = camera.positionCartographic;
    return {
      height: carto.height,
      lon: (carto.longitude * 180) / Math.PI,
      lat: (carto.latitude * 180) / Math.PI,
      heading: (camera.heading * 180) / Math.PI,
      pitch: (camera.pitch * 180) / Math.PI,
    };
  });

  const diagnostics = () => page.evaluate(
    () => window.__visonTR.gestureNavigation.getDiagnostics(),
  );

  /**
   * Dispatch a burst of trackpad-shaped wheel events on the canvas.
   * `wheelDeltaY = -3 * deltaY` is Chromium's precision-surface ratio; that
   * is the signal classifyWheelDevice reads.
   */
  const trackpadScroll = (opts) => page.evaluate(async ({
    deltaX, deltaY, count, ctrlKey, shiftKey, notched, gapMs,
  }) => {
    const canvas = window.__visonTR.viewer.canvas;
    const rect = canvas.getBoundingClientRect();
    for (let i = 0; i < count; i += 1) {
      const event = new WheelEvent('wheel', {
        deltaX,
        deltaY,
        deltaMode: 0,
        ctrlKey,
        shiftKey,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      // wheelDeltaY is legacy and read-only on the constructor, so it is
      // defined here to reproduce what Chromium actually ships on macOS.
      Object.defineProperty(event, 'wheelDeltaY', {
        value: notched ? Math.round(-1.2 * deltaY) : Math.round(-3 * deltaY),
      });
      canvas.dispatchEvent(event);
      // Cesium consumes aggregated input on the next frame, so each event
      // needs a frame to land rather than collapsing into the last one.
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    // Let the aggregated tail settle.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, {
    deltaX: 0, deltaY: 0, count: 1, ctrlKey: false, shiftKey: false,
    notched: false, gapMs: 0, ...opts,
  });

  console.log(`\nqa-gestures — ${executablePath.split('/').pop()} @ ${url}\n`);

  // Guard the guard: if the launcher ever stops honouring that flag, the
  // real-mouse checks below would silently drag on a card instead of the
  // globe and "fail" for a reason that has nothing to do with gestures.
  const canvasIsClear = await page.evaluate(() => {
    const canvas = window.__visonTR.viewer.canvas;
    return document.elementFromPoint(720, 500) === canvas;
  });
  check('the globe canvas is the hit-test target at screen centre', canvasIsClear);

  // ── 1. Trackpad pinch zooms the globe ────────────────────────────────
  // Chromium delivers a macOS trackpad pinch as ctrl+wheel. Stock Cesium
  // aggregates that under its CTRL modifier and then never consumes it, so
  // before this change a pinch did nothing at all.
  await park(3_000);
  const beforePinch = await readCamera();
  await trackpadScroll({ deltaY: -8, ctrlKey: true, count: 12 });
  const afterPinch = await readCamera();
  check(
    'trackpad pinch zooms in',
    afterPinch.height < beforePinch.height * 0.9,
    { before: Math.round(beforePinch.height), after: Math.round(afterPinch.height) },
  );

  await park(3_000);
  const beforePinchOut = await readCamera();
  await trackpadScroll({ deltaY: 8, ctrlKey: true, count: 12 });
  const afterPinchOut = await readCamera();
  check(
    'trackpad pinch zooms out',
    afterPinchOut.height > beforePinchOut.height * 1.1,
    { before: Math.round(beforePinchOut.height), after: Math.round(afterPinchOut.height) },
  );

  // ── 2. Zoom pacing is acceleration-independent ───────────────────────
  // The whole point of solving zoomFactor per event: the same number of
  // events must travel a comparable distance whether the user crept or
  // flicked. Stock Cesium is linear in delta, so a 25x delta is a 25x step.
  await park(5_000);
  await trackpadScroll({ deltaY: -4, count: 10 });
  const slow = await readCamera();
  await park(5_000);
  await trackpadScroll({ deltaY: -100, count: 10 });
  const fast = await readCamera();
  const slowTravel = 5_000 - slow.height;
  const fastTravel = 5_000 - fast.height;
  const ratio = fastTravel / Math.max(slowTravel, 1);
  check(
    'a flick is bounded against a crawl (both move, within 6x)',
    slowTravel > 100 && fastTravel > slowTravel && ratio < 6,
    { slowTravel: Math.round(slowTravel), fastTravel: Math.round(fastTravel), ratio: Number(ratio.toFixed(2)) },
  );

  // ── 3. Device classification and inertia follow the hardware ─────────
  await park(4_000);
  await trackpadScroll({ deltaY: -6, count: 3 });
  const trackpadDiag = await diagnostics();
  check(
    'trackpad is classified and its OS momentum is not doubled',
    trackpadDiag.device === 'trackpad' && trackpadDiag.inertiaZoom === 0,
    trackpadDiag,
  );

  // A notched wheel must keep Cesium's stock feel — 1.2 is Chromium's
  // mouse ratio, and the memory window has to lapse first.
  await page.waitForTimeout(1_200);
  await trackpadScroll({ deltaY: -100, count: 3, notched: true, gapMs: 400 });
  const mouseDiag = await diagnostics();
  check(
    'notched mouse keeps stock inertia and a stock-scale zoomFactor',
    mouseDiag.device === 'mouse'
      && mouseDiag.inertiaZoom === 0.8
      && Math.abs(mouseDiag.zoomFactor - 5) < 1.5,
    mouseDiag,
  );

  // ── 4. SHIFT + two-finger scroll tilts ───────────────────────────────
  // The gesture a MacBook could not perform at all: stock tilt bindings are
  // MIDDLE_DRAG, touch PINCH and CTRL+drag (which macOS eats).
  await park(3_000, -45);
  const beforeTilt = await readCamera();
  await trackpadScroll({ deltaY: -10, shiftKey: true, count: 12 });
  const afterTilt = await readCamera();
  check(
    'shift + scroll up stands the view up toward the horizon',
    afterTilt.pitch > beforeTilt.pitch + 3,
    { before: Number(beforeTilt.pitch.toFixed(1)), after: Number(afterTilt.pitch.toFixed(1)) },
  );

  await park(3_000, -45);
  await trackpadScroll({ deltaY: 10, shiftKey: true, count: 12 });
  const afterTiltDown = await readCamera();
  check(
    'shift + scroll down returns the view toward top-down',
    afterTiltDown.pitch < -45 - 3,
    { after: Number(afterTiltDown.pitch.toFixed(1)) },
  );

  // The band must hold: no tilting above the horizon, where the ground point
  // the gesture pivots on does not exist. Push hard at it from just below.
  await park(3_000, -10);
  await trackpadScroll({ deltaY: -30, shiftKey: true, count: 40 });
  const pinned = await readCamera();
  check(
    'tilt stops below the horizon instead of flipping the camera',
    pinned.pitch < 0 && pinned.pitch > -12,
    { pitch: Number(pinned.pitch.toFixed(2)) },
  );

  // ── 5. Horizontal two-finger scroll swings heading ───────────────────
  await park(3_000);
  const beforeHeading = await readCamera();
  await trackpadScroll({ deltaX: 20, deltaY: 0, count: 12 });
  const afterHeading = await readCamera();
  const headingSwing = Math.abs(afterHeading.heading - beforeHeading.heading);
  check(
    'horizontal scroll swings the compass',
    headingSwing > 3 && headingSwing < 180,
    { before: Number(beforeHeading.heading.toFixed(1)), after: Number(afterHeading.heading.toFixed(1)) },
  );
  check(
    'a heading gesture parks Cesium zoom so the residual delta cannot zoom',
    Math.abs(afterHeading.height - beforeHeading.height) < beforeHeading.height * 0.02,
    { before: Math.round(beforeHeading.height), after: Math.round(afterHeading.height) },
  );

  // ── 6. The axis lock survives a noisy vertical scroll ────────────────
  // Real trackpad scrolls are never axis-pure. Without the lock the compass
  // would drift a little every single time the user zoomed.
  await park(3_000);
  const beforeNoisy = await readCamera();
  await trackpadScroll({ deltaX: 5, deltaY: -12, count: 12 });
  const afterNoisy = await readCamera();
  check(
    'a diagonal scroll zooms without dragging the compass with it',
    afterNoisy.height < beforeNoisy.height * 0.95
      && Math.abs(afterNoisy.heading - beforeNoisy.heading) < 1,
    {
      heightDelta: Math.round(afterNoisy.height - beforeNoisy.height),
      headingDelta: Number((afterNoisy.heading - beforeNoisy.heading).toFixed(3)),
    },
  );

  // ── 7. ⌥ + drag tilts ────────────────────────────────────────────────
  await park(3_000, -45);
  const beforeAlt = await readCamera();
  await page.keyboard.down('Alt');
  await page.mouse.move(720, 500);
  await page.mouse.down();
  for (let y = 500; y >= 380; y -= 15) {
    await page.mouse.move(720, y);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(400);
  const afterAlt = await readCamera();
  check(
    'option + drag tilts (the binding a MacBook otherwise has no button for)',
    Math.abs(afterAlt.pitch - beforeAlt.pitch) > 2,
    { before: Number(beforeAlt.pitch.toFixed(1)), after: Number(afterAlt.pitch.toFixed(1)) },
  );

  // ── 8. Keyboard navigation ───────────────────────────────────────────
  await park(3_000);
  const beforeArrow = await readCamera();
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(300);
  const afterArrow = await readCamera();
  check(
    'arrow keys pan across the ground without diving into it',
    Math.abs(afterArrow.lat - beforeArrow.lat) > 0.0005
      && Math.abs(afterArrow.height - beforeArrow.height) < beforeArrow.height * 0.05,
    {
      latDelta: Number((afterArrow.lat - beforeArrow.lat).toFixed(5)),
      heightDelta: Math.round(afterArrow.height - beforeArrow.height),
    },
  );

  await park(3_000);
  await page.keyboard.down('Shift');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  const afterTurn = await readCamera();
  check(
    'shift + arrows turn the camera',
    Math.abs(afterTurn.heading) > 3,
    { heading: Number(afterTurn.heading.toFixed(1)) },
  );

  await park(3_000);
  await page.keyboard.down('Equal');
  await page.waitForTimeout(500);
  await page.keyboard.up('Equal');
  await page.waitForTimeout(300);
  const afterKeyZoom = await readCamera();
  check(
    '+ dollies in',
    afterKeyZoom.height < 3_000 * 0.9,
    { height: Math.round(afterKeyZoom.height) },
  );

  // The key loop must let go of its continuous-render hold, or the idle
  // governor never gets the scene back.
  const holdReleased = await page.evaluate(
    () => !window.__visonTR.getRenderGovernorDiagnostics().holds.includes('gesture-nav-keys'),
  );
  check('the keyboard loop releases its render hold on key-up', holdReleased);

  // ── 9. Nothing is claimed that already had an owner ──────────────────
  // The app's global hotkeys (1-7, H, O, V, F, D, C) predate this module.
  await park(3_000);
  const beforeHotkey = await readCamera();
  await page.keyboard.press('KeyD');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
  const afterHotkey = await readCamera();
  check(
    'existing hotkeys still do not move the camera',
    Math.abs(afterHotkey.height - beforeHotkey.height) < 1
      && Math.abs(afterHotkey.heading - beforeHotkey.heading) < 0.01,
  );
  // Put the clean-view toggle back where it was.
  await page.keyboard.press('KeyV');

  // Typing must never fly the globe.
  await park(3_000);
  const beforeTyping = await readCamera();
  await page.evaluate(() => {
    const search = document.getElementById('location-search');
    if (search) { search.classList.add('expanded'); search.focus(); }
  });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  const afterTyping = await readCamera();
  check(
    'arrow keys in a text field belong to the text field',
    Math.abs(afterTyping.lat - beforeTyping.lat) < 1e-6
      && Math.abs(afterTyping.heading - beforeTyping.heading) < 0.01,
  );
  await page.keyboard.press('Escape');

  // ── 10. enableInputs is still the camera's owner-of-record ───────────
  // Cockpit, the CCTV gizmo and GeoJSON flights all take the camera this
  // way. Every handler here has to stand down when they do.
  await park(3_000);
  await page.evaluate(() => {
    window.__visonTR.viewer.scene.screenSpaceCameraController.enableInputs = false;
  });
  const beforeLocked = await readCamera();
  await trackpadScroll({ deltaY: -20, count: 8 });
  await trackpadScroll({ deltaY: -20, shiftKey: true, count: 8 });
  await trackpadScroll({ deltaX: 25, count: 8 });
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowUp');
  const afterLocked = await readCamera();
  await page.evaluate(() => {
    window.__visonTR.viewer.scene.screenSpaceCameraController.enableInputs = true;
  });
  check(
    'every gesture stands down while another owner holds the camera',
    Math.abs(afterLocked.height - beforeLocked.height) < 1
      && Math.abs(afterLocked.heading - beforeLocked.heading) < 0.01
      && Math.abs(afterLocked.pitch - beforeLocked.pitch) < 0.01,
    {
      heightDelta: Number((afterLocked.height - beforeLocked.height).toFixed(3)),
      pitchDelta: Number((afterLocked.pitch - beforeLocked.pitch).toFixed(3)),
    },
  );

  // ── 11. The zoom rate is handed back before a drag can inherit it ────
  await trackpadScroll({ deltaY: -2, count: 2 });
  await page.mouse.move(720, 500);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(100);
  const restored = await diagnostics();
  check(
    'pointer-down restores the shared zoom rate a drag would otherwise inherit',
    Math.abs(restored.zoomFactor - 5) < 0.01 && restored.zoomSuppressed === false,
    restored,
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((r) => r.name).join(' | ')}\n`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
