import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// Allowed MIME types for uploads
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);


// Base path for image storage (configurable, defaults to /data/images)
const IMAGE_STORAGE_PATH = config.images.storagePath;
const TEMP_STORAGE_PATH = `${config.images.storagePath}/.tmp`;

export interface UploadResult {
  id: string;
  url: string;
  contentType: string;
  sizeBytes: number;
}

export interface ImageServiceError extends Error {
  code: 'INVALID_TYPE' | 'FILE_TOO_LARGE' | 'STORAGE_ERROR' | 'NOT_FOUND' | 'NOT_CONFIGURED';
}

function createError(message: string, code: ImageServiceError['code']): ImageServiceError {
  const error = new Error(message) as ImageServiceError;
  error.code = code;
  return error;
}

/**
 * Generates a unique image ID using timestamp and random bytes
 */
function generateImageId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `img_${timestamp}_${random}`;
}

/**
 * Builds the public URL for an image
 */
function buildPublicUrl(imageId: string): string {
  const baseUrl = config.images.fileServerUrl;
  if (!baseUrl) {
    throw createError('Image file server URL not configured', 'NOT_CONFIGURED');
  }
  // Remove trailing slash if present
  const normalizedUrl = baseUrl.replace(/\/$/, '');
  return `${normalizedUrl}/images/${imageId}`;
}

/**
 * Ensures the storage directories exist
 */
async function ensureStorageDirectories(): Promise<void> {
  try {
    await fs.mkdir(IMAGE_STORAGE_PATH, { recursive: true });
    await fs.mkdir(TEMP_STORAGE_PATH, { recursive: true });
  } catch (error) {
    logger.error('Failed to create storage directories', { error });
    throw createError('Storage not available', 'STORAGE_ERROR');
  }
}

/**
 * Validates the uploaded file
 */
function validateFile(
  buffer: ArrayBuffer,
  contentType: string
): void {
  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    throw createError(
      `Invalid file type: ${contentType}. Allowed types: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}`,
      'INVALID_TYPE'
    );
  }

  // Validate file size
  const maxSize = config.images.maxSizeBytes;
  if (buffer.byteLength > maxSize) {
    throw createError(
      `File too large: ${buffer.byteLength} bytes. Maximum allowed: ${maxSize} bytes (${Math.round(maxSize / 1024 / 1024)}MB)`,
      'FILE_TOO_LARGE'
    );
  }
}

/**
 * Uploads a new image or replaces an existing one
 * Uses atomic write (temp file + rename) for safety
 */
export async function uploadImage(
  buffer: ArrayBuffer,
  contentType: string,
  existingId?: string
): Promise<UploadResult> {
  // Validate file first
  validateFile(buffer, contentType);

  // Ensure storage directories exist
  await ensureStorageDirectories();

  // Use existing ID for replacement or generate new one
  const imageId = existingId || generateImageId();

  // File paths - we store without extension for simpler URL handling
  // But you could include extension: `${imageId}.${ext}`
  const finalPath = path.join(IMAGE_STORAGE_PATH, imageId);
  const tempPath = path.join(TEMP_STORAGE_PATH, `${imageId}_${crypto.randomBytes(4).toString('hex')}`);

  try {
    // Write to temp file first
    await fs.writeFile(tempPath, Buffer.from(buffer));

    // Atomic rename to final location
    await fs.rename(tempPath, finalPath);

    logger.info('Image uploaded successfully', {
      imageId,
      contentType,
      sizeBytes: buffer.byteLength,
      isReplacement: !!existingId,
    });

    return {
      id: imageId,
      url: buildPublicUrl(imageId),
      contentType,
      sizeBytes: buffer.byteLength,
    };
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    logger.error('Failed to upload image', { error, imageId });
    throw createError('Failed to save image', 'STORAGE_ERROR');
  }
}

/**
 * Deletes an image from storage
 */
export async function deleteImage(imageId: string): Promise<boolean> {
  const filePath = path.join(IMAGE_STORAGE_PATH, imageId);

  try {
    await fs.unlink(filePath);
    logger.info('Image deleted successfully', { imageId });
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.warn('Image not found for deletion', { imageId });
      return false;
    }
    logger.error('Failed to delete image', { error, imageId });
    throw createError('Failed to delete image', 'STORAGE_ERROR');
  }
}

/**
 * Checks if an image exists
 */
export async function imageExists(imageId: string): Promise<boolean> {
  const filePath = path.join(IMAGE_STORAGE_PATH, imageId);

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the public URL for an image ID
 */
export function getImageUrl(imageId: string | null): string | null {
  if (!imageId) return null;

  try {
    return buildPublicUrl(imageId);
  } catch {
    return null;
  }
}

/**
 * Validates that the image server is configured
 */
export function isImageServerConfigured(): boolean {
  return !!config.images.fileServerUrl;
}

export const imageService = {
  upload: uploadImage,
  delete: deleteImage,
  exists: imageExists,
  getUrl: getImageUrl,
  isConfigured: isImageServerConfigured,
  maxSizeBytes: config.images.maxSizeBytes,
  allowedTypes: Array.from(ALLOWED_MIME_TYPES),
};
