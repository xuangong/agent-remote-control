import { useEffect, useRef, useState } from 'react';

function cameraFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was denied. Allow camera access in your browser settings, then retry, or paste a session link.';
  if (name === 'NotFoundError') return 'No camera found. Paste a session link instead.';
  if (name === 'NotReadableError') return 'The camera is in use or unavailable. Close other camera apps and retry.';
  return 'The camera could not start. Retry or paste a session link.';
}

export function SessionScanner({ onRead }: { onRead(text: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(onRead); callback.current = onRead;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Starting camera…');
  const [failure, setFailure] = useState<string>();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let retired = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const element = video.current!;
    const stop = () => { if (timer) clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); if (element.srcObject === stream) element.srcObject = null; };
    const hide = () => {
      if (!document.hidden) return;
      retired = true; stop(); setPaused(true); setStatus('Camera paused.');
    };
    setFailure(undefined); setPaused(false); setStatus('Starting camera…');
    document.addEventListener('visibilitychange', hide);
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setFailure('Camera scanning is unavailable in this browser. Use HTTPS or paste a session link.'); return;
        }
        // Load decoding only while scanning. Five bounded frames per second keep mobile work low.
        const { default: decode } = await import('jsqr');
        if (retired) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 720 } } });
        if (retired) { stop(); return; }
        element.srcObject = stream;
        await element.play();
        if (retired) return;
        setStatus('Point your camera at a session QR code.');
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Camera decoding is unavailable');
        function scan() {
          if (retired) return;
          try {
            if (element.readyState >= 2 && element.videoWidth && element.videoHeight) {
              const scale = Math.min(1, 640 / Math.max(element.videoWidth, element.videoHeight));
              canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
              context!.drawImage(element, 0, 0, canvas.width, canvas.height);
              const pixels = context!.getImageData(0, 0, canvas.width, canvas.height);
              const code = decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
              if (code) { retired = true; stop(); callback.current(code.data); return; }
            }
            timer = setTimeout(scan, 200);
          } catch { stop(); setFailure('This camera frame could not be read. Retry or paste a session link.'); }
        }
        scan();
      } catch (error) { stop(); if (!retired) setFailure(cameraFailure(error)); }
    }
    void start();
    return () => { retired = true; stop(); document.removeEventListener('visibilitychange', hide); };
  }, [attempt]);
  return <div className="lab-session-scanner">
    <div className="lab-session-camera"><video ref={video} muted playsInline aria-label="Session QR camera" /><span aria-hidden="true" /></div>
    <p role={failure ? 'alert' : 'status'}>{failure ?? status}</p>
    {failure || paused ? <button type="button" onClick={() => setAttempt(value => value + 1)}>{paused ? 'Resume camera' : 'Retry camera'}</button> : null}
  </div>;
}
