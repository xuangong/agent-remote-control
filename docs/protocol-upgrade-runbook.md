# Protocol upgrades without losing remote management

Use this runbook whenever a release changes the public session protocol. Its goal
is to keep remote machines discoverable and remotely upgradeable, including machines
that are offline during deployment. Session compatibility and upgrade reachability
are separate acceptance criteria. This procedure does not promise uninterrupted
native tasks or automatic recovery from every runtime failure.

See [Controller releases and remote updates](controller-updates.md) for installation
behavior and [deployment](current/agent-remote/deployment.md) for deployment commands.

## Compatibility boundaries

| Boundary | Rule during a session protocol transition |
| --- | --- |
| Public session protocol | Keep schemas, fixtures, replay behavior and compatibility metadata synchronized. Strict session consumers must use compatible contracts. |
| Host management uplink | Preserve registration, heartbeat, Host listing and update GET/POST independently of session negotiation. It remained version 2 during the 1.7.0 transition. |
| Release manifest and updater | Inspect the actual published old package. A current updater fix cannot change an updater already running on a remote machine. Keep manifests readable by old strict decoders. |
| Stable launcher | Verify replacement and rollback using the original installed launcher, which may be older than the running Controller. An incompatible launcher contract needs a separately planned bootstrap. |
| Native provider | Controller publication does not update Codex or other native executables. Validate their contracts separately. |

A Host with an incompatible session protocol must still be able to register,
appear in the owner's management UI, report upgrade status and accept its next
compatible update. Do not put those operations behind successful session attachment.
If management, authentication or the launcher must also change, design and verify
their overlap first; session-protocol independence alone cannot preserve access.

## Phase 1: preserve compatibility and migrate

1. **Inventory installed versions and recovery paths.** Include offline machines,
   updater restrictions, bootstrap launcher versions, Node requirements, platforms
   and installation modes. Record versions that cannot upgrade directly. Do not
   infer compatibility from version ordering or only from current source.
2. **Prepare each required intermediate release.** If an old updater requires
   protocol equality, build an updater repair on its old protocol/runtime baseline.
   Publish it with its truthful protocol version; never relabel the new runtime or
   rewrite an existing tag/manifest. Keep intermediate packages stable and available
   without replacing the final release as latest. Existing verified releases may
   already provide the required path.
3. **Validate before changing the fleet.** Exercise real old release bytes and their
   original launcher through each hop, candidate startup failure, automatic rollback
   and a fresh retry. Test the new Relay and browser with mixed versions and an
   offline Host reconnecting after a Relay restart. Use the matrix below.
4. **Establish an upgrade-capable baseline while the old service is available.**
   If the fleet needs a preparatory update, have the owner apply it through the
   existing website. When the operator asks to perform this update themselves,
   notify them of the exact version and wait for confirmation before the dependent
   deployment. “Published” does not mean “installed”; elapsed time is not confirmation.
   Do not proceed with a machine lacking either a verified remote route or an
   explicitly arranged recovery plan. Offline status is not retirement.
5. **Publish and verify the final Controller before deploying its website path.**
   Build from a clean reviewed commit; verify tag, revision, manifest and tarball
   checksum. Ensure all intermediate assets are public, publish the final release
   as latest, then download the public manifest/package again and check their bytes.
   GitHub publication and npm publication are separate operations.
6. **Deploy the compatible Relay and website.** Retain old management admission and
   all required intermediate paths. Resolve targets per registered Host identity;
   revalidate POST server-side instead of trusting browser-supplied installed versions.
   Missing intermediate assets must block only affected Hosts. Preserve credentials,
   installation IDs, state directories, storage identities and configured secrets.
7. **Verify production and request the final Controller update.** Check deployment
   revision, health and served asset hashes. Notify the owner of the target version
   and let them confirm each hop. Use the release Refresh control if cached discovery
   is stale. Do not silently queue offline upgrades or launch the second hop.
8. **Confirm completion separately.** Record the running Controller version and
   management reconnection, then verify the required session behavior. Label owner
   confirmation separately from direct observation. An update POST returning 202
   means accepted; a published package, download, or lost connection is not proof
   that the new runtime started. Leave compatibility paths in place after success.

The sequence is: preserve an upgrade route on the old service, confirm any required
baseline update, publish verified packages, deploy the compatible new service, then
ask the owner to apply and confirm the final Controller update. The fleet baseline
is a rollout-specific choice, not a permanently required version number.

## Required validation and failure handling

| Scenario | Evidence required |
| --- | --- |
| Old Controller, new Relay | Real management registration, heartbeat, update status and update request work despite session mismatch. Test owner authorization through the actual Relay/Worker boundary. |
| Each intermediate hop | Original published updater/launcher installs checksum-verified bytes, preserves installation identity and reconnects with the expected version. |
| Candidate fails registration | Original launcher restores the previous runtime; status explains the failure; management GET and a new POST still work. |
| Mixed fleet, missing intermediate | Each Host gets its own target; one missing package does not disable unrelated paths; POST cannot skip a required hop. |
| Offline Host and Relay restart | The old Host can register after reconnect and rediscover its next step from running identity. No in-memory browser state is required to recover the route. |
| Final runtime and session | Running identity/revision and update success are checked separately from session restore, native settings and required task behavior. |
| Public delivery | Public latest tag, manifest, checksum and production asset hashes agree with the reviewed build. |

Use isolated HOME/state/provider directories, loopback transports and free ports.
Disable provider auto-start in upgrade-only tests, retain original package bytes,
use per-test and outer deadlines, and clean up only test-owned processes. Never
replace the operator's installed Controller merely to validate a release.
After reviewed implementation changes, run `pnpm compatibility:update` followed by
`pnpm compatibility:check`, along with affected transport and package tests.

Record test environment, artifact revision/checksum, expected and observed versions,
installation identity continuity, status transitions and cleanup. A process-local
release-fetch fixture may provide an unpublished candidate's exact bytes, but that
does not prove public availability. Verify public downloads after publication.
Keep fixture, real native process, production observation and owner reports distinct.

The launcher used in the 0.2.40 rollout restores the previous runtime if the
candidate fails to register within its 60-second window. Registration success does
not certify session behavior; faults after successful registration are outside this
automatic rollback guarantee. Do not describe the upgrade as interruption-free:
private tasks, Controller-hosted tools and in-flight requests may be interrupted.
Inspect uncertain outcomes before retrying; do not automatically replay mutations.

If verification fails, stop the dependent rollout step and retain the last usable
management path. Keep the previous package and state intact. A server rollback must
also support any Controllers already upgraded; reverting only the server can create
another mismatch. Authentication/data migrations require their own verified rollout
and rollback plan under the [security guide](current/agent-remote/security.md).

## Phase 2: remove compatibility only as a separate change

Cleanup is not part of the protocol bump or an automatic consequence of one
successful upgrade. First reconcile the fleet inventory, including offline machines:
each dependent installation must be confirmed upgraded or explicitly retired.
No recent heartbeat does not establish retirement. Retain routes while any supported
installation still needs them or its status is unknown.

Then review removal of each specific decoder, route and intermediate-release lookup
as a separate change, with its own rollout and recovery evidence. Recheck the minimum
supported version and original launcher contracts. Do not delete or rewrite published
release assets as incidental code cleanup. Test the remaining supported fleet and
publish the new support boundary explicitly.

## Recorded rollout: session protocol 1.7.0 / Controller 0.2.40

On 2026-10-09, the operator first confirmed all their machines had been updated to
0.2.39 through the existing service. Controller 0.2.40 was then published, its public
downloads verified, and the compatible Relay/website deployed. After being asked to
update to 0.2.40, the operator reported that it had been updated and started. This is
owner confirmation, not an independent per-machine production session audit.

The release kept management uplink version 2 and these historical routes:

| Installed Controller | Intermediate | Final target in this rollout |
| --- | --- | --- |
| 0.2.0 through 0.2.30 | 0.2.32, session protocol 1.5 | 0.2.40, session protocol 1.7 |
| 0.2.31 | 0.2.33, session protocol 1.6 | 0.2.40, session protocol 1.7 |
| 0.2.32 and 0.2.33 or newer eligible versions | None | 0.2.40 |

The important exception was 0.2.31: its published updater still required protocol
1.6, although later source had removed protocol equality from installation checks.
Inspecting the published package identified the necessary 0.2.33 intermediate.
Treat this table as historical evidence; re-audit supported versions for every bump.

Evidence recorded for this release:

- [Controller 0.2.40 release](https://github.com/xuangong/agent-remote-control/releases/tag/controller-v0.2.40),
  commit `df71fa09e0e5f15db82f8d1f11966823c2ed40e3`, protocol `1.7.0`.
- Tarball SHA-256:
  `bda7c4a781c67dab95b53aaef98f57ca70fa59a7cfbc65584c64845bb291854a`.
- On macOS arm64 / Node 22.23.2, the published 0.2.31 package upgraded to published
  0.2.33 through a local management Relay. The original 0.2.31 launcher and unmodified
  0.2.33 updater then installed the exact 0.2.40 candidate bytes. Installation IDs
  remained stable. Only the unpublished candidate's release fetch was supplied by
  the test process; native providers were disabled.
- Rejecting candidate registration caused the original launcher to restore 0.2.33
  after 60.065 seconds. GET returned the failure state, a new POST was accepted,
  and the retry successfully activated 0.2.40. Test processes were then stopped.
- Mixed-version, missing-intermediate and reconnect coverage used real Worker
  transports. Final checks included Protocol 212, Hosted 202, Cloudflare 67 and
  Controller update tests 136 passed with one platform skip. These counts do not
  establish a native Windows/Linux or production-account test run.
- Production Worker version `ad1763de-504d-48a4-b191-975040ba8287` served 100% of
  traffic after deployment; `/health` returned OK and entry JS/CSS plus the App
  chunk matched the local build. Public latest and tarball checksum were verified.

Compatibility cleanup was deliberately deferred. The reusable result is the staged
sequence and preserved management path, not a guarantee that future protocol,
authentication or launcher changes will be compatible without another audit.
