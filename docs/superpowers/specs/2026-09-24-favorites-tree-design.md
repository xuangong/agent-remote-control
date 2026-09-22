# Favorites tree

## Approved experience

Favorites is an account-wide organization module alongside Sessions. A root contains folders and session bookmarks in manual mixed order. Folders nest, expand, collapse, rename, move and delete. Existing bookmarks migrate to root in their current order. A session remains unique by Host, provider and native session ID. Fork replacement preserves its bookmark identity, folder and position.

Rows use compact icons, names and an overflow menu. Host metadata is secondary. Track remains local to the browser; moving or deleting bookmarks never changes native sessions or Track. Mobile session titles retain their Favorites shortcut. Folder expansion is local and account scoped.

A star opens an editor with folder selection (root by default), inline folder creation, save and remove. Tree menus provide rename, move and delete. Deleting a nonempty folder requires explicit confirmation with bookmark count. Move-to selection and keyboard controls supplement mouse and touch dragging. Drop between siblings reorders; drop onto a folder moves inside. Hover expands folders and edge proximity scrolls. Self/descendant drops are invalid. Touch dragging starts deliberately on a handle after a hold, leaving normal scrolling available elsewhere.

## Storage and boundaries

Relay owns durable account data. Existing `sessionStars` remain the session records, augmented with stable bookmark ID, folder ID and order. A per-account tree stores folders and revision. Unorganized records get deterministic identities and root positions; migration is durable with the first mutation. The new authenticated `/v1/favorites` endpoint returns `{revision, folders, stars}` and accepts revision-checked commands. Existing `/v1/stars` remains usable, preserving organization and advancing revisions. No Controller or native protocol changes.

Folder records: `{id, parentId: string|null, title, order}`. Organized visible stars add `{favoriteId, folderId: string|null, order}`. Commands: `create-folder` (id, parentId, title), `rename-folder` (id, title), `move` (id, parentId, beforeId: string|null), `delete-folder` (id), `save-session` (session, folderId), `remove-session` (session identity). Each carries `revision`. Mutations are atomic; reject stale revisions, missing targets, cycles, excessive depth and foreign account identifiers. Client refreshes after conflict without automatically replaying destructive intent. Persistence failures do not publish success.

## Validation

Test migration, nesting, rename, mixed sorting, cycle rejection, account isolation, stale edits, delete, persistence and fork migration. Exercise real authenticated HTTP and Durable Object restart. Browser tests cover desktop/phone layouts, pointer movement, touch hold, auto expansion, move-to fallback, keyboard operation, focus, title menu and narrow-screen overflow. Run typechecks, production build and compatibility update/check. No deployment or Controller restart is part of implementation authorization.
