import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../services/OpenSkyService';

const OPEN_SKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const POLL_INTERVAL_MS = 10_000;

export type FlightState = {
  icao24: string;
  callsign: string;
  originCountry: string;
  longitude: number;
  latitude: number;
  altitude: number;
  trueTrack: number;
  velocity: number;
};

type OpenSkyStatesResponse = {
  states?: Array<[
    string,
    string | null,
    string | null,
    number | null,
    number | null,
    number | null,
    number | null,
    number | null,
    boolean,
    number | null,
    number | null,
    number | null,
    number | null,
    number | null,
    string | null,
    boolean,
    number
  ]>;
};

const mapStatesToFlights = (states: OpenSkyStatesResponse['states']): FlightState[] => {
  if (!states) return [];

  return states
    .map((state) => {
      const icao24 = state[0];
      const callsign = state[1]?.trim() ?? 'UNKNOWN';
      const originCountry = state[2] ?? 'UNKNOWN';
      const longitude = state[5];
      const latitude = state[6];
      const geoAltitude = state[13];
      const baroAltitude = state[7];
      const trueTrack = state[10];
      const velocity = state[9];

      if (
        !icao24 ||
        typeof longitude !== 'number' ||
        typeof latitude !== 'number' ||
        (geoAltitude == null && baroAltitude == null)
      ) {
        return null;
      }

      return {
        icao24,
        callsign,
        originCountry,
        longitude,
        latitude,
        altitude: (geoAltitude ?? baroAltitude ?? 0) + 50,
        trueTrack: typeof trueTrack === 'number' ? trueTrack : 0,
        velocity: typeof velocity === 'number' ? velocity : 0,
      };
    })
    .filter((flight): flight is FlightState => flight !== null);
};

export const useFlightData = () => {
  const [flights, setFlights] = useState<FlightState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    const fetchFlights = async () => {
      try {
        const accessToken = await getAccessToken();
        const response = await fetch(OPEN_SKY_STATES_URL, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(`OpenSky states request failed (${response.status})`);
        }

        const data = (await response.json()) as OpenSkyStatesResponse;

        if (isMountedRef.current) {
          setFlights(mapStatesToFlights(data.states));
          setError(null);
        }
      } catch (err) {
        if (isMountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to fetch flight data.');
        }
      }
    };

    fetchFlights();
    const intervalId = window.setInterval(fetchFlights, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return { flights, error };
};
