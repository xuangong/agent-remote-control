# Local previews and Markdown images

The hosted Controller can expose a workstation's loopback HTTP service through an authenticated preview origin. Markdown local images use the session resource protocol independently of port registration. Both features require the updated browser, Relay, and Controller.

## Preview flow

A timeline block containing a loopback URL offers **Open preview**. Rendering a block does not register its port. Registration records the source session and timeline item on the Controller. Root-mounted apps open immediately after registration; configured-base apps show their registration ID for configuration first. **Open preview** in either the timeline or Host preview list prepares and redeems a short-lived entry proof, then opens an iframe browser inside the current workbench. No new tab or top-level navigation is required, including Safari Home Screen standalone mode.

The public route is `https://agents.xianliao.de5.net/p/<id>/<path>?<query>`. Registration selects one fixed loopback origin, including its port. HTTP paths and WebSocket handshakes cannot choose another target. No public wildcard hostname or wildcard certificate is required.

The Controller opens a separate outbound WebSocket to `/ws/preview-tunnel` on the control origin. HTTP request and response bodies use multiplexed binary chunks with credit and cancellation; SSE passes through as a stream without collecting the full response. WebSockets have an independent upstream handshake, selected subprotocol, text/binary messages, and close propagation. The data connection reconnects independently of chat. Interrupted requests fail and are not replayed.

The Controller persists registrations under its state directory, scoped to Relay origin and Host identity. The default fixed lifetime is one hour. Restart preserves the deadline; it does not extend it. Expired and unregistered records remain as bounded history. Active registrations reconnect after the control connection registers again. With no active registrations, the data connection closes.

Full snapshots carry an epoch and revision over the control uplink. The browser refreshes the authoritative Host snapshot every five seconds and when the tab becomes visible. Connectivity and lifecycle are separate: an active registration can be offline. The Host preview list shows source links and supports unregistering. An offline unregister is durably queued at Relay, immediately blocks routing there, and is retried after Controller reconnect until an authoritative snapshot confirms removal.

## Authorization

Only the Host owner can register targets, prepare preview access, list registrations, or unregister. Existing Host sharing does not grant preview or arbitrary local image resolution rights.

The entry URL contains a one-use proof in its fragment, valid for 60 seconds. The workbench redeems the proof through a same-origin POST before mounting the iframe, obtaining an HttpOnly, host-only cookie scoped to `/p/<id>/`. The iframe receives only the final preview URL. Direct entry-page consumers can still redeem the fragment through the existing handoff page; that page itself disallows framing. No Relay login cookie or tunnel credential is forwarded to the local service. Authorization and proxy identity headers are stripped; the upstream Origin is rewritten to the registered local origin after validating the browser origin at Relay. Each HTTP request and WebSocket handshake checks the original Relay browser session, current owner access, active registration, and Controller availability. Existing streams are rechecked on lifecycle changes and at most every 15 seconds, subject to the existing Gateway authority lease.

Previews use the control origin by default. The Relay reserves `/p/<id>/` and `/_arc/enter` for previews while preserving the main UI, authentication, session APIs, and control WebSocket routes. Preview scripts share the control site browser privileges: they can call authenticated main-site APIs and access its storage. Cookie paths and upstream credential stripping do not isolate same-origin scripts. Use this mode only for trusted local applications. A separate preview origin remains configurable to isolate preview scripts from the control site; previews on that origin still share browser privileges with each other. Service worker registration through preview routes is denied. Unknown request hostnames are rejected.

Targets are loopback HTTP or HTTPS origins. The Controller validates target addresses, redirects, methods, paths, headers, frame sizes, stream limits and queue bounds. Redirects are returned to the browser rather than followed by the Controller. Configure protected local ports if other administrative services listen on TCP.

## Embedded browser

The browser uses a right-side dialog on desktop with an expand control, and fills the viewport on mobile with safe-area padding. The underlying conversation stays mounted, preserving its scroll position and draft. **Minimize preview** shrinks the browser toward a compact dock on the source session’s right edge, without allocating another toolbar row. The iframe stays mounted while minimized, preserving application state, scroll position, and its navigation history. Clicking the dock restores the same browser without requesting another entry proof. Previews are scoped to their source session, so switching sessions on the same Host keeps each session’s previews available. The dock remains available when the mobile conversation heading is hidden. The 240 ms transform and opacity animation honors reduced-motion preferences. Closing from the toolbar or dock removes that iframe and aborts its pending entry request without unregistering the port. Changing Hosts or leaving the page releases the retained browsers. Expired or unregistered previews and Controller disconnections remove the iframe and display the current access state. Entry requests and initial page loading have a 20-second deadline or loading notice.

Back and Forward use a panel-owned URL history instead of traversing the parent conversation history. Full-document navigation, hash changes, and History API changes update the address display. Toolbar history navigation reloads the selected URL; it does not restore arbitrary application JavaScript state or replay POST bodies. Same-origin links and forms targeting another window are kept inside the iframe, and subsequent `window.open` calls use the frame. The sandbox does not grant popups or top navigation, but trusted same-origin application scripts are not a security isolation boundary. Cross-origin pages cannot expose their navigation to the toolbar and may refuse embedding; the panel retains Reload and Close controls. Applications that disallow framing need their own frame policy configured.

The embedded workbench requires previews on the Relay origin. An explicitly configured separate preview origin still supports direct entry links through the headless client, but cannot use this same-origin redemption and navigation UI. Browser acceptance runs on Chromium and mobile WebKit, including minimize/restore document identity, application form and scroll preservation, session-specific docks, close cleanup, and reduced motion; installing WebKit with `pnpm --filter @agent-remote-controller/agent-remote-lab exec playwright install webkit` is required for `pnpm test:preview-browser`. These tests do not substitute for a physical iOS Home Screen installation check.

## Application paths

| Mode | Upstream path | Supported behavior |
| --- | --- | --- |
| Root-mounted app (`strip`) | `/p/<id>/me` becomes `/me` | Same-target redirects, app cookie paths, and supported HTML/CSS references are rewritten under the preview prefix. |
| Configured preview base (`preserve`) | `/p/<id>/me` stays `/p/<id>/me` | The app generates its own prefixed links and WebSocket URLs. HTML/CSS bytes pass through. |

HTML/CSS adaptation is bounded to 1 MiB of decoded UTF-8 content and accepts identity or gzip encoding. Partial 206/Content-Range responses pass through unchanged. It parses static attributes and styles rather than rewriting JavaScript source. Relative references keep browser-relative semantics; supported root-relative and same-target references receive the prefix. Arbitrary JavaScript-generated URLs, service workers, cross-port APIs, and every framework's root assumptions cannot be transparently adapted. Use a configured base for development servers and complex apps.

For Vite, register using **Configured preview base**, copy the returned ID, and set the base and browser-facing HMR endpoint before restarting the local server:

```ts
export default {
  base: '/p/<id>/',
  server: {
    host: '127.0.0.1',
    hmr: {
      protocol: 'wss',
      host: 'agents.xianliao.de5.net',
      clientPort: 443,
    },
  },
};
```

A new registration can have a new ID, requiring a corresponding base update. Multiple apps are selected by their explicit route prefix; the router does not infer an active app from Referer.

## Configuration

No additional domain configuration is needed for same-origin previews. With `AGENT_REMOTE_PREVIEW_URL` unset or empty, previews use `AGENT_REMOTE_RELAY_URL`, including the existing DNS and certificate. Node Docker and Workers share this default. The Workers configuration declares only the control Custom Domain. An optional `AGENT_REMOTE_PREVIEW_URL` can select a separate origin after its DNS, certificate, and routing are configured. Reverse-proxy preview paths to the Relay listener, preserve Host and Origin headers, support WebSocket upgrades, and turn off response buffering for SSE. Configuration in source does not deploy the service.

The Controller CLI enables previews with its existing managed state directory. `AGENT_HOST_PREVIEW_TTL_MS` sets the fixed registration lifetime in milliseconds; the default is `3600000`. `AGENT_HOST_PREVIEW_PROTECTED_PORTS` accepts comma-separated TCP ports. Programmatic `createAgentHost` users enable the feature through the optional `preview` configuration.

A single application WebSocket message is limited to 256 KiB minus a 512-byte framing allowance. Larger payloads require application-level chunking.

Workers exposes no WebSocket drain metric. Application-facing preview WebSockets therefore have a conservative 16 MiB lifetime egress budget and close with code 1013 when reached; clients can reconnect. Dedicated Controller tunnel traffic instead uses explicit peer credit to bound outstanding data. HTTP/SSE is not subject to that application-WebSocket lifetime limit.

## Markdown local images

`react-markdown` and a rehype image-node marker identify actual inline and reference images. Code fences and ordinary text do not trigger file reads. Local locators include `/absolute/path/image.png`, `file:///absolute/path/image.png`, and relative paths such as `./assets/image.png`. The parser does not turn these into requests to `agents.xianliao.de5.net/Users/...`.

The browser resolves an unbound locator through `resource_resolve_request`, authorized separately as `resolve_resource`, then reads the returned session-scoped resource ID through `resource_request`. Existing bindings remain readable through their existing authorization. The Host captures the session's initial `runtimeInfo.cwd` as the authorized root. Relative references use the source document directory when an absolute source locator is available, otherwise the session root. A session with no valid cwd cannot resolve arbitrary local image paths.

Canonical paths must remain under the authorized root after symlink resolution. Reads require a regular non-empty file, are limited to 4 MiB so Base64 responses fit the existing control-frame limit, and inspect PNG/JPEG/GIF/WebP signatures. SVG, arbitrary URI reads, directories, missing files and out-of-root paths return unavailable. The renderer shares bounded resolve/request caches, shows loading or unavailable text, and renders available bytes as an inert image data URL. It does not register a port or expose a filesystem HTTP mount.

## Validation

Focused tests cover real outbound Controller HTTP binary data and uploads, early SSE delivery, WebSocket subprotocol and binary messages, owner isolation, unregister cancellation, persistent registrations, and protocol queue limits. A real session WebSocket test resolves a document-relative PNG and reads exact bytes through the existing resource protocol. Renderer tests cover inline/reference images, source context, deduplication and code-fence non-resolution. Miniflare/workerd tests exercise real local HTTP/WebSocket forwarding and persist snapshots and offline removal across Durable Object restarts. `pnpm test:preview-browser` launches Chromium against a real Node Relay and Controller: it verifies a prefixed Vite app with hot reload and a local Markdown PNG loaded through actual authenticated resource frames. The browser fixture does not start a native provider CLI.

The Lab regression run excludes the opt-in native Codex process suite and retains its existing skipped cases. No production Controller, external native daemon, public domain, or deployed Relay is used by this acceptance.
