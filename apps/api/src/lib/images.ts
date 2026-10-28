import sharp from 'sharp';
import { MAX_ATTACHMENT_SIZE_BYTES } from '@familyhub/shared';
import { AppError } from './errors.js';

export const MAX_IMAGE_PIXELS = 24_000_000;
const formats = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' } as const;

/** Decode and re-encode every image; no input metadata or original bytes reach storage. */
export async function processAttachmentImage(buffer: Buffer, mimeType: string) {
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AppError(413, 'IMAGE_SIZE', 'Images must be between 1 byte and 10 MB');
  }
  const expected = formats[mimeType as keyof typeof formats];
  if (!expected) throw new AppError(415, 'IMAGE_TYPE', 'Choose a JPEG, PNG or WebP image');
  try {
    const options = { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' as const };
    const meta = await sharp(buffer, options).metadata();
    if (
      meta.format !== expected ||
      !meta.width ||
      !meta.height ||
      (meta.pages ?? 1) !== 1 ||
      meta.width * meta.height > MAX_IMAGE_PIXELS
    ) {
      throw new Error('Unsupported image');
    }
    const { data: full, info } = await sharp(buffer, options)
      .rotate()
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    if (full.length > MAX_ATTACHMENT_SIZE_BYTES)
      throw new AppError(413, 'IMAGE_SIZE', 'Processed image exceeds 10 MB');
    const thumb = await sharp(full, options)
      .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    return { full, thumb, width: info.width, height: info.height, mimeType: 'image/webp' as const };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      422,
      'INVALID_IMAGE',
      'Invalid image, MIME mismatch, animation or image larger than 24 megapixels',
    );
  }
}
