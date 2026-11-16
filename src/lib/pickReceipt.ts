import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

export type ReceiptSource = 'camera' | 'gallery';

/** Opens the camera or the photo gallery and returns the chosen image URI, or null if cancelled. */
export async function pickReceipt(source: ReceiptSource): Promise<string | null> {
  const perm =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!perm.granted) {
    Alert.alert(
      'Permission needed',
      source === 'camera'
        ? 'Allow camera access to capture GCash receipts.'
        : 'Allow photo access to import GCash receipt screenshots.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return null;
  }

  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1 };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);

  if (result.canceled || !result.assets?.length) return null;
  return result.assets[0].uri;
}
