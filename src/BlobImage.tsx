import { useEffect, useState } from 'react';

/** Renders an image stored as a Blob, managing its object URL. */
export function BlobImage({ blob, className, alt = '' }: { blob: Blob | null; className?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing an external resource (object URL)
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [blob]);

  if (!blob || !url) return <span className={`${className ?? ''} placeholder`} />;
  return <img src={url} className={className} alt={alt} />;
}
