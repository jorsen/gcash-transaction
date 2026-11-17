import { createWorker, PSM, type Worker } from 'tesseract.js';
import { prepareForOcr, type CropBox } from './image';

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
