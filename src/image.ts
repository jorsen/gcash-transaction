/** Loads an image file, applying its EXIF orientation, and draws it scaled to fit maxSide. */
async function drawScaled(file: Blob, maxSide: number): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality),
  );

/**
 * Small copy kept with the record (~100–250 KB): long side 1600 px, JPEG 72%.
 * A 1080×2400 GCash screenshot becomes 720×1600, still readable.
 */
export async function compressForStorage(file: Blob): Promise<Blob> {
  return toBlob(await drawScaled(file, 1600), 0.72);
}

/** Larger copy used only for text recognition, so camera photos don't slow OCR down. */
export async function prepareForOcr(file: Blob): Promise<HTMLCanvasElement> {
  return drawScaled(file, 2200);
}
