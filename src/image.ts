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

/**
 * True for a phone screenshot (tall, about 9:19.5 or narrower) rather than a camera photo (4:3 / 16:9).
 * A screenshot is already just the receipt, so it needs no framing step.
 */
export async function isScreenshot(file: Blob): Promise<boolean> {
  try {
    const src = await decode(file);
    src.close();
    return src.height / src.width >= 1.85;
  } catch {
    return false;
  }
}

/** Part of an image, as fractions (0–1) of its width/height. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Finds the receipt card (the big white panel) in RGBA pixels: the tallest band of rows that are
 * mostly near-white, then the columns inside it that are mostly near-white. Small gaps (text lines,
 * dividers) are bridged. Returns null if there's no clear card, or it already fills the image.
 */
export function cardBoxFromPixels(d: Uint8ClampedArray | Uint8Array, w: number, h: number): CropBox | null {
  const white = (i: number) => {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    return Math.min(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 70;
  };
  const longestRun = (ok: boolean[], gap: number) => {
    let best: [number, number] | null = null;
    let start = -1;
    let miss = 0;
    for (let i = 0; i <= ok.length; i++) {
      if (i < ok.length && ok[i]) {
        if (start < 0) start = i;
        miss = 0;
      } else if (start >= 0 && (++miss > gap || i === ok.length)) {
        const end = i - miss; // last good index
        if (!best || end - start > best[1] - best[0]) best = [start, end];
        start = -1;
        miss = 0;
      }
    }
    return best;
  };
  const rowOk: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (white((y * w + x) * 4)) n++;
    rowOk.push(n > w * 0.45);
  }
  const rows = longestRun(rowOk, Math.ceil(h * 0.03));
  if (!rows) return null;
  const colOk: boolean[] = [];
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = rows[0]; y <= rows[1]; y++) if (white((y * w + x) * 4)) n++;
    colOk.push(n > (rows[1] - rows[0] + 1) * 0.45);
  }
  const cols = longestRun(colOk, Math.ceil(w * 0.03));
  if (!cols) return null;
  const pad = 0.015;
  const x = Math.max(0, cols[0] / w - pad);
  const y = Math.max(0, rows[0] / h - pad);
  const box = { x, y, w: Math.min(1, (cols[1] + 1) / w + pad) - x, h: Math.min(1, (rows[1] + 1) / h + pad) - y };
  const area = box.w * box.h;
  // Too small to be the receipt, or basically the whole photo (nothing to gain from cropping).
  if (box.w < 0.3 || box.h < 0.2 || area < 0.12 || area > 0.85) return null;
  return box;
}

/** Where the receipt card is in a photo of a phone screen (see cardBoxFromPixels), or null. */
export async function findReceiptCard(file: Blob): Promise<CropBox | null> {
  try {
    const small = await drawScaled(file, 240);
    const px = small.getContext('2d')!.getImageData(0, 0, small.width, small.height);
    return cardBoxFromPixels(px.data, small.width, small.height);
  } catch {
    return null;
  }
}

/**
 * Copy used only for text recognition.
 * - crop: keep just the receipt (photos of a phone screen have lots of background that confuses OCR)
 * - enhance: grayscale + contrast stretch, which helps a lot with glare / beige screens / cracks
 */
export async function prepareForOcr(file: Blob, opts: { crop?: CropBox; enhance?: boolean } = {}): Promise<HTMLCanvasElement> {
  const full = await drawScaled(file, 2200);
  let canvas = full;
  if (!opts.crop && full.width < 1100) {
    // Small / compressed screenshots (e.g. forwarded through Messenger): enlarge so letters are big enough to read.
    const scale = Math.min(2.5, 1100 / full.width);
    canvas = document.createElement('canvas');
    canvas.width = Math.round(full.width * scale);
    canvas.height = Math.round(full.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  }
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
  // Dark mode (light text on a dark background): flip it, the text reader expects dark text on light.
  let sum = 0;
  for (let g = 0; g < 256; g++) sum += g * hist[g];
  const invert = sum / total < 110;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = invert ? 255 - v : v;
  }
  ctx.putImageData(img, 0, 0);
}
