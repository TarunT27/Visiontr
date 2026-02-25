const OPEN_SKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const REFRESH_BUFFER_MS = 60 * 1000;

type OpenSkyTokenResponse = {
  access_token: string;
  expires_in?: number;
};

let cachedAccessToken: string | null = null;
let tokenExpiresAt: number | null = null;
let tokenRequestInFlight: Promise<string> | null = null;

const getClientCredentials = (): { clientId: string; clientSecret: string } => {
  const clientId = import.meta.env.VITE_OPENSKY_CLIENT_ID as string | undefined;
  const clientSecret = import.meta.env.VITE_OPENSKY_CLIENT_SECRET as string | undefined;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing OpenSky credentials. Make sure VITE_OPENSKY_CLIENT_ID and VITE_OPENSKY_CLIENT_SECRET are set.',
    );
  }

  return { clientId, clientSecret };
};

const isTokenValid = (): boolean => {
  if (!cachedAccessToken || !tokenExpiresAt) return false;
  return Date.now() < tokenExpiresAt - REFRESH_BUFFER_MS;
};

const requestAccessToken = async (): Promise<string> => {
  const { clientId, clientSecret } = getClientCredentials();

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(OPEN_SKY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorMessage = await response.text();
    throw new Error(`OpenSky token request failed (${response.status}): ${errorMessage}`);
  }

  const data = (await response.json()) as OpenSkyTokenResponse;

  if (!data.access_token) {
    throw new Error('OpenSky token response did not include an access_token.');
  }

  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : TOKEN_LIFETIME_MS);

  return cachedAccessToken;
};

export const getAccessToken = async (): Promise<string> => {
  if (isTokenValid()) {
    return cachedAccessToken as string;
  }

  if (!tokenRequestInFlight) {
    tokenRequestInFlight = requestAccessToken().finally(() => {
      tokenRequestInFlight = null;
    });
  }

  return tokenRequestInFlight;
};
