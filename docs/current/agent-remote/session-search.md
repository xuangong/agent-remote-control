# Session history search

Every product and ARDB Session View shares the same search panel. The search button
is in the timeline's top-right corner. Ctrl/Cmd+F also opens it when the timeline
has focus. Searches belong to one view and one timeline epoch.

The default scope is **User / Assistant messages**. Readers can choose **All
activity**, **Tool calls**, or **Reasoning**. These scopes apply to loaded entries
and every historical page. Results are case-insensitive literal text matches,
one result per normalized timeline entry, ordered newest first. Enter and
Shift+Enter navigate results; Escape closes the panel.

`RemoteSessionClient.searchTimeline()` scans the loaded replica and then follows
the existing `before` history cursor. It reports incremental matches and supports
cancellation. Scanning neither mutates the replica nor mounts historical entries;
it retains matching summaries only. Rendering the result list is bounded in
batches of 30. Live loaded entries supersede their scanned summaries.

Selecting a result calls `loadSearchMatch()` to load contiguous history as needed,
then uses the shared timeline reading anchor to reveal the entry. Hidden reasoning
or tool entries are temporarily included even in the content display mode, with
their details opened. This does not change other views' display modes or focus.

A finished scan covers all history exposed by the current provider through the
Remote protocol. It does not search file-resource bodies, images, unavailable
native history, or future events in a paused recording. A disconnected view can
search its loaded entries, but must show partial coverage when older history is
unavailable. Failures, stale cursors, epoch changes, and stopped scans never claim
complete coverage. Closing or changing the search cancels its outstanding work;
an already dispatched shared history load may finish but cannot navigate a new
view. No new server endpoint, provider API, or wire message is required.

Regression coverage includes history scanning and scope filtering, canceled and
failed scans, result navigation, and real HTTP pagination through the public
client and shared view in Chromium and WebKit at desktop and mobile widths.
