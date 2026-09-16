# Markdown Local Resource Rendering Research

## Recommendation

Keep `react-markdown` with the existing `remark-gfm` and `remark-breaks` plugins. Add a small rehype plugin to classify image locators before URL filtering, a custom React image component, and a session-scoped resource resolver/cache. Remote file access belongs to the authenticated resource layer, not the Markdown parser.

This is research only. No product implementation, deployment, or production file-access validation is included.

## Current implementation

Reviewed the main checkout at `20acc1486427dbd66e725055e3f4a28d197cf463`. Installed versions include React 18.3.1, react-markdown 10.1.0, remark-gfm 4.0.1, and remark-breaks 4.0.0.

- `packages/agent-remote-web/src/react/MarkdownContent.tsx` maps `img` to an alt-text span. Markdown images therefore do not initiate image requests.
- Its `safeLink` retains slash-prefixed values and HTTP/HTTPS/mailto URLs, but rejects `file:` and dot-relative paths. Protocol-relative URLs such as `//example.com/a.png` pass through and must not be mistaken for local filesystem paths.
- `MessageItem.tsx` supplies only Markdown text. Resource bindings and loaded resources are supplied separately to `ResourceList` by `AgentTimeline`.
- `remote-session-client.ts` exposes `requestResource(resourceId)` through the session message channel. `session-wire.ts` authorizes `read_resource` before dispatching the resource read.
- `ResourceCard.tsx` already renders supported raster image bytes as data URLs. `ResourceList.tsx` loads image resources, but request deduplication is local to that component instance.
- `AgentCommandDetails.tsx` decodes a documentation resource into Markdown text. Relative images in such documents also need the source document locator, which is not currently passed to `MarkdownContent`.

## Parsing pipeline

```text
Markdown text
  -> remark-parse: Markdown syntax tree (mdast)
  -> remark plugins: GFM and line-break behavior
  -> remark-rehype: HTML-shaped syntax tree (hast)
  -> rehype plugins: proposed resource locator classification
  -> react-markdown URL filtering
  -> custom React components
  -> image component requests an authorized resource when needed
  -> loaded bytes become an image source
```

Parsing itself does not fetch files. For `![result](/Users/zhangxian/project/result.png)`, the parser produces an image node with that destination. A normal DOM image with that `src` would target the website origin, for example `https://agents.xianliao.de5.net/Users/zhangxian/project/result.png`. That is not access to the Controller filesystem. The current alt-text renderer does not create that DOM image at all.

Inline and reference-style images become the same HAST image shape after `remark-rehype`. This makes a rehype plugin a convenient integration point. Use remark nodes if exact original Markdown spelling or definition positions are needed; HAST destinations are parsed URLs, not guaranteed byte-for-byte source text.

## Component comparison

| Candidate | Parsing and extension model | Fit for this project |
| --- | --- | --- |
| react-markdown with remark/rehype | Markdown AST to HAST to replaceable React components; URL transform hook | Recommended. Already integrated, preserves scoped footnotes, tables, inert HTML, and existing styling. |
| Streamdown | React renderer focused on streaming, incomplete Markdown repair, memoized rendering, and optional rich-content plugins | Worth a separate evaluation for streaming UX. It does not supply our Controller resource resolver or authorization. Its styles and parsing changes require migration validation. |
| markdown-it | Markdown token parsing and configurable rendering, commonly producing an HTML string | Capable parser, but adds React integration work and replaces working rendering conventions without solving remote file access. |

Candidate assessment is based on official documentation, not a performance benchmark or a Streamdown installation test.

## Parsing experiment

The scratch probe `.tmp/markdown-research/probe.mjs` uses installed dependencies and React server rendering. It exercises the current URL filter and alt renderer while capturing HAST before filtering and component props afterwards. An internal 10-second deadline and an outer 20-second subprocess timeout bound execution.

All 11 cases passed: absolute local image, relative image, file URL image, reference image, HTTPS image, protocol-relative image, code spans/fences, escaped image syntax, bare local path, incomplete image syntax, and unresolved image reference.

Absolute and reference images preserve their destination. Relative and file URLs reach the rehype plugin but are removed before the React image component runs. Both `src` and `node.properties.src` have already changed at that point. A locator stored in `node.data` survives filtering. Code, bare paths, incomplete destinations, and unresolved references produce no image nodes in these examples. Escaping the exclamation mark suppresses the image but can still leave an ordinary Markdown link.

These checks establish parser behavior and hook ordering. They do not establish browser networking, Controller filesystem permissions, or full streaming performance.

## Proposed integration contract

1. Classify actual image nodes with a pure AST transform. Distinguish remote HTTP URLs, protocol-relative URLs, local absolute paths, file URLs, and relative paths. Do not scan the entire Markdown with a regular expression. Preserve a local locator in internal node metadata and remove the local `src` so it cannot accidentally reach a DOM image. Continue existing filtering for ordinary links.
2. Supply resource context outside the parser: Controller identity, agent/session scope, source document locator when available, resource bindings, and the reader/resolver. Define local-path interpretation explicitly for agent messages; a slash prefix alone also has legitimate website-root semantics.
3. Resolve existing locator bindings first. For unbound local locators, introduce an explicit authenticated resolution operation that can create or return an authorized resource ID. The existing `requestResource(resourceId)` cannot read arbitrary paths by itself. The Controller must resolve canonical paths, apply the allowed filesystem scope including symlink handling, and reject unsupported schemes or file types.
4. Let the custom image component request content through a shared resource cache. Keep requests outside parser execution and React render. Deduplicate by session/Controller scope and resource identity/version; handle cancellation, retry, invalidation, and disconnected state. Use visibility to defer the actual resource request; `loading="lazy"` alone does not defer an application-issued RPC.
5. Render supported image bytes through the existing image MIME policy and a data or object URL. If object URLs are used, release them on eviction. Show loading, unavailable, and retry states inline. Preserve stable image identity during streamed text updates so repeated parsing does not cause repeated reads.

For a Markdown document at `/workspace/docs/report.md`, `./images/result.png` resolves relative to that document. For a free-form agent message with no source document, use an explicitly defined session workspace base or leave the path unresolved; do not silently use the browser page URL or guess from a basename.

Local images use the file-resource reader rather than registering a local HTTP port. Localhost web links can use the separately designed preview registration flow. Both may share the authenticated Controller transport, while retaining different resource and lifecycle semantics.

## Primary sources

- [react-markdown architecture, components, URL transform, and security](https://github.com/remarkjs/react-markdown)
- [Installed-version react-markdown implementation](https://github.com/remarkjs/react-markdown/blob/10.1.0/lib/index.js), also inspected directly in the checkout's installed package
- [Streamdown features and integration requirements](https://github.com/vercel/streamdown)
- [markdown-it parsing and rendering API](https://github.com/markdown-it/markdown-it)
