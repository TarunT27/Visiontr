/**
 * Precision-trackpad navigation policy — the pure decisions behind the
 * MacBook gesture layer in src/gestureNavigation.js.
 *
 * Cesium's stock camera bindings were designed for a three-button mouse with
 * a notched wheel, and three of its assumptions break on a MacBook:
 *
 * 1. **Tilt is unreachable.** Stock `tiltEventTypes` are MIDDLE_DRAG (no
 *    middle button exists), touch PINCH (a trackpad emits no touch events),
 *    and CTRL+drag — which macOS reinterprets as a secondary click. A laptop
 *    user simply cannot pitch the camera.
 * 2. **Pinch does nothing.** Chrome/Firefox deliver a trackpad pinch as a
 *    `wheel` event with `ctrlKey`. Cesium's aggregator *does* record that
 *    under the CTRL modifier, but `zoomEventTypes` only lists the bare WHEEL,
 *    so the movement is aggregated and then dropped on the floor.
 * 3. **Wheel zoom is unpaced.** Cesium's zoom step is linear in `deltaY`
 *    (`zoomFactor * 7.5°-of-arc per delta unit / canvas height`). A notched
 *    mouse always sends ±100, so that is stable. macOS scroll acceleration
 *    sends anywhere from 0.5 to 200 for the *same* physical finger travel, so
 *    a careful scroll barely moves and a flick teleports you to the pavement.
 *
 * This module holds the arithmetic and the state machines for the fixes; the
 * Cesium wiring lives next door in gestureNavigation.js so this file stays
 * dependency-free and unit-testable.
 *
 * The unifying idea is **effort**: one acceleration-flattened 0..1 number per
 * wheel event, derived from `|delta|` through a sublinear curve. Zoom, tilt,
 * and heading all scale off that single quantity, so a given finger motion
 * produces a proportionate amount of *whatever* the current gesture axis is.
 */

/**
 * Radians of arc Cesium's CameraEventAggregator synthesizes per unit of wheel
 * delta (`7.5 * toRadians(delta)` in listenToWheel). Inverting the zoom
 * formula to solve for a target zoom fraction needs this constant.
 * @type {number}
 */
export const WHEEL_ARC_RADIANS_PER_DELTA = (7.5 * Math.PI) / 180;

/**
 * Cesium's own `maximumMovementRatio` default. handleZoom clamps
 * `arcLength / canvasHeight` to this before multiplying by `zoomFactor`, so
 * the inversion below has to clamp identically or it would over-solve.
 * @type {number}
 */
export const CESIUM_MAXIMUM_MOVEMENT_RATIO = 0.1;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Every tunable in one frozen table, so a feel complaint has exactly one
 * place to be answered and the unit tests can assert against named values
 * rather than magic numbers buried in the wiring.
 */
export const GESTURE_TUNING = Object.freeze({
  /** Delta magnitude treated as "one full mouse notch" — the effort curve's 1.0. */
  wheelReferenceDelta: 100,
  /**
   * Effort curve exponent. Below 1 it lifts small deltas (a slow trackpad
   * scroll becomes usable) while compressing large ones (a flick stops
   * teleporting). 0.45 was picked so a 1-unit delta lands at ~13% effort and
   * a 20-unit delta at ~49%.
   */
  zoomResponseExponent: 0.45,
  /** Peak fraction of the current view distance a single trackpad event may consume. */
  trackpadZoomFractionMax: 0.05,
  /**
   * Peak fraction for a notched mouse. Solved so a full notch reproduces
   * Cesium's stock feel (stock zoomFactor 5 ≈ 7.3% per notch at 900 px) —
   * mouse users should notice nothing at all.
   */
  mouseZoomFractionMax: 0.075,
  /** Peak fraction for a pinch, which travels less finger distance per unit of intent. */
  pinchZoomFractionMax: 0.09,
  /** Bounds on the solved zoomFactor, guarding the divide-by-tiny-ratio tail. */
  zoomFactorMin: 1,
  zoomFactorMax: 400,
  /**
   * Cesium's zoom inertia, per device. macOS already synthesizes momentum
   * wheel events after the fingers lift, so Cesium inertia on top of that is
   * a second spring on the same mass — it overshoots. A notched mouse has no
   * OS momentum, so it keeps the stock 0.8.
   */
  trackpadInertiaZoom: 0,
  mouseInertiaZoom: 0.8,
  /**
   * How long a trackpad classification stays sticky. Momentum tails can look
   * like mouse notches (large, integral deltas); without memory a single
   * flick would flip devices mid-gesture and change the feel underneath the
   * user's fingers.
   */
  trackpadMemoryMs: 900,
  /** Idle gap that ends a scroll gesture and re-opens the axis decision. */
  gestureIdleMs: 140,
  /**
   * How much horizontal travel must beat vertical travel to claim the
   * heading axis. Two-finger scrolls are never perfectly axis-aligned, so an
   * unweighted comparison would spin the compass during ordinary zooming.
   */
  horizontalDominance: 1.6,
  /** Heading swept by one full notch of effort. */
  headingRadiansPerNotch: toRadians(2.2),
  /** Pitch swept by one full notch of effort. */
  tiltRadiansPerNotch: toRadians(1.5),
  /**
   * Pitch band for gesture tilt. The gesture orbits the ground point at
   * screen centre, and a camera above the horizon has no such point — so the
   * band stops just short of it. Looking up at the sky remains available on
   * SHIFT+drag (Cesium's `look`), which is a free-look, not an orbit.
   */
  minPitchRadians: toRadians(-89),
  maxPitchRadians: toRadians(-2),
  /** Keyboard pan speed as a fraction of view height per second. */
  keyboardPanHeightFraction: 0.55,
  /** Keyboard dolly speed as a fraction of view height per second. */
  keyboardZoomHeightFraction: 0.9,
  keyboardTurnRadiansPerSecond: toRadians(45),
  keyboardTiltRadiansPerSecond: toRadians(30),
  /** Floor so arrow keys still crawl when the camera is metres off the deck. */
  keyboardMinSpeedMetersPerSecond: 4,
  /** dt clamp, so a stalled tab does not resume with one enormous leap. */
  keyboardMaxStepSeconds: 0.05,
});

/** Wheel devices this policy distinguishes. */
export const POINTER_DEVICE = Object.freeze({
  TRACKPAD: 'trackpad',
  MOUSE: 'mouse',
});

/** Scroll axes a two-finger gesture can claim. */
export const SCROLL_AXIS = Object.freeze({
  ZOOM: 'zoom',
  HEADING: 'heading',
  TILT: 'tilt',
});

/**
 * Delta magnitude at or above which an integral, axis-locked wheel event is
 * assumed to be a notched mouse. Only consulted when the browser gives us no
 * `wheelDelta` ratio to read.
 */
const MOUSE_DELTA_FLOOR = 40;

/** Chrome derives `deltaY` from `wheelDeltaY` by this divisor on a trackpad. */
const CHROME_TRACKPAD_WHEEL_RATIO = 3;
/** …and by this one for a notched mouse. Distinguishing the two is exact. */
const CHROME_MOUSE_WHEEL_RATIO = 1.2;
const WHEEL_RATIO_EPSILON = 0.05;

/**
 * Classify the device behind a wheel event.
 *
 * The strong signal is Chrome's own normalization ratio: it divides
 * `wheelDeltaY` by 3 for a precision trackpad and by 1.2 for a notched wheel,
 * so `wheelDeltaY / -deltaY` reads the device straight off the event. Firefox
 * exposes no `wheelDelta` but reports a notched mouse as DOM_DELTA_LINE, and
 * Safari follows Chrome's trackpad ratio. Everything after that is fallback.
 *
 * @param {{deltaMode?: number, deltaX?: number, deltaY?: number,
 *   wheelDeltaY?: number}} event Wheel event (or a plain shape, in tests).
 * @param {{lastTrackpadAtMs?: number}} state Mutable classifier memory.
 * @param {number} nowMs Monotonic timestamp for the stickiness window.
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {'trackpad'|'mouse'} The classification for this event.
 */
export function classifyWheelDevice(event, state = {}, nowMs = 0, tuning = GESTURE_TUNING) {
  const deltaMode = Number(event?.deltaMode ?? 0);
  const deltaX = Number(event?.deltaX ?? 0);
  const deltaY = Number(event?.deltaY ?? 0);
  const wheelDeltaY = event?.wheelDeltaY;

  let device = POINTER_DEVICE.MOUSE;
  if (deltaMode !== 0) {
    // DOM_DELTA_LINE / DOM_DELTA_PAGE are only ever produced for notched input.
    device = POINTER_DEVICE.MOUSE;
  } else if (Number.isFinite(wheelDeltaY) && deltaY !== 0) {
    const ratio = Math.abs(wheelDeltaY / deltaY);
    if (Math.abs(ratio - CHROME_TRACKPAD_WHEEL_RATIO) < WHEEL_RATIO_EPSILON) {
      device = POINTER_DEVICE.TRACKPAD;
    } else if (Math.abs(ratio - CHROME_MOUSE_WHEEL_RATIO) < WHEEL_RATIO_EPSILON) {
      device = POINTER_DEVICE.MOUSE;
    } else {
      device = Math.abs(deltaY) < MOUSE_DELTA_FLOOR
        ? POINTER_DEVICE.TRACKPAD
        : POINTER_DEVICE.MOUSE;
    }
  } else if (!Number.isInteger(deltaY) || !Number.isInteger(deltaX)) {
    // Fractional deltas are only ever emitted by a precision surface.
    device = POINTER_DEVICE.TRACKPAD;
  } else if (deltaX !== 0) {
    // A notched wheel has no horizontal axis to report.
    device = POINTER_DEVICE.TRACKPAD;
  } else if (Math.abs(deltaY) < MOUSE_DELTA_FLOOR) {
    device = POINTER_DEVICE.TRACKPAD;
  }

  if (device === POINTER_DEVICE.TRACKPAD) {
    state.lastTrackpadAtMs = nowMs;
    return POINTER_DEVICE.TRACKPAD;
  }
  // Momentum tails often look notched. Once we have seen the trackpad, stay
  // on it until the user has been idle long enough to have swapped hardware.
  if (Number.isFinite(state.lastTrackpadAtMs)
    && nowMs - state.lastTrackpadAtMs < tuning.trackpadMemoryMs) {
    return POINTER_DEVICE.TRACKPAD;
  }
  return POINTER_DEVICE.MOUSE;
}

/**
 * Flatten macOS scroll acceleration into a 0..1 "effort" for one event.
 *
 * @param {number} magnitude Absolute wheel delta for the active axis.
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {number} Effort in [0, 1]; 0 when there was no movement.
 */
export function scrollEffort(magnitude, tuning = GESTURE_TUNING) {
  const size = Math.abs(Number(magnitude) || 0);
  if (!(size > 0)) return 0;
  const reference = tuning.wheelReferenceDelta;
  return Math.min(size, reference) === reference
    ? 1
    : (size / reference) ** tuning.zoomResponseExponent;
}

/**
 * Solve the `zoomFactor` that makes Cesium consume exactly the intended
 * fraction of the current view distance for this one wheel event.
 *
 * Cesium computes `distance = zoomFactor * viewDistance * min(arcLength /
 * canvasHeight, maximumMovementRatio)`, where `arcLength` is a fixed multiple
 * of the wheel delta. Everything but `zoomFactor` is known at event time, so
 * the desired fraction can be dialled in directly — which is what turns an
 * acceleration-dependent zoom into a paced one.
 *
 * @param {object} options
 * @param {number} options.magnitude Absolute wheel delta.
 * @param {number} options.canvasHeight Canvas client height in CSS pixels.
 * @param {number} options.maxFraction Peak view-distance fraction for the device.
 * @param {number} [options.effort] Precomputed effort; derived when omitted.
 * @param {typeof GESTURE_TUNING} [options.tuning]
 * @returns {number} A `zoomFactor` for `scene.screenSpaceCameraController`.
 */
export function solveWheelZoomFactor({
  magnitude,
  canvasHeight,
  maxFraction,
  effort,
  tuning = GESTURE_TUNING,
} = {}) {
  const size = Math.abs(Number(magnitude) || 0);
  const height = Number(canvasHeight) || 0;
  if (!(size > 0) || !(height > 0)) return tuning.zoomFactorMin;
  const ratio = Math.min(
    (WHEEL_ARC_RADIANS_PER_DELTA * size) / height,
    CESIUM_MAXIMUM_MOVEMENT_RATIO,
  );
  if (!(ratio > 0)) return tuning.zoomFactorMin;
  const fraction = maxFraction * (Number.isFinite(effort) ? effort : scrollEffort(size, tuning));
  return Math.min(Math.max(fraction / ratio, tuning.zoomFactorMin), tuning.zoomFactorMax);
}

/**
 * Peak zoom fraction for a classified event.
 * @param {'trackpad'|'mouse'} device
 * @param {boolean} isPinch Whether the event carried the pinch (CTRL) modifier.
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {number}
 */
export function zoomFractionCeiling(device, isPinch, tuning = GESTURE_TUNING) {
  if (isPinch) return tuning.pinchZoomFractionMax;
  return device === POINTER_DEVICE.TRACKPAD
    ? tuning.trackpadZoomFractionMax
    : tuning.mouseZoomFractionMax;
}

/**
 * Decide what a two-finger scroll event should drive, with a per-gesture axis
 * lock.
 *
 * The lock exists because trackpad scrolls are never axis-pure: a vertical
 * zoom carries a few units of horizontal noise, and without a lock the
 * compass would drift every time you zoomed. The axis is chosen once, from
 * the first event after an idle gap, and held until the next idle gap.
 *
 * SHIFT is a hard override to tilt — that combination is claimed by nothing
 * else on the canvas (Cesium keys it under its own SHIFT modifier and never
 * consumes it), so it is free real estate for the gesture a MacBook is
 * otherwise missing entirely.
 *
 * @param {{axis?: string, lastEventMs?: number}} state Mutable gesture memory.
 * @param {{deltaX?: number, deltaY?: number, shiftKey?: boolean,
 *   ctrlKey?: boolean}} event
 * @param {number} nowMs
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {{axis: string, magnitude: number, sign: number, effort: number}}
 */
export function resolveScrollGesture(state = {}, event = {}, nowMs = 0, tuning = GESTURE_TUNING) {
  const deltaX = Number(event.deltaX ?? 0);
  const deltaY = Number(event.deltaY ?? 0);
  const idle = !Number.isFinite(state.lastEventMs)
    || nowMs - state.lastEventMs > tuning.gestureIdleMs;
  state.lastEventMs = nowMs;

  if (event.shiftKey && !event.ctrlKey) {
    // Browsers disagree about whether SHIFT+wheel arrives on deltaY or is
    // transposed onto deltaX, so take whichever axis actually moved.
    const delta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
    state.axis = SCROLL_AXIS.TILT;
    return {
      axis: SCROLL_AXIS.TILT,
      magnitude: Math.abs(delta),
      // Fingers away from you (deltaY < 0) stands the view up toward the
      // horizon, and back toward you returns it to top-down — the same
      // direction Google Earth gives SHIFT/CTRL-drag, verified against the
      // live camera in scripts/qa-gestures.mjs.
      sign: -Math.sign(delta) || 0,
      effort: scrollEffort(delta, tuning),
    };
  }

  if (idle || state.axis === SCROLL_AXIS.TILT || !state.axis) {
    state.axis = Math.abs(deltaX) > tuning.horizontalDominance * Math.abs(deltaY)
      ? SCROLL_AXIS.HEADING
      : SCROLL_AXIS.ZOOM;
  }

  if (state.axis === SCROLL_AXIS.HEADING) {
    return {
      axis: SCROLL_AXIS.HEADING,
      magnitude: Math.abs(deltaX),
      // Fingers left (deltaX < 0) swings the view left, matching the way a
      // drag on the globe carries the world with the fingers.
      sign: Math.sign(deltaX) || 0,
      effort: scrollEffort(deltaX, tuning),
    };
  }

  return {
    axis: SCROLL_AXIS.ZOOM,
    magnitude: Math.abs(deltaY),
    sign: -Math.sign(deltaY) || 0,
    effort: scrollEffort(deltaY, tuning),
  };
}

/**
 * Clear a scroll gesture's axis lock — called on pointer-down and on the idle
 * timer so the next scroll re-decides from scratch.
 * @param {{axis?: string, lastEventMs?: number}} state
 * @returns {void}
 */
export function resetScrollGesture(state) {
  if (!state) return;
  state.axis = undefined;
  state.lastEventMs = undefined;
}

/**
 * Whether a tilt step that would land the camera at `nextPitch` may be taken.
 *
 * Inside the band every step is fine. Outside it — which happens when a share
 * link or a layer flight parked the camera at the horizon — a step is still
 * allowed as long as it moves *toward* the band, so the user is never trapped
 * at a pitch the gesture cannot itself produce.
 *
 * @param {number} previousPitch Radians, before the step.
 * @param {number} nextPitch Radians, after the step.
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {boolean}
 */
export function isPitchStepAllowed(previousPitch, nextPitch, tuning = GESTURE_TUNING) {
  const min = tuning.minPitchRadians;
  const max = tuning.maxPitchRadians;
  if (!Number.isFinite(nextPitch)) return false;
  if (nextPitch >= min && nextPitch <= max) return true;
  if (!Number.isFinite(previousPitch)) return false;
  const excessBefore = Math.abs(previousPitch - Math.min(Math.max(previousPitch, min), max));
  const excessAfter = Math.abs(nextPitch - Math.min(Math.max(nextPitch, min), max));
  return excessAfter < excessBefore;
}

/**
 * Convert one Safari GestureEvent scale ratio into a view-distance fraction.
 * Safari reports pinch as a cumulative multiplier rather than a wheel delta,
 * so the per-event ratio maps straight onto "how much closer".
 * @param {number} scaleRatio `event.scale` divided by the previous sample.
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {number} Signed fraction; positive moves the camera closer.
 */
export function pinchScaleFraction(scaleRatio, tuning = GESTURE_TUNING) {
  const ratio = Number(scaleRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const fraction = 1 - 1 / ratio;
  const ceiling = tuning.pinchZoomFractionMax * 4;
  return Math.min(Math.max(fraction, -ceiling), ceiling);
}

/**
 * Map a keydown to a camera intent.
 *
 * Arrow keys and +/- are the only navigation keys claimed here — the app's
 * existing global hotkeys already own 1-7, H, O, V, F, D and C, so a WASD
 * scheme would collide with the detection-mode and data-panel bindings.
 *
 * @param {{key?: string, shiftKey?: boolean, metaKey?: boolean,
 *   ctrlKey?: boolean, altKey?: boolean}} event
 * @returns {{action: string, axis?: string, sign: number}|null}
 */
export function resolveNavigationKey(event = {}) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const shift = Boolean(event.shiftKey);
  switch (event.key) {
    case 'ArrowUp':
      return shift ? { action: 'tilt', sign: 1 } : { action: 'pan', axis: 'forward', sign: 1 };
    case 'ArrowDown':
      return shift ? { action: 'tilt', sign: -1 } : { action: 'pan', axis: 'forward', sign: -1 };
    case 'ArrowLeft':
      return shift ? { action: 'heading', sign: -1 } : { action: 'pan', axis: 'strafe', sign: -1 };
    case 'ArrowRight':
      return shift ? { action: 'heading', sign: 1 } : { action: 'pan', axis: 'strafe', sign: 1 };
    case '=':
    case '+':
      return { action: 'zoom', sign: 1 };
    case '-':
    case '_':
      return { action: 'zoom', sign: -1 };
    default:
      return null;
  }
}

/**
 * Whether a navigation keydown must be ignored because something else owns
 * the keyboard: a form control, an editable surface, or cockpit mode (which
 * drives the camera itself and disables Cesium's inputs outright).
 * @param {{target?: any}} event
 * @param {{cockpitActive?: boolean, inputsEnabled?: boolean}} [context]
 * @returns {boolean}
 */
export function shouldIgnoreNavigationKey(event = {}, context = {}) {
  if (context.cockpitActive) return true;
  if (context.inputsEnabled === false) return true;
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]'));
}

/**
 * Per-frame keyboard step sizes, scaled to how far away the ground is so the
 * arrow keys traverse a city block at 500 m and a continent from orbit.
 * @param {number} heightMeters View distance to the surface.
 * @param {number} dtSeconds Elapsed time since the previous step.
 * @param {typeof GESTURE_TUNING} [tuning]
 * @returns {{pan: number, zoom: number, turn: number, tilt: number}}
 */
export function keyboardStepSizes(heightMeters, dtSeconds, tuning = GESTURE_TUNING) {
  const dt = Math.min(Math.max(Number(dtSeconds) || 0, 0), tuning.keyboardMaxStepSeconds);
  const height = Number.isFinite(heightMeters) && heightMeters > 0 ? heightMeters : 0;
  const floor = tuning.keyboardMinSpeedMetersPerSecond;
  return {
    pan: Math.max(floor, height * tuning.keyboardPanHeightFraction) * dt,
    zoom: Math.max(floor, height * tuning.keyboardZoomHeightFraction) * dt,
    turn: tuning.keyboardTurnRadiansPerSecond * dt,
    tilt: tuning.keyboardTiltRadiansPerSecond * dt,
  };
}
