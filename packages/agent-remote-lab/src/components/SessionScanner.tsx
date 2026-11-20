import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Translate } from '@orchardworks/agent-client';

function cameraFailure(error: unknown, t: Translate): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('sessions.scanner.denied');
  if (name === 'NotFoundError') return t('sessions.scanner.notFound');
  if (name === 'NotReadableError') return t('sessions.scanner.notReadable');
  return t('sessions.scanner.startFailed');
}

export function SessionScanner({ onRead }: { onRead(text: string): void }) {
  const t = useTranslate();
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(onRead); callback.current = onRead;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState(t('sessions.scanner.starting'));
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
      retired = true; stop(); setPaused(true); setStatus(t('sessions.scanner.paused'));
    };
    setFailure(undefined); setPaused(false); setStatus(t('sessions.scanner.starting'));
    document.addEventListener('visibilitychange', hide);
    async function start() {
      // The decoder loads with the first scan, not with the workbench (stage 6).
      let decodeQr: typeof import('jsqr').default;
      try { decodeQr = (await import('jsqr')).default; }
      catch { if (!retired) setFailure(t('sessions.scanner.decoderMissing')); return; }
      if (retired) return;
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setFailure(t('sessions.scanner.unsupported')); return;
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 720 } } });
        if (retired) { stop(); return; }
        element.srcObject = stream;
        await element.play();
        if (retired) return;
        setStatus(t('sessions.scanner.pointCamera'));
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error(t('sessions.scanner.decodingUnavailable'));
        function scan() {
          if (retired) return;
          try {
            if (element.readyState >= 2 && element.videoWidth && element.videoHeight) {
              const scale = Math.min(1, 640 / Math.max(element.videoWidth, element.videoHeight));
              canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
              context!.drawImage(element, 0, 0, canvas.width, canvas.height);
              const pixels = context!.getImageData(0, 0, canvas.width, canvas.height);
              const code = decodeQr(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
              if (code) { retired = true; stop(); callback.current(code.data); return; }
            }
            timer = setTimeout(scan, 200);
          } catch { stop(); setFailure(t('sessions.scanner.frameFailed')); }
        }
        scan();
      } catch (error) { stop(); if (!retired) setFailure(cameraFailure(error, t)); }
    }
    // Defer acquisition so a retired mount never requests camera access.
    queueMicrotask(() => { if (!retired) void start(); });
    return () => { retired = true; stop(); document.removeEventListener('visibilitychange', hide); };
  }, [attempt]);
  return <div className="lab-session-scanner">
    <div className="lab-session-camera"><video ref={video} muted playsInline aria-label={t('sessions.scanner.cameraLabel')} /><span aria-hidden="true" /></div>
    <p role={failure ? 'alert' : 'status'}>{failure ?? status}</p>
    {failure || paused ? <button type="button" onClick={() => setAttempt(value => value + 1)}>{paused ? t('sessions.scanner.resume') : t('sessions.scanner.retry')}</button> : null}
  </div>;
}
