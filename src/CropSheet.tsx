import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { BlobImage } from './BlobImage';
import type { CropBox } from './image';
import { Icon } from './ui';

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
const MIN = 0.12;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Full-screen step to frame the receipt in a photo (e.g. a customer's phone screen):
 * drag the box or its corners over the receipt. Reading only that part is far more accurate.
 */
export function CropSheet({
  file,
  title = 'Frame the receipt',
  onDone,
  onCancel,
}: {
  file: Blob;
  title?: string;
  /** Crop box as fractions of the image, or undefined for the whole photo. */
  onDone: (crop: CropBox | undefined) => void;
  onCancel: () => void;
}) {
  // Start with the middle of the photo, where the phone screen usually is.
  const [box, setBox] = useState<CropBox>({ x: 0.12, y: 0.15, w: 0.76, h: 0.7 });
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; px: number; py: number; start: CropBox } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const down = (handle: Handle) => (e: RPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { handle, px: e.clientX, py: e.clientY, start: box };
  };

  const move = (e: RPointerEvent) => {
    const d = drag.current;
    const rect = wrap.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = (e.clientX - d.px) / rect.width;
    const dy = (e.clientY - d.py) / rect.height;
    const s = d.start;
    let { x, y, w, h } = s;
    if (d.handle === 'move') {
      x = clamp(s.x + dx, 0, 1 - s.w);
      y = clamp(s.y + dy, 0, 1 - s.h);
    } else {
      if (d.handle.includes('w')) {
        x = clamp(s.x + dx, 0, s.x + s.w - MIN);
        w = s.w + (s.x - x);
      }
      if (d.handle.includes('e')) w = clamp(s.w + dx, MIN, 1 - s.x);
      if (d.handle.includes('n')) {
        y = clamp(s.y + dy, 0, s.y + s.h - MIN);
        h = s.h + (s.y - y);
      }
      if (d.handle.includes('s')) h = clamp(s.h + dy, MIN, 1 - s.y);
    }
    setBox({ x, y, w, h });
  };

  const up = () => {
    drag.current = null;
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <div className="crop-screen" role="dialog" aria-modal="true" aria-label={title}>
      <header className="crop-head">
        <button className="icon-btn" aria-label="Cancel" onClick={onCancel}>
          <Icon name="close" />
        </button>
        <div className="appbar-title">
          <h1>{title}</h1>
          <small>Drag the box over the receipt only</small>
        </div>
      </header>

      <div className="crop-stage" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="crop-wrap" ref={wrap}>
          <BlobImage blob={file} alt="Photo to crop" className="crop-img" />
          <div className="crop-shade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${pct(box.x)} ${pct(box.y)}, ${pct(box.x)} ${pct(box.y + box.h)}, ${pct(box.x + box.w)} ${pct(box.y + box.h)}, ${pct(box.x + box.w)} ${pct(box.y)}, ${pct(box.x)} ${pct(box.y)})` }} />
          <div
            className="crop-box"
            style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
            onPointerDown={down('move')}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map((hnd) => (
              <span key={hnd} className={`crop-handle ${hnd}`} onPointerDown={down(hnd)} />
            ))}
          </div>
        </div>
      </div>

      <div className="crop-actions">
        <button className="btn secondary" onClick={() => onDone(undefined)}>
          Use whole photo
        </button>
        <button className="btn primary" onClick={() => onDone(box)}>
          <Icon name="check" size={20} /> Read this part
        </button>
      </div>
    </div>
  );
}
