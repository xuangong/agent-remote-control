import { FILE_CONTENT_POLICY, FILE_FRAME_MESSAGE, FILE_FRAME_SANDBOX } from '@orchardworks/agent-remote-protocol';

export { FILE_FRAME_PATH } from '@orchardworks/agent-remote-protocol';

/**
 * Receives one HTML document from the website and replaces itself with it, scripts included. The response policy
 * sandboxes it into an opaque origin even when it is opened directly, and only the website may embed it.
 */
export const fileFrameDocument = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function render(event) {
  if (event.source !== parent || !event.data || event.data.type !== '${FILE_FRAME_MESSAGE}' || typeof event.data.html !== 'string') return;
  removeEventListener('message', render);
  document.open(); document.write(event.data.html); document.close();
});
parent.postMessage({ type: '${FILE_FRAME_MESSAGE}', state: 'ready' }, '*');
</script>`;

export const fileFrameHeaders: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `${FILE_CONTENT_POLICY}; frame-ancestors 'self'; sandbox ${FILE_FRAME_SANDBOX}`,
  'cache-control': 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
};
