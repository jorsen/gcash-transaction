import { createWorker, type Worker } from 'tesseract.js';
import { prepareForOcr } from './image';

let workerPromise: Promise<Worker> | null = null;
let onProgress: ((pct: number) => void) | null = null;

function getWorker() {
  // One worker reused for all scans. The first call downloads the OCR engine + English data
  // (a few MB, cached afterwards). The image itself never leaves the device.
  workerPromise ??= createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100));
    },
  }).catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

export async function recognizeText(file: Blob, progress?: (pct: number) => void): Promise<string> {
  onProgress = progress ?? null;
  const [worker, canvas] = await Promise.all([getWorker(), prepareForOcr(file)]);
  const { data } = await worker.recognize(canvas);
  onProgress = null;
  return data.text;
}
