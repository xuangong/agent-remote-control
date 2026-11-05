/**
 * The website serves this document apart from its own policy, so a previewed HTML file runs its scripts there in an
 * opaque origin: it can read neither the website nor its cookies and storage.
 */
export const FILE_FRAME_PATH = '/file-frame';
/** The type of every message between the file frame and the website. */
export const FILE_FRAME_MESSAGE = 'agent-file-frame';
/**
 * What a previewed HTML file may run and load, as a browser would show it: inline scripts, its inlined local files and
 * HTTPS resources and requests. Forms run their handlers but never submit, and the base URL cannot change.
 */
export const FILE_CONTENT_POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: https:; style-src 'unsafe-inline' data: https:; "
  + "img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; form-action 'none'; base-uri 'none'";
/** What the file frame may do beyond running scripts: dialogs, form handlers, and links that open a new tab. */
export const FILE_FRAME_SANDBOX = 'allow-scripts allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox';
