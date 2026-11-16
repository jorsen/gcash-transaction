import { requireOptionalNativeModule } from 'expo';

export type OcrResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Reads the text in an image on-device (Google ML Kit on Android, Apple Vision on iOS).
 * Nothing is uploaded. The native module only exists in a development/production build,
 * not in Expo Go, so it is loaded lazily and the review screen falls back to manual entry.
 */
export async function recognizeText(imageUri: string): Promise<OcrResult> {
  if (!requireOptionalNativeModule('ExpoTextExtractor')) {
    return {
      ok: false,
      error:
        'Text recognition needs a development build (it does not work in Expo Go). Enter the details manually.',
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTextFromImage, isSupported } = require('expo-text-extractor') as typeof import('expo-text-extractor');
    if (!isSupported) {
      return { ok: false, error: 'Text recognition is not supported on this device. Enter the details manually.' };
    }
    const lines = await extractTextFromImage(imageUri);
    return { ok: true, text: lines.join('\n') };
  } catch (e) {
    return { ok: false, error: `Could not read the receipt: ${e instanceof Error ? e.message : String(e)}` };
  }
}
