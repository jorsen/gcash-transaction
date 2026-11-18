import { createWorker, PSM, type Worker } from 'tesseract.js';
import { prepareForOcr, type CropBox } from './image';
import { findRefLine, refTailFromDigits, type OcrLine } from './parseGcash';

let workerPromise: Promise<Worker> | null = null;
let onProgress: ((label: string) => void) | null = null;

/** First scan downloads ~8 MB on a phone; after that it's cached and takes a few seconds. */
const TIMEOUT_MS = 180_000;

const LABELS: Record<string, string> = {
  'loading tesseract core': 'Downloading text reader (first time only)…',
  'loading language traineddata': 'Downloading English text data (first time only)…',
  'initializing api': 'Starting text reader…',
  'recognizing text': 'Reading receipt…',
};

function getWorker() {
  // One worker reused for all scans. The image itself never leaves the device.
  workerPromise ??= createWorker('eng', 1, {
    logger: (m) => {
      const label = LABELS[m.status];
      if (label) onProgress?.(m.progress > 0 && m.progress < 1 ? `${label} ${Math.round(m.progress * 100)}%` : label);
    },
  }).catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

async function resetWorker() {
  const p = workerPromise;
  workerPromise = null;
  try {
    await (await p)?.terminate();
  } catch {
    // ignore
  }
}

export interface OcrOptions {
  /** Only read this part of the image (photo of a phone screen: just the receipt). */
  crop?: CropBox;
  /** Grayscale + contrast stretch first (photos with glare / beige backgrounds / cracks). */
  enhance?: boolean;
  /**
   * Read twice with different layout modes and combine the text: one pass as a single block,
   * one as "sparse text". Noisy photos give different pieces in each, so together they cover more.
   */
  multiPass?: boolean;
  /**
   * Also read the original image without the grayscale/contrast step. Clean screenshots read best
   * as-is, noisy photos read best enhanced; reading both and comparing covers either case.
   */
  plainPass?: boolean;
}

export async function recognizeText(file: Blob, progress?: (label: string) => void, opts: OcrOptions = {}): Promise<string> {
  return (await recognizePasses(file, progress, opts)).join('\n');
}

/**
 * How the ref strip is re-read: sharpening strength and strip heights (px). Tuned in a real browser on
 * blurry phone photos: unsharpened strips read wrong digits consistently ("30044" for 58844), these
 * settings read the right ones at several sizes and never agreed on a wrong value.
 */
const REF_READS: { sharpen: number; heights: number[] }[] = [
  { sharpen: 0.7, heights: [100, 130, 220] },
  { sharpen: 1.2, heights: [100, 220, 260] },
];

/**
 * Same idea for the date (right side of the ref line). Small sizes with stronger sharpening read the
 * day and hour best (the month stays garbled on blurry photos; see dateFromReadings).
 */
const DATE_READS: { sharpen: number; heights: number[] }[] = [
  { sharpen: 1.2, heights: [80, 100, 130, 170] },
  { sharpen: 2, heights: [80, 100, 130, 170] },
];

/** The time alone (right end of the date), digits + AM/PM only. Tuned in Chrome on a blurry photo. */
const TIME_READS: { sharpen: number; heights: number[] }[] = [
  { sharpen: 0.7, heights: [60, 80, 100, 130, 170] },
  { sharpen: 2, heights: [60, 80, 100, 130, 170] },
];

/**
 * Second look at the reference line: finds it on the receipt, then reads only that strip, sharpened
 * and enlarged to a few sizes. Blurry photos that read as junk on the whole receipt
 * ("Ref ds 302? She 158844 Mice 18, 2020") often read correctly this way.
 * Returns each reading's last-5 ref guess, and the raw readings of the date part (right side of the
 * line) and of just the time (right end of the date).
 */
export async function readRefLine(
  file: Blob,
  crop: CropBox | undefined,
  progress?: (label: string) => void,
): Promise<{ tails: string[]; dates: string[]; times: string[] }> {
  onProgress = null;
  progress?.('Reading reference number and date…');
  const none = { tails: [], dates: [], times: [] };
  try {
    const [worker, canvas] = await Promise.all([getWorker(), prepareForOcr(file, { crop, enhance: true })]);
    // Find the line: as one block of text first, then as scattered text (finds lines the first misses).
    let box: ReturnType<typeof findRefLine> = null;
    for (const psm of [PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT]) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const lines: OcrLine[] = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      box = findRefLine(lines);
      if (box) break;
    }
    if (!box) return none;
    // Strips as fractions of the original photo (canvas coordinates are inside `crop`).
    const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const padY = (box.y1 - box.y0) * 0.35;
    const fx = (px: number) => c.x + (Math.max(0, Math.min(canvas.width, px)) / canvas.width) * c.w;
    const fy = (py: number) => c.y + (Math.max(0, Math.min(canvas.height, py)) / canvas.height) * c.h;
    const area = (x0: number, x1: number) => {
      const x = fx(x0);
      const y = fy(box.y0 - padY);
      return { x, y, w: fx(x1) - x, h: fy(box.y1 + padY) - y };
    };
    const refStrip = area(box.x0 - 6, box.x1 + 6);
    // The date sits on the right half of the line; the reader may cut the line short, so go to the card's edge.
    const dateStrip = area(box.x0 + (box.lineX1 - box.x0) * 0.5, canvas.width);
    const read = async (strip: CropBox, reads: typeof REF_READS, whitelist: string) => {
      const out: string[] = [];
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: whitelist });
      for (const { sharpen, heights } of reads) {
        for (const height of heights) {
          out.push((await worker.recognize(await prepareForOcr(file, { crop: strip, enhance: true, height, sharpen }))).data.text.trim());
        }
      }
      return out;
    };
    try {
      const tails = (await read(refStrip, REF_READS, '0123456789 ')).map(refTailFromDigits);
      const dates = await read(dateStrip, DATE_READS, '0123456789 ,:.ADFJMNOPSabceglnoprtuvy');
      // The time on its own (right end of the date): the minutes read far more often this way.
      const timeStrip = { ...dateStrip, x: dateStrip.x + dateStrip.w * 0.45, w: dateStrip.w * 0.55 };
      const times = await read(timeStrip, TIME_READS, '0123456789:AMP ');
      return { tails, dates, times };
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: '' });
    }
  } catch {
    return none;
  }
}

/** Like recognizeText, but returns each reading separately (so their results can be compared). */
export async function recognizePasses(file: Blob, progress?: (label: string) => void, opts: OcrOptions = {}): Promise<string[]> {
  onProgress = progress ?? null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out — check your internet connection')), TIMEOUT_MS);
  });
  try {
    const work = (async () => {
      const [worker, canvas] = await Promise.all([getWorker(), prepareForOcr(file, opts)]);
      const texts: string[] = [];
      const read = async (c: HTMLCanvasElement, psm: PSM) => {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        texts.push((await worker.recognize(c)).data.text);
      };
      if (opts.multiPass) {
        await read(canvas, PSM.SINGLE_BLOCK);
        await read(canvas, PSM.SPARSE_TEXT);
      } else {
        await read(canvas, PSM.AUTO);
      }
      if (opts.plainPass && opts.enhance) await read(await prepareForOcr(file, { crop: opts.crop }), PSM.AUTO);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      return texts;
    })();
    return await Promise.race([work, timeout]);
  } catch (e) {
    await resetWorker();
    throw e;
  } finally {
    clearTimeout(timer);
    onProgress = null;
  }
}
