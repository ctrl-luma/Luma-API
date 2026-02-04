import NodeGeocoder from 'node-geocoder';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const geocoder = NodeGeocoder({
  provider: 'google',
  apiKey: config.googleMaps.apiKey,
});

export interface GeocodingResult {
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
}

// Simple in-memory cache to avoid repeated lookups for the same address
const cache = new Map<string, GeocodingResult | null>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const cacheTimestamps = new Map<string, number>();

function getCached(key: string): GeocodingResult | null | undefined {
  const ts = cacheTimestamps.get(key);
  if (ts && Date.now() - ts < CACHE_TTL) {
    return cache.get(key);
  }
  // Expired — clean up
  cache.delete(key);
  cacheTimestamps.delete(key);
  return undefined; // cache miss
}

function setCache(key: string, value: GeocodingResult | null) {
  cache.set(key, value);
  cacheTimestamps.set(key, Date.now());
  // Keep cache bounded
  if (cache.size > 1000) {
    const oldest = cacheTimestamps.entries().next().value;
    if (oldest) {
      cache.delete(oldest[0]);
      cacheTimestamps.delete(oldest[0]);
    }
  }
}

export async function geocodeAddress(address: string, retries = 2): Promise<GeocodingResult | null> {
  if (!config.googleMaps.apiKey) {
    logger.warn('GOOGLE_MAPS_API_KEY not set, skipping geocoding', { address });
    return null;
  }

  const cacheKey = address.trim().toLowerCase();
  const cached = getCached(cacheKey);
  if (cached !== undefined) {
    logger.info('Geocoding cache hit', { address });
    return cached;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const results = await geocoder.geocode(address);
      if (!results.length || !results[0].latitude || !results[0].longitude) {
        logger.warn('Geocoding returned no results', { address });
        setCache(cacheKey, null);
        return null;
      }

      const result: GeocodingResult = {
        latitude: results[0].latitude,
        longitude: results[0].longitude,
        formattedAddress: results[0].formattedAddress || null,
      };
      setCache(cacheKey, result);
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errDetails: Record<string, any> = { address, attempt: attempt + 1, error: errMsg };
      if (error && typeof error === 'object' && 'statusCode' in error) errDetails.statusCode = (error as any).statusCode;
      if (error && typeof error === 'object' && 'code' in error) errDetails.code = (error as any).code;

      if (attempt < retries) {
        logger.warn('Geocoding failed, retrying', errDetails);
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      logger.error('Geocoding failed after retries', errDetails);
      return null;
    }
  }
  return null;
}
