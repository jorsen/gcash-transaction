import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

/**
 * Full-screen camera inside the app (no switch to the phone's camera app).
 * Some phones (e.g. Honor / Huawei) close the browser while their camera app is open, so the
 * photo never comes back to the page. Taking it here avoids that.
 */
export function CameraSheet({
  title = 'Take a photo',
  onCapture,
  onCancel,
  onGallery,
}: {
  title?: string;
  onCapture: (photo: Blob) => void;
  onCancel: () => void;
  /** Pick an existing photo instead (also offered when the camera can't start). */
  onGallery: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Kept in a ref so a parent re-render (new inline function) doesn't restart the camera.
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = video.current;
        if (v) {
          v.srcObject = s;
          await v.play().catch(() => undefined);
        }
        setReady(true);
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission is blocked. Allow the camera for this app in Chrome (tap the 🔒 / ⓘ in the address bar → Permissions), or upload a photo instead.'
            : "The camera couldn't start on this phone. Upload a photo instead.",
        );
      }
    })();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setBusy(true);
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    canvas.toBlob(
      (b) => {
        setBusy(false);
        if (b) onCapture(b);
        else setError("Couldn't take the photo. Try again or upload a photo.");
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div className="crop-screen" role="dialog" aria-modal="true" aria-label={title}>
      <header className="crop-head">
        <button className="icon-btn" aria-label="Cancel" onClick={onCancel}>
          <Icon name="close" />
        </button>
        <div className="appbar-title">
          <h1>{title}</h1>
          <small>Fill the screen with the receipt, hold still, then tap the button</small>
        </div>
      </header>

      <div className="crop-stage camera-stage">
        {error ? (
          <p className="camera-error">{error}</p>
        ) : (
          <video ref={video} className="camera-video" playsInline muted autoPlay />
        )}
        {!error && !ready && <span className="spinner" />}
      </div>

      <div className="crop-actions">
        <button className="btn secondary" onClick={onGallery}>
          <Icon name="image" size={20} /> Upload photo
        </button>
        {!error && (
          <button className="btn primary" onClick={snap} disabled={!ready || busy}>
            <Icon name="camera" size={20} /> Take photo
          </button>
        )}
      </div>
    </div>
  );
}
