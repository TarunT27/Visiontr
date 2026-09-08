import * as Cesium from 'cesium';
import {
  GESTURE_TUNING,
  POINTER_DEVICE,
  SCROLL_AXIS,
  classifyWheelDevice,
  isPitchStepAllowed,
  keyboardStepSizes,
  pinchScaleFraction,
  resetScrollGesture,
  resolveNavigationKey,
  resolveScrollGesture,
  shouldIgnoreNavigationKey,
  solveWheelZoomFactor,
  zoomFractionCeiling,
} from './gestureNavigationPolicy.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';

/**
 * MacBook trackpad + keyboard navigation for the globe.
 *
 * This is the Cesium-facing half of the gesture layer; every decision it
 * makes is delegated to the dependency-free policy in
 * gestureNavigationPolicy.js, which carries the reasoning and the tests.
 *
 * The gesture map it installs:
 *
 * | Gesture                        | Result                              |
 * |--------------------------------|-------------------------------------|
 * | one-finger drag                | pan / spin the globe (Cesium stock) |
 * | two-finger scroll ↕            | zoom, paced against acceleration    |
 * | two-finger scroll ↔            | swing heading (and eats swipe-back) |
 * | ⇧ + two-finger scroll          | tilt                                |
 * | pinch                          | zoom (Chromium, Firefox and Safari) |
 * | two-finger rotate              | swing heading (Safari)              |
 * | ⌥ + drag                       | tilt                                |
 * | arrows / ⇧+arrows / + / −      | pan / turn + tilt / dolly           |
 *
 * Three constraints shaped the implementation:
 *
 * - **It never stops event propagation.** StyleManager attaches its own
 *   `wheel` and `pointerdown` listeners to the same canvas to detect "the
 *   user has taken the camera" (see the initial-share and radio-tuner
 *   handlers in ui.js). Swallowing events here would silently break both, so
 *   this module only ever *adds* behaviour alongside Cesium's.
 * - **It respects `enableInputs`.** Cockpit mode, the CCTV pose gizmo and
 *   GeoJSON fly-throughs all take the camera by setting
 *   `screenSpaceCameraController.enableInputs = false`. Every handler here
 *   returns early on that flag rather than fighting them for the camera.
 * - **It plays by the render governor's rules.** The scene sits in
 *   `requestRenderMode` when idle. Cesium re-renders on camera changes by
 *   itself, but discrete mutations still request a frame explicitly, and the
 *   keyboard loop takes a continuous-render hold for exactly as long as a key
 *   is held down.
 */

const KEYBOARD_RENDER_HOLD = 'gesture-nav-keys';

const scratchCenterPixel = new Cesium.Cartesian2();
const scratchCenterPosition = new Cesium.Cartesian3();
const scratchSurfaceNormal = new Cesium.Cartesian3();
const scratchForward = new Cesium.Cartesian3();
const scratchRight = new Cesium.Cartesian3();
const scratchTransform = new Cesium.Matrix4();

/**
 * Resolve the world point the camera should orbit for a tilt or heading
 * gesture: whatever is under the middle of the screen.
 *
 * `scene.pickPosition` reads the depth buffer, so it lands on the Google 3D
 * Tiles surface — a rooftop, a hillside — which is what makes the gesture
 * feel anchored. It fails when the centre pixel is sky or the depth texture
 * is unavailable, so the ellipsoid ray is the fallback, and a camera aimed at
 * empty space simply has nothing to orbit.
 *
 * @param {Cesium.Scene} scene
 * @returns {Cesium.Cartesian3|undefined} World position, or undefined.
 */
function pickOrbitCenter(scene) {
  const canvas = scene?.canvas;
  if (!canvas) return undefined;
  const center = Cesium.Cartesian2.fromElements(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2,
    scratchCenterPixel,
  );
  if (scene.pickPositionSupported) {
    const picked = scene.pickPosition(center, scratchCenterPosition);
    if (Cesium.defined(picked) && Number.isFinite(picked.x)) return picked;
  }
  const ellipsoid = scene.ellipsoid ?? Cesium.Ellipsoid.WGS84;
  const onGlobe = scene.camera.pickEllipsoid(center, ellipsoid, scratchCenterPosition);
  return Cesium.defined(onGlobe) ? onGlobe : undefined;
}

/**
 * Orbit the camera around the point under the screen centre.
 *
 * Tilt and heading are the same operation in two axes: move the camera on a
 * sphere about a fixed ground point, which is what keeps the thing you are
 * looking at in frame. Cesium expresses that as a temporary camera transform
 * plus `rotateUp` / `rotateRight`, and the transform is always restored to
 * IDENTITY afterwards so nothing downstream (share links, the HUD readouts,
 * OrbitController) inherits a camera reference frame it did not set.
 *
 * Pitch is validated *after* the fact rather than predicted: the exact pitch
 * a rotation produces depends on where the orbit centre sits relative to the
 * camera, so the honest test is to take the step, read the result, and undo
 * it when it left the allowed band.
 *
 * @param {Cesium.Viewer} viewer
 * @param {{heading?: number, pitch?: number}} deltas Radians.
 * @returns {boolean} Whether the camera actually moved.
 */
function orbitAroundScreenCenter(viewer, { heading = 0, pitch = 0 } = {}) {
  const scene = viewer?.scene;
  const camera = scene?.camera;
  if (!camera) return false;
  if (!heading && !pitch) return false;

  const center = pickOrbitCenter(scene);
  if (!center) return false;

  const previousPitch = camera.pitch;
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(
    center,
    scene.ellipsoid ?? Cesium.Ellipsoid.WGS84,
    scratchTransform,
  );

  camera.lookAtTransform(transform);
  if (heading) camera.rotateRight(heading);
  if (pitch) camera.rotateUp(pitch);
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  if (pitch && !isPitchStepAllowed(previousPitch, camera.pitch)) {
    // Roll the whole step back — including the heading component, so a
    // diagonal gesture at the pitch limit does not half-apply.
    camera.lookAtTransform(transform);
    if (pitch) camera.rotateUp(-pitch);
    if (heading) camera.rotateRight(-heading);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    return false;
  }

  governorRequestRender('gesture-orbit');
  return true;
}

/**
 * Distance from the camera to whatever it is looking at, for scaling steps.
 * Falls back to height above the ellipsoid when nothing is under the centre
 * pixel (looking at the horizon, or out into space).
 * @param {Cesium.Viewer} viewer
 * @returns {number} Metres; 0 when unknown.
 */
function viewDistanceMeters(viewer) {
  const scene = viewer?.scene;
  const camera = scene?.camera;
  if (!camera) return 0;
  const center = pickOrbitCenter(scene);
  if (center) {
    const distance = Cesium.Cartesian3.distance(camera.positionWC, center);
    if (Number.isFinite(distance) && distance > 0) return distance;
  }
  const height = camera.positionCartographic?.height;
  return Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * Dolly the camera by a fraction of its current view distance, toward or away
 * from what it is looking at. Used by pinch on Safari and by the +/- keys —
 * the wheel path never gets here, because there Cesium does the zoom itself
 * and this module only sets the rate.
 * @param {Cesium.Viewer} viewer
 * @param {number} fraction Positive moves closer.
 * @returns {boolean} Whether the camera moved.
 */
function dollyByFraction(viewer, fraction) {
  if (!Number.isFinite(fraction) || fraction === 0) return false;
  const camera = viewer?.scene?.camera;
  if (!camera) return false;
  const distance = viewDistanceMeters(viewer);
  if (!(distance > 0)) return false;
  const controller = viewer.scene.screenSpaceCameraController;
  const minimum = Math.max(controller?.minimumZoomDistance ?? 1, 1);
  const step = distance * fraction;
  // Never let a single step cross the near limit — Cesium's own zoom guards
  // this for the wheel, and the pinch/key paths must not be the exception.
  const clamped = step > 0 ? Math.min(step, Math.max(distance - minimum, 0)) : step;
  if (clamped === 0) return false;
  if (clamped > 0) camera.zoomIn(clamped);
  else camera.zoomOut(-clamped);
  governorRequestRender('gesture-dolly');
  return true;
}

/**
 * Install the trackpad/keyboard navigation layer.
 *
 * @param {Cesium.Viewer} viewer
 * @param {object} [options]
 * @param {Document} [options.keyboardTarget] Keydown/keyup host.
 * @param {typeof GESTURE_TUNING} [options.tuning]
 * @returns {{dispose: () => void, getDiagnostics: () => object}}
 */
export function installGestureNavigation(viewer, {
  keyboardTarget = document,
  tuning = GESTURE_TUNING,
} = {}) {
  const scene = viewer?.scene;
  const canvas = scene?.canvas;
  const controller = scene?.screenSpaceCameraController;
  if (!canvas || !controller) {
    throw new TypeError('installGestureNavigation requires a Cesium viewer with a canvas');
  }

  const baseZoomFactor = controller.zoomFactor;
  const baseInertiaZoom = controller.inertiaZoom;

  // ── Static binding fixes ──────────────────────────────────────────────
  // Pinch: Cesium's aggregator already records WHEEL under the CTRL modifier
  // (that is how Chromium and Firefox deliver a trackpad pinch), it simply
  // never consumed it. Listing it as a zoom event is the entire fix.
  controller.zoomEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH,
    { eventType: Cesium.CameraEventType.WHEEL, modifier: Cesium.KeyboardEventModifier.CTRL },
  ];
  // Tilt: ⌥+drag is the one modifier+drag combination macOS leaves alone.
  // CTRL+drag is kept for parity with Cesium docs and non-Mac users, but on a
  // Mac it is unreliable — the OS promotes ctrl+click to a secondary click.
  controller.tiltEventTypes = [
    Cesium.CameraEventType.MIDDLE_DRAG,
    Cesium.CameraEventType.PINCH,
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.ALT },
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL },
    { eventType: Cesium.CameraEventType.RIGHT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL },
  ];

  const wheelDeviceState = {};
  const scrollGestureState = {};
  const gestureState = { active: false, scale: 1, rotation: 0 };
  let lastDevice = POINTER_DEVICE.MOUSE;
  let axisLockTimer = 0;
  let zoomSuppressed = false;
  let disposed = false;

  /**
   * Hand the zoom rate back to whatever the controller was built with.
   * `zoomFactor` is shared by the wheel, right-drag and touch-pinch paths, so
   * a rate solved for one wheel event must not still be in place when a drag
   * starts.
   */
  const restoreZoomRate = () => {
    controller.zoomFactor = baseZoomFactor;
    controller.inertiaZoom = baseInertiaZoom;
  };

  /** Re-enable Cesium's wheel zoom after a heading/tilt gesture claimed it. */
  const restoreZoomEnabled = () => {
    if (!zoomSuppressed) return;
    zoomSuppressed = false;
    controller.enableZoom = true;
  };

  const endScrollGesture = () => {
    resetScrollGesture(scrollGestureState);
    restoreZoomEnabled();
    restoreZoomRate();
  };

  const scheduleAxisLockRelease = () => {
    globalThis.clearTimeout(axisLockTimer);
    axisLockTimer = globalThis.setTimeout(endScrollGesture, tuning.gestureIdleMs * 3);
  };

  const onWheel = (event) => {
    if (disposed || !controller.enableInputs) return;

    const now = event.timeStamp || performance.now();
    const isPinch = Boolean(event.ctrlKey);
    // Safari drives pinch through GestureEvent; if one is in flight, ignore a
    // ctrl+wheel that would double-apply the same finger motion.
    if (isPinch && gestureState.active) return;

    const device = classifyWheelDevice(event, wheelDeviceState, now, tuning);
    lastDevice = device;

    const gesture = isPinch
      ? { axis: SCROLL_AXIS.ZOOM, magnitude: Math.abs(event.deltaY), sign: -Math.sign(event.deltaY) }
      : resolveScrollGesture(scrollGestureState, event, now, tuning);
    scheduleAxisLockRelease();

    if (gesture.axis === SCROLL_AXIS.ZOOM) {
      restoreZoomEnabled();
      // Solve the rate for this one event so the zoom step is the same
      // fraction of the view whether the user crept or flicked.
      controller.zoomFactor = solveWheelZoomFactor({
        magnitude: gesture.magnitude,
        canvasHeight: canvas.clientHeight,
        maxFraction: zoomFractionCeiling(device, isPinch, tuning),
        effort: gesture.effort,
        tuning,
      });
      // macOS already sends a momentum tail; a second inertia on top of it
      // overshoots every time.
      controller.inertiaZoom = device === POINTER_DEVICE.TRACKPAD
        ? tuning.trackpadInertiaZoom
        : tuning.mouseInertiaZoom;
      return;
    }

    // Heading and tilt are ours. Cesium would otherwise zoom off the residual
    // vertical component of the same event, so its zoom is parked for the
    // duration of the gesture rather than fought frame by frame.
    if (!zoomSuppressed) {
      zoomSuppressed = true;
      controller.enableZoom = false;
    }
    // Nothing else consumes horizontal scroll, so claiming it here also stops
    // Brave/Chrome from turning a stray sideways swipe into a history-back.
    if (event.cancelable) event.preventDefault();

    if (gesture.axis === SCROLL_AXIS.HEADING) {
      orbitAroundScreenCenter(viewer, {
        heading: gesture.sign * gesture.effort * tuning.headingRadiansPerNotch,
      });
      return;
    }
    orbitAroundScreenCenter(viewer, {
      pitch: gesture.sign * gesture.effort * tuning.tiltRadiansPerNotch,
    });
  };

  // A drag can start a right-drag or touch-pinch zoom, both of which read the
  // same `zoomFactor` the wheel path was just tuning. Reset on the way in.
  const onPointerDown = () => {
    globalThis.clearTimeout(axisLockTimer);
    endScrollGesture();
  };

  // ── Safari trackpad gestures ──────────────────────────────────────────
  // Safari does not emit ctrl+wheel for pinch; it emits the non-standard
  // GestureEvent trio, which is also the only way any browser reports a
  // two-finger *rotate*. Both are cumulative within a gesture, so each sample
  // is differenced against the previous one.
  const onGestureStart = (event) => {
    if (disposed || !controller.enableInputs) return;
    if (event.cancelable) event.preventDefault();
    gestureState.active = true;
    gestureState.scale = event.scale || 1;
    gestureState.rotation = event.rotation || 0;
  };

  const onGestureChange = (event) => {
    if (disposed || !gestureState.active || !controller.enableInputs) return;
    if (event.cancelable) event.preventDefault();

    const scale = event.scale || gestureState.scale;
    const rotation = event.rotation ?? gestureState.rotation;
    const scaleRatio = gestureState.scale > 0 ? scale / gestureState.scale : 1;
    const rotationDelta = rotation - gestureState.rotation;
    gestureState.scale = scale;
    gestureState.rotation = rotation;

    dollyByFraction(viewer, pinchScaleFraction(scaleRatio, tuning));
    if (rotationDelta) {
      // Safari reports rotation in degrees, clockwise positive.
      orbitAroundScreenCenter(viewer, { heading: (rotationDelta * Math.PI) / 180 });
    }
  };

  const onGestureEnd = (event) => {
    if (event?.cancelable) event.preventDefault();
    gestureState.active = false;
    gestureState.scale = 1;
    gestureState.rotation = 0;
  };

  // ── Keyboard navigation ───────────────────────────────────────────────
  const heldKeys = new Map();
  let keyLoopHandle = 0;
  let lastKeyFrameMs = 0;

  const stopKeyLoop = () => {
    if (!keyLoopHandle) return;
    globalThis.cancelAnimationFrame(keyLoopHandle);
    keyLoopHandle = 0;
    lastKeyFrameMs = 0;
    releaseContinuousRender(KEYBOARD_RENDER_HOLD);
  };

  const stepKeyboard = (nowMs) => {
    keyLoopHandle = 0;
    if (disposed || heldKeys.size === 0 || !controller.enableInputs) {
      stopKeyLoop();
      return;
    }
    const dt = lastKeyFrameMs ? (nowMs - lastKeyFrameMs) / 1000 : 1 / 60;
    lastKeyFrameMs = nowMs;

    const camera = scene.camera;
    const steps = keyboardStepSizes(viewDistanceMeters(viewer), dt, tuning);

    let forward = 0;
    let strafe = 0;
    let heading = 0;
    let pitch = 0;
    let zoom = 0;
    for (const intent of heldKeys.values()) {
      if (intent.action === 'pan') {
        if (intent.axis === 'forward') forward += intent.sign;
        else strafe += intent.sign;
      } else if (intent.action === 'heading') heading += intent.sign;
      else if (intent.action === 'tilt') pitch += intent.sign;
      else if (intent.action === 'zoom') zoom += intent.sign;
    }

    if (forward || strafe) {
      // Pan across the ground, not along the view vector: with the camera
      // pitched down, moving along `camera.direction` would fly it into the
      // pavement instead of translating the map.
      const ellipsoid = scene.ellipsoid ?? Cesium.Ellipsoid.WGS84;
      const up = ellipsoid.geodeticSurfaceNormal(camera.positionWC, scratchSurfaceNormal);
      if (up) {
        const alongUp = Cesium.Cartesian3.dot(camera.direction, up);
        const flat = Cesium.Cartesian3.subtract(
          camera.direction,
          Cesium.Cartesian3.multiplyByScalar(up, alongUp, scratchForward),
          scratchForward,
        );
        if (Cesium.Cartesian3.magnitude(flat) > Cesium.Math.EPSILON6) {
          Cesium.Cartesian3.normalize(flat, flat);
          const right = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.cross(flat, up, scratchRight),
            scratchRight,
          );
          if (forward) camera.move(flat, forward * steps.pan);
          if (strafe) camera.move(right, strafe * steps.pan);
          governorRequestRender('gesture-key-pan');
        }
      }
    }
    if (heading || pitch) {
      orbitAroundScreenCenter(viewer, {
        heading: heading * steps.turn,
        pitch: pitch * steps.tilt,
      });
    }
    if (zoom) {
      const distance = viewDistanceMeters(viewer);
      if (distance > 0) dollyByFraction(viewer, (zoom * steps.zoom) / distance);
    }

    keyLoopHandle = globalThis.requestAnimationFrame(stepKeyboard);
  };

  const startKeyLoop = () => {
    if (keyLoopHandle) return;
    // The loop mutates the camera every frame; under the idle governor that
    // is exactly what a continuous-render hold is for.
    holdContinuousRender(KEYBOARD_RENDER_HOLD);
    lastKeyFrameMs = 0;
    keyLoopHandle = globalThis.requestAnimationFrame(stepKeyboard);
  };

  const isCockpitActive = () => Boolean(
    globalThis.document?.body?.classList?.contains('cockpit-mode'),
  );

  const onKeyDown = (event) => {
    if (disposed || event.repeat || event.isComposing) return;
    if (shouldIgnoreNavigationKey(event, {
      cockpitActive: isCockpitActive(),
      inputsEnabled: controller.enableInputs,
    })) return;
    const intent = resolveNavigationKey(event);
    if (!intent) return;
    event.preventDefault();
    heldKeys.set(event.key, intent);
    startKeyLoop();
  };

  const onKeyUp = (event) => {
    if (heldKeys.size === 0) return;
    heldKeys.delete(event.key);
    // SHIFT re-labels the arrows mid-hold (pan becomes turn/tilt), so the
    // keyup can arrive under a key name that was never registered. Clearing
    // on the modifier itself keeps the held set from leaking a stuck key.
    if (event.key === 'Shift') heldKeys.clear();
    if (heldKeys.size === 0) stopKeyLoop();
  };

  // Focus loss never delivers keyup, which would otherwise leave the camera
  // gliding forever after a ⌘-Tab.
  const onBlur = () => {
    heldKeys.clear();
    stopKeyLoop();
    endScrollGesture();
    onGestureEnd();
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('gesturestart', onGestureStart, { passive: false });
  canvas.addEventListener('gesturechange', onGestureChange, { passive: false });
  canvas.addEventListener('gestureend', onGestureEnd, { passive: false });
  keyboardTarget.addEventListener('keydown', onKeyDown);
  keyboardTarget.addEventListener('keyup', onKeyUp);
  globalThis.addEventListener('blur', onBlur);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.clearTimeout(axisLockTimer);
      stopKeyLoop();
      heldKeys.clear();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('gesturestart', onGestureStart);
      canvas.removeEventListener('gesturechange', onGestureChange);
      canvas.removeEventListener('gestureend', onGestureEnd);
      keyboardTarget.removeEventListener('keydown', onKeyDown);
      keyboardTarget.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', onBlur);
      restoreZoomEnabled();
      restoreZoomRate();
    },
    /** @returns {object} Live state, for QA scripts and the console. */
    getDiagnostics() {
      return {
        device: lastDevice,
        scrollAxis: scrollGestureState.axis ?? null,
        zoomFactor: controller.zoomFactor,
        inertiaZoom: controller.inertiaZoom,
        zoomSuppressed,
        safariGestureActive: gestureState.active,
        heldKeys: [...heldKeys.keys()],
        keyboardLoopRunning: Boolean(keyLoopHandle),
      };
    },
  };
}
