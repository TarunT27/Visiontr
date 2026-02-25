import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cartesian3,
  Color,
  Entity,
  ExtrapolationType,
  Ion,
  JulianDate,
  ModelGraphics,
  PathGraphics,
  PolylineGlowMaterialProperty,
  PostProcessStage,
  SampledPositionProperty,
  ScreenSpaceEventType,
  VelocityOrientationProperty,
  Viewer,
  defined,
} from 'cesium';
import { FlightState, useFlightData } from '../hooks/useFlightData';

Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_ACCESS_TOKEN as string;

const HOME_LAT = 0; // Replace with your latitude.
const HOME_LON = 0; // Replace with your longitude.

const METER_TO_FEET = 3.28084;
const MPS_TO_KNOTS = 1.94384;

const NIGHT_VISION_FRAGMENT_SHADER = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  float scanline = sin(v_textureCoordinates.y * 800.0) * 0.04;
  vec3 nvColor = vec3(0.0, luminance * 1.5, 0.0) - scanline;
  out_FragColor = vec4(nvColor, 1.0);
}
`;

const createPathMaterial = (isSelected: boolean) =>
  new PolylineGlowMaterialProperty({
    color: isSelected ? Color.YELLOW.withAlpha(0.98) : Color.LIME.withAlpha(0.95),
    glowPower: isSelected ? 0.35 : 0.25,
  });

const Globe = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const nightVisionStageRef = useRef<PostProcessStage | null>(null);
  const entitiesByIcaoRef = useRef<Map<string, Entity>>(new Map());
  const sampledPositionsByIcaoRef = useRef<Map<string, SampledPositionProperty>>(new Map());
  const { flights } = useFlightData();
  const [selectedIcao, setSelectedIcao] = useState<string | null>(null);
  const [isNightVision, setIsNightVision] = useState(true);

  const selectedFlight = useMemo(
    () => flights.find((flight) => flight.icao24 === selectedIcao) ?? null,
    [flights, selectedIcao],
  );

  const releaseCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    viewer.trackedEntity = undefined;
    setSelectedIcao(null);
    viewer.scene.requestRender();
  };

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    const viewer = new Viewer(containerRef.current, {
      requestRenderMode: true,
      scene3DOnly: true,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
    });

    const nightVision = new PostProcessStage({
      fragmentShader: NIGHT_VISION_FRAGMENT_SHADER,
      enabled: isNightVision,
    });
    viewer.scene.postProcessStages.add(nightVision);
    nightVisionStageRef.current = nightVision;

    viewer.screenSpaceEventHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      if (!defined(picked) || !('id' in picked) || !(picked.id instanceof Entity)) {
        return;
      }

      const clickedEntity = picked.id;
      const clickedIcao = typeof clickedEntity.id === 'string' ? clickedEntity.id : null;

      if (!clickedIcao) return;

      setSelectedIcao(clickedIcao);
      viewer.trackedEntity = clickedEntity;
      viewer.flyTo(clickedEntity, { duration: 0.75 });
      viewer.scene.requestRender();
    }, ScreenSpaceEventType.LEFT_CLICK);

    viewerRef.current = viewer;

    const homePosition = Cartesian3.fromDegrees(HOME_LON, HOME_LAT, 15_000);
    viewer.camera.flyTo({
      destination: homePosition,
    });

    return () => {
      viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);

      if (nightVisionStageRef.current) {
        viewer.scene.postProcessStages.remove(nightVisionStageRef.current);
        nightVisionStageRef.current.destroy();
      }

      nightVisionStageRef.current = null;
      viewer.destroy();
      viewerRef.current = null;
      entitiesByIcaoRef.current.clear();
      sampledPositionsByIcaoRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const nightVision = nightVisionStageRef.current;
    if (!viewer || !nightVision) return;

    nightVision.enabled = isNightVision;
    viewer.scene.requestRender();
  }, [isNightVision]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const entitiesByIcao = entitiesByIcaoRef.current;
    const sampledPositionsByIcao = sampledPositionsByIcaoRef.current;
    const activeIcao = new Set<string>();
    const now = JulianDate.now();

    flights.forEach((flight) => {
      activeIcao.add(flight.icao24);

      const cartesianPosition = Cartesian3.fromDegrees(
        flight.longitude,
        flight.latitude,
        Math.max(flight.altitude, 0),
      );

      const sampledPosition = sampledPositionsByIcao.get(flight.icao24);
      if (sampledPosition) {
        sampledPosition.addSample(now, cartesianPosition);

        const existingEntity = entitiesByIcao.get(flight.icao24);
        if (existingEntity?.path) {
          existingEntity.path.material = createPathMaterial(selectedIcao === flight.icao24);
        }
        return;
      }

      const newSampledPosition = new SampledPositionProperty();
      newSampledPosition.forwardExtrapolationType = ExtrapolationType.HOLD;
      newSampledPosition.forwardExtrapolationDuration = 15;
      newSampledPosition.backwardExtrapolationType = ExtrapolationType.HOLD;
      newSampledPosition.addSample(now, cartesianPosition);

      const model = new ModelGraphics({
        uri: '/models/airliner.glb',
        minimumPixelSize: 64,
        maximumScale: 20_000,
        color: Color.WHITE,
      });

      const path = new PathGraphics({
        show: true,
        width: 2,
        resolution: 1,
        trailTime: 60,
        material: createPathMaterial(selectedIcao === flight.icao24),
      });

      const newEntity = viewer.entities.add({
        id: flight.icao24,
        position: newSampledPosition,
        orientation: new VelocityOrientationProperty(newSampledPosition),
        model,
        path,
      });

      entitiesByIcao.set(flight.icao24, newEntity);
      sampledPositionsByIcao.set(flight.icao24, newSampledPosition);
    });

    entitiesByIcao.forEach((entity, icao24) => {
      if (!activeIcao.has(icao24)) {
        viewer.entities.remove(entity);
        entitiesByIcao.delete(icao24);
        sampledPositionsByIcao.delete(icao24);

        if (selectedIcao === icao24) {
          setSelectedIcao(null);
          viewer.trackedEntity = undefined;
        }
      }
    });

    viewer.scene.requestRender();
  }, [flights, selectedIcao]);

  const formatAltitude = (flight: FlightState) => `${Math.round(flight.altitude * METER_TO_FEET).toLocaleString()} ft`;
  const formatVelocity = (flight: FlightState) => `${Math.round(flight.velocity * MPS_TO_KNOTS).toLocaleString()} kt`;

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />

      <aside
        className={`fixed left-0 top-0 z-20 h-full w-72 border-r border-green-500/30 bg-black/75 p-4 font-mono text-green-300 backdrop-blur-sm transition-transform duration-300 ${
          selectedFlight ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <h2 className="mb-4 text-sm tracking-wider text-green-400">INTELLIGENCE OVERLAY</h2>
        {selectedFlight ? (
          <dl className="space-y-3 text-xs leading-relaxed">
            <div>
              <dt className="text-green-500/80">Callsign</dt>
              <dd className="text-green-200">{selectedFlight.callsign || 'UNKNOWN'}</dd>
            </div>
            <div>
              <dt className="text-green-500/80">Altitude</dt>
              <dd className="text-green-200">{formatAltitude(selectedFlight)}</dd>
            </div>
            <div>
              <dt className="text-green-500/80">Velocity</dt>
              <dd className="text-green-200">{formatVelocity(selectedFlight)}</dd>
            </div>
            <div>
              <dt className="text-green-500/80">Origin Country</dt>
              <dd className="text-green-200">{selectedFlight.originCountry}</dd>
            </div>
          </dl>
        ) : null}
      </aside>

      <div className="fixed right-4 top-4 z-10 flex flex-col items-end gap-2">
        <div className="pointer-events-none rounded border border-green-500/40 bg-black/65 px-3 py-2 font-mono text-sm tracking-wider text-green-400 shadow-[0_0_12px_rgba(74,222,128,0.35)] animate-pulse">
          LIVE SATELLITE FEED
        </div>
        <button
          type="button"
          onClick={() => setIsNightVision((current) => !current)}
          className="rounded border border-green-500/50 bg-black/80 px-3 py-1 font-mono text-xs text-green-300 transition hover:border-green-400 hover:text-green-200"
        >
          {isNightVision ? 'Disable Night Vision' : 'Enable Night Vision'}
        </button>
        <button
          type="button"
          onClick={releaseCamera}
          className="rounded border border-green-500/50 bg-black/80 px-3 py-1 font-mono text-xs text-green-300 transition hover:border-green-400 hover:text-green-200"
        >
          Release Camera
        </button>
      </div>
    </div>
  );
};

export default Globe;
