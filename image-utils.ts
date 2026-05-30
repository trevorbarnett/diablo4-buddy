import sharp from 'sharp';

const API_LIMIT_BYTES = 5 * 1024 * 1024; // 5MB in base64 characters

export async function compressImageIfNeeded(imageBase64: string): Promise<string> {
  if (imageBase64.length <= API_LIMIT_BYTES) return imageBase64;

  const inputBytes = Buffer.from(imageBase64, 'base64');
  const mb = inputBytes.byteLength / 1024 / 1024;
  console.log(`[Image] Compressing ${mb.toFixed(1)}MB image to fit API 5MB limit`);

  // Resize to max 1920px wide (preserving aspect ratio) and encode as JPEG at 85% quality.
  // If that's still too large, reduce quality further in steps.
  for (const quality of [85, 70, 55, 40]) {
    const compressed = await sharp(inputBytes)
      .resize({ width: 1920, withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();

    const result = compressed.toString('base64');
    if (result.length <= API_LIMIT_BYTES) {
      console.log(`[Image] Compressed to ${(compressed.byteLength / 1024 / 1024).toFixed(1)}MB (quality ${quality})`);
      return result;
    }
  }

  // Last resort: shrink to 1280px at 40% quality
  const compressed = await sharp(inputBytes)
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 40 })
    .toBuffer();

  console.log(`[Image] Fallback compress to ${(compressed.byteLength / 1024 / 1024).toFixed(1)}MB`);
  return compressed.toString('base64');
}
