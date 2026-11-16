import { createWorker, type Worker } from 'tesseract.js';
import { prepareForOcr } from './image';

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

export async function recognizeText(file: Blob, progress?: (label: string) => void): Promise<string> {
  onProgress = progress ?? null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out — check your internet connection')), TIMEOUT_MS);
  });
  try {
    const work = (async () => {
      const [worker, canvas] = await Promise.all([getWorker(), prepareForOcr(file)]);
      const { data } = await worker.recognize(canvas);
      return data.text;
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
