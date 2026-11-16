import { Directory, File, Paths } from 'expo-file-system';

const receiptsDir = () => new Directory(Paths.document, 'receipts');

/**
 * Copies a picked/captured image into the app's own storage so the record keeps
 * its receipt even if the photo is later deleted from the gallery or cache.
 */
export async function persistReceiptImage(sourceUri: string): Promise<string> {
  const dir = receiptsDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const ext = sourceUri.match(/\.(jpe?g|png|heic|webp)$/i)?.[0] ?? '.jpg';
  const dest = new File(dir, `receipt-${Date.now()}${ext}`);
  await new File(sourceUri).copy(dest);
  return dest.uri;
}

/** Deletes an image previously stored by persistReceiptImage. Ignores anything else. */
export function deleteReceiptImage(uri: string) {
  if (!uri || !uri.includes('/receipts/')) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Missing file is fine.
  }
}

export function isStoredReceipt(uri: string) {
  return uri.includes('/receipts/receipt-');
}
