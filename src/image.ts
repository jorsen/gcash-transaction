type Source = { img: CanvasImageSource; width: number; height: number; close: () => void };

/** Decodes an image file, applying its EXIF orientation. Falls back to <img> where createImageBitmap fails (older Safari). */
async function decode(file: Blob): Promise<Source> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { img: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    return { img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  }
}

/** Draws an image file scaled to fit maxSide. */
async function drawScaled(file: Blob, maxSide: number): Promise<HTMLCanvasElement> {
  const src = await decode(file);
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src.img, 0, 0, canvas.width, canvas.height);
  src.close();
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

/** Part of an image, as fractions (0–1) of its width/height. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Copy used only for text recognition.
 * - crop: keep just the receipt (photos of a phone screen have lots of background that confuses OCR)
 * - enhance: grayscale + contrast stretch, which helps a lot with glare / beige screens / cracks
 */
export async function prepareForOcr(file: Blob, opts: { crop?: CropBox; enhance?: boolean } = {}): Promise<HTMLCanvasElement> {
  const full = await drawScaled(file, 2200);
  let canvas = full;
  if (opts.crop) {
    const { x, y, w, h } = opts.crop;
    const sx = Math.round(x * full.width);
    const sy = Math.round(y * full.height);
    const sw = Math.max(1, Math.round(w * full.width));
    const sh = Math.max(1, Math.round(h * full.height));
    // Enlarge small crops so text is ~1200 px wide (OCR likes bigger letters).
    const scale = Math.min(3, Math.max(1, 1200 / sw));
    canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }
  if (opts.enhance) enhanceForOcr(canvas);
  return canvas;
}

/** Grayscale + contrast stretch (ignoring the 2% darkest/brightest pixels), in place. */
function enhanceForOcr(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = g;
    hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}
