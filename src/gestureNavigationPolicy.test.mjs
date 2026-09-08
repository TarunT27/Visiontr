import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CESIUM_MAXIMUM_MOVEMENT_RATIO,
  GESTURE_TUNING,
  POINTER_DEVICE,
  SCROLL_AXIS,
  WHEEL_ARC_RADIANS_PER_DELTA,
  classifyWheelDevice,
  isPitchStepAllowed,
  keyboardStepSizes,
  pinchScaleFraction,
  resetScrollGesture,
  resolveNavigationKey,
  resolveScrollGesture,
  shouldIgnoreNavigationKey,
  scrollEffort,
  solveWheelZoomFactor,
  zoomFractionCeiling,
} from './gestureNavigationPolicy.js';

/** Reproduce Cesium's handleZoom fraction for a solved zoomFactor. */
const cesiumZoomFraction = (zoomFactor, magnitude, canvasHeight) => zoomFactor * Math.min(
  (WHEEL_ARC_RADIANS_PER_DELTA * magnitude) / canvasHeight,
  CESIUM_MAXIMUM_MOVEMENT_RATIO,
);

test('Chrome wheelDelta ratio identifies the trackpad and the notched mouse exactly', () => {
  const state = {};
  // Chrome divides wheelDeltaY by 3 for a precision surface, 1.2 for a wheel.
  assert.equal(
    classifyWheelDevice({ deltaY: 4, wheelDeltaY: -12 }, state, 0),
    POINTER_DEVICE.TRACKPAD,
  );
  assert.equal(
    classifyWheelDevice({ deltaY: 100, wheelDeltaY: -120 }, {}, 0),
    POINTER_DEVICE.MOUSE,
  );
  // A 40-unit trackpad delta yields wheelDeltaY -120, which a naive
  // "multiple of 120" test would call a mouse. The ratio does not.
  assert.equal(
    classifyWheelDevice({ deltaY: 40, wheelDeltaY: -120 }, {}, 0),
    POINTER_DEVICE.TRACKPAD,
  );
});

test('classification falls back to delta shape when no wheelDelta is exposed', () => {
  assert.equal(classifyWheelDevice({ deltaY: 3.5 }, {}, 0), POINTER_DEVICE.TRACKPAD);
  assert.equal(classifyWheelDevice({ deltaY: 12, deltaX: -3 }, {}, 0), POINTER_DEVICE.TRACKPAD);
  assert.equal(classifyWheelDevice({ deltaY: 8 }, {}, 0), POINTER_DEVICE.TRACKPAD);
  assert.equal(classifyWheelDevice({ deltaY: 120 }, {}, 0), POINTER_DEVICE.MOUSE);
  // DOM_DELTA_LINE is Firefox's notched-mouse signal.
  assert.equal(classifyWheelDevice({ deltaY: 3, deltaMode: 1 }, {}, 0), POINTER_DEVICE.MOUSE);
});

test('a trackpad classification stays sticky across a momentum tail', () => {
  const state = {};
  assert.equal(classifyWheelDevice({ deltaY: 2.5 }, state, 1000), POINTER_DEVICE.TRACKPAD);
  // Mid-flick momentum can look exactly like a notch; memory keeps the feel
  // stable instead of flipping devices under the user's fingers.
  assert.equal(classifyWheelDevice({ deltaY: 120 }, state, 1200), POINTER_DEVICE.TRACKPAD);
  // Past the memory window it is free to be a mouse again.
  assert.equal(
    classifyWheelDevice({ deltaY: 120 }, state, 1000 + GESTURE_TUNING.trackpadMemoryMs + 1),
    POINTER_DEVICE.MOUSE,
  );
});

test('effort lifts small deltas and saturates at one full notch', () => {
  assert.equal(scrollEffort(0), 0);
  assert.equal(scrollEffort(GESTURE_TUNING.wheelReferenceDelta), 1);
  assert.equal(scrollEffort(500), 1, 'beyond a notch stays saturated — flicks cannot compound');
  const slow = scrollEffort(1);
  const medium = scrollEffort(20);
  assert.ok(slow > 0.1, `a 1-unit crawl must still register (got ${slow})`);
  assert.ok(medium > slow && medium < 1);
  // Sublinear: 20x the delta must be far less than 20x the effect.
  assert.ok(medium < slow * 20);
});

test('the solved zoomFactor makes Cesium consume the intended view fraction', () => {
  const canvasHeight = 900;
  for (const magnitude of [1, 4, 20, 60, 100]) {
    const effort = scrollEffort(magnitude);
    const zoomFactor = solveWheelZoomFactor({
      magnitude,
      canvasHeight,
      maxFraction: GESTURE_TUNING.trackpadZoomFractionMax,
    });
    const applied = cesiumZoomFraction(zoomFactor, magnitude, canvasHeight);
    const intended = GESTURE_TUNING.trackpadZoomFractionMax * effort;
    assert.ok(
      Math.abs(applied - intended) < 1e-9,
      `magnitude ${magnitude}: applied ${applied} vs intended ${intended}`,
    );
  }
});

test('a paced trackpad zoom is bounded even when acceleration is not', () => {
  const canvasHeight = 900;
  const fractionFor = (magnitude) => cesiumZoomFraction(
    solveWheelZoomFactor({
      magnitude,
      canvasHeight,
      maxFraction: GESTURE_TUNING.trackpadZoomFractionMax,
    }),
    magnitude,
    canvasHeight,
  );
  // Stock Cesium is linear in delta, so a 200x delta is a 200x step. Here a
  // hard flick may never take more than the ceiling.
  assert.ok(fractionFor(200) <= GESTURE_TUNING.trackpadZoomFractionMax + 1e-9);
  // …and a crawl is no longer imperceptible.
  assert.ok(fractionFor(1) > 0.004, `crawl fraction ${fractionFor(1)} must be usable`);
  assert.ok(fractionFor(1) < fractionFor(20));
});

test('a full mouse notch keeps Cesium stock feel', () => {
  const zoomFactor = solveWheelZoomFactor({
    magnitude: 100,
    canvasHeight: 900,
    maxFraction: GESTURE_TUNING.mouseZoomFractionMax,
  });
  // Cesium's own default is 5; a notch should land next to it, not somewhere new.
  assert.ok(Math.abs(zoomFactor - 5) < 0.5, `notch zoomFactor ${zoomFactor} drifted from stock 5`);
});

test('solveWheelZoomFactor is bounded and safe on degenerate input', () => {
  assert.equal(solveWheelZoomFactor({}), GESTURE_TUNING.zoomFactorMin);
  assert.equal(
    solveWheelZoomFactor({ magnitude: 0, canvasHeight: 900, maxFraction: 0.05 }),
    GESTURE_TUNING.zoomFactorMin,
  );
  assert.equal(
    solveWheelZoomFactor({ magnitude: 10, canvasHeight: 0, maxFraction: 0.05 }),
    GESTURE_TUNING.zoomFactorMin,
  );
  const tiny = solveWheelZoomFactor({ magnitude: 0.001, canvasHeight: 900, maxFraction: 0.05 });
  assert.ok(tiny <= GESTURE_TUNING.zoomFactorMax);
});

test('zoom ceilings differ per device and pinch takes its own', () => {
  assert.equal(
    zoomFractionCeiling(POINTER_DEVICE.TRACKPAD, false),
    GESTURE_TUNING.trackpadZoomFractionMax,
  );
  assert.equal(
    zoomFractionCeiling(POINTER_DEVICE.MOUSE, false),
    GESTURE_TUNING.mouseZoomFractionMax,
  );
  assert.equal(
    zoomFractionCeiling(POINTER_DEVICE.TRACKPAD, true),
    GESTURE_TUNING.pinchZoomFractionMax,
  );
});

test('a vertical scroll claims zoom and holds it through horizontal noise', () => {
  const state = {};
  assert.equal(resolveScrollGesture(state, { deltaY: -6, deltaX: 0 }, 0).axis, SCROLL_AXIS.ZOOM);
  // Real trackpad scrolls are never axis-pure; the lock is what stops the
  // compass drifting every time the user zooms.
  assert.equal(resolveScrollGesture(state, { deltaY: -5, deltaX: 9 }, 30).axis, SCROLL_AXIS.ZOOM);
  assert.equal(resolveScrollGesture(state, { deltaY: -1, deltaX: 4 }, 60).axis, SCROLL_AXIS.ZOOM);
});

test('a decisively horizontal scroll claims heading, and only after an idle gap', () => {
  const state = {};
  assert.equal(resolveScrollGesture(state, { deltaX: 12, deltaY: 1 }, 0).axis, SCROLL_AXIS.HEADING);
  assert.equal(resolveScrollGesture(state, { deltaX: 9, deltaY: 6 }, 40).axis, SCROLL_AXIS.HEADING);
  // A new gesture after the idle gap re-decides.
  const later = GESTURE_TUNING.gestureIdleMs + 41;
  assert.equal(resolveScrollGesture(state, { deltaX: 1, deltaY: 8 }, later).axis, SCROLL_AXIS.ZOOM);
});

test('the dominance ratio keeps a diagonal scroll on the zoom axis', () => {
  const state = {};
  // 1.5x horizontal is under the 1.6 threshold: still zoom.
  assert.equal(resolveScrollGesture(state, { deltaX: 15, deltaY: 10 }, 0).axis, SCROLL_AXIS.ZOOM);
  resetScrollGesture(state);
  assert.equal(resolveScrollGesture(state, { deltaX: 20, deltaY: 10 }, 0).axis, SCROLL_AXIS.HEADING);
});

test('SHIFT overrides the lock to tilt, on whichever axis the browser used', () => {
  const state = {};
  resolveScrollGesture(state, { deltaY: -8 }, 0);
  const tilt = resolveScrollGesture(state, { deltaY: -8, shiftKey: true }, 20);
  assert.equal(tilt.axis, SCROLL_AXIS.TILT);
  assert.equal(tilt.sign, 1, 'fingers away from you stands the view up toward the horizon');
  // Chrome transposes SHIFT+wheel onto deltaX for a notched mouse.
  const transposed = resolveScrollGesture({}, { deltaX: 40, deltaY: 0, shiftKey: true }, 0);
  assert.equal(transposed.axis, SCROLL_AXIS.TILT);
  assert.equal(transposed.magnitude, 40);
  // Releasing SHIFT mid-scroll re-decides rather than inheriting the tilt lock.
  const after = resolveScrollGesture(state, { deltaY: -8 }, 30);
  assert.equal(after.axis, SCROLL_AXIS.ZOOM);
});

test('scroll signs follow the direction the fingers move the world', () => {
  assert.equal(resolveScrollGesture({}, { deltaY: -10 }, 0).sign, 1, 'scroll up zooms in');
  assert.equal(resolveScrollGesture({}, { deltaY: 10 }, 0).sign, -1, 'scroll down zooms out');
  assert.equal(resolveScrollGesture({}, { deltaX: -30, deltaY: 0 }, 0).sign, -1);
  assert.equal(resolveScrollGesture({}, { deltaX: 30, deltaY: 0 }, 0).sign, 1);
});

test('resetScrollGesture reopens the axis decision', () => {
  const state = {};
  resolveScrollGesture(state, { deltaX: 30, deltaY: 0 }, 0);
  assert.equal(state.axis, SCROLL_AXIS.HEADING);
  resetScrollGesture(state);
  assert.equal(state.axis, undefined);
  assert.equal(resolveScrollGesture(state, { deltaY: -8 }, 5).axis, SCROLL_AXIS.ZOOM);
});

test('tilt steps stay inside the orbit band', () => {
  const { minPitchRadians: min, maxPitchRadians: max } = GESTURE_TUNING;
  const mid = (min + max) / 2;
  assert.ok(isPitchStepAllowed(mid, mid + 0.01));
  assert.ok(!isPitchStepAllowed(max - 0.001, max + 0.05), 'cannot tilt above the horizon');
  assert.ok(!isPitchStepAllowed(min + 0.001, min - 0.05), 'cannot tilt past straight down');
});

test('a camera parked outside the band can always tilt back into it', () => {
  const { maxPitchRadians: max } = GESTURE_TUNING;
  // A share link or a layer flight can leave the camera at the horizon; the
  // gesture must not be a trap there.
  const outside = max + 0.4;
  assert.ok(isPitchStepAllowed(outside, outside - 0.1), 'a step toward the band is allowed');
  assert.ok(!isPitchStepAllowed(outside, outside + 0.1), 'a step further out is not');
  assert.ok(isPitchStepAllowed(outside, max - 0.01), 'a step all the way in is allowed');
});

test('isPitchStepAllowed rejects non-finite results', () => {
  assert.equal(isPitchStepAllowed(-0.5, Number.NaN), false);
  assert.equal(isPitchStepAllowed(Number.NaN, 99), false);
});

test('pinch scale differences map to a bounded dolly fraction', () => {
  assert.equal(pinchScaleFraction(1), 0);
  assert.ok(pinchScaleFraction(1.1) > 0, 'spreading the fingers moves closer');
  assert.ok(pinchScaleFraction(0.9) < 0, 'pinching in moves away');
  assert.equal(pinchScaleFraction(0), 0);
  assert.equal(pinchScaleFraction(Number.NaN), 0);
  const ceiling = GESTURE_TUNING.pinchZoomFractionMax * 4;
  assert.ok(Math.abs(pinchScaleFraction(1000)) <= ceiling);
  assert.ok(Math.abs(pinchScaleFraction(0.001)) <= ceiling);
});

test('arrow keys pan, SHIFT+arrows turn and tilt, +/- dolly', () => {
  assert.deepEqual(resolveNavigationKey({ key: 'ArrowUp' }), { action: 'pan', axis: 'forward', sign: 1 });
  assert.deepEqual(resolveNavigationKey({ key: 'ArrowLeft' }), { action: 'pan', axis: 'strafe', sign: -1 });
  assert.deepEqual(resolveNavigationKey({ key: 'ArrowUp', shiftKey: true }), { action: 'tilt', sign: 1 });
  assert.deepEqual(resolveNavigationKey({ key: 'ArrowRight', shiftKey: true }), { action: 'heading', sign: 1 });
  assert.deepEqual(resolveNavigationKey({ key: '=' }), { action: 'zoom', sign: 1 });
  assert.deepEqual(resolveNavigationKey({ key: '+', shiftKey: true }), { action: 'zoom', sign: 1 });
  assert.deepEqual(resolveNavigationKey({ key: '-' }), { action: 'zoom', sign: -1 });
});

test('navigation keys never claim the app\'s existing hotkeys or system chords', () => {
  // 1-7, H, O, V, F, D and C already belong to StyleManager's global handler.
  for (const key of ['1', '7', 'h', 'o', 'v', 'f', 'd', 'c', 'w', 'a', 's']) {
    assert.equal(resolveNavigationKey({ key }), null, `${key} must stay with its owner`);
  }
  // ⌘←, ⌥←, ⌃← are browser/OS navigation — never intercepted.
  assert.equal(resolveNavigationKey({ key: 'ArrowLeft', metaKey: true }), null);
  assert.equal(resolveNavigationKey({ key: 'ArrowLeft', altKey: true }), null);
  assert.equal(resolveNavigationKey({ key: 'ArrowLeft', ctrlKey: true }), null);
});

test('typing and cockpit mode suppress navigation keys', () => {
  const inField = { target: { closest: (selector) => (selector.includes('input') ? {} : null) } };
  assert.equal(shouldIgnoreNavigationKey(inField), true);
  const onCanvas = { target: { closest: () => null } };
  assert.equal(shouldIgnoreNavigationKey(onCanvas), false);
  assert.equal(shouldIgnoreNavigationKey(onCanvas, { cockpitActive: true }), true);
  assert.equal(shouldIgnoreNavigationKey(onCanvas, { inputsEnabled: false }), true);
  assert.equal(shouldIgnoreNavigationKey({}), false);
});

test('keyboard steps scale with view distance and survive a stalled frame', () => {
  const near = keyboardStepSizes(500, 1 / 60);
  const far = keyboardStepSizes(500000, 1 / 60);
  assert.ok(far.pan > near.pan * 100, 'panning must cover ground from orbit');
  assert.equal(near.turn, far.turn, 'angular rates are distance-independent');

  // A backgrounded tab resumes with a huge dt; clamping stops one enormous leap.
  const stalled = keyboardStepSizes(500, 30);
  const clamped = keyboardStepSizes(500, GESTURE_TUNING.keyboardMaxStepSeconds);
  assert.equal(stalled.pan, clamped.pan);

  // At ground level the height-proportional speed would vanish without a
  // floor. Steps are speed x the clamped dt, so read the speed back out.
  const dt = GESTURE_TUNING.keyboardMaxStepSeconds;
  assert.equal(keyboardStepSizes(0, 1).pan / dt, GESTURE_TUNING.keyboardMinSpeedMetersPerSecond);
  assert.equal(
    keyboardStepSizes(Number.NaN, 1).pan / dt,
    GESTURE_TUNING.keyboardMinSpeedMetersPerSecond,
  );
});
