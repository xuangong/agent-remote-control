# Controller npm releases

The public package is `@orchardworks/agent-remote-controller`; its executable
remains `agent-remote-controller`. It supports macOS, Linux and native Windows.
The source workspace stays private. Always publish the generated tarball, never
the repository root or the internal workspace package.

## GitHub release workflow

`.github/workflows/publish-controller.yml` builds and tests on GitHub-hosted Linux,
macOS and Windows runners. Windows runs the platform-specific suite and the real
installed-package lifecycle tests. The publish job waits for all three platforms and publishes the
exact Linux-built tarball using npm Trusted Publishing (OIDC) with provenance.
No long-lived npm token is needed after initial setup.

The workflow starts only through an explicit `workflow_dispatch`. Publishing a
GitHub Release, pushing commits, and creating tags do not start it. Manual
runs must target a release tag, not a branch. The tag must match the version
in `packages/agent-controller/package.json`, and its commit must be on `main` history.
Prerelease versions are deliberately excluded from this workflow.

A release is cut on `main` after the last merge's `pnpm postmerge` (README,
"Merging into main"), with one command:

```sh
pnpm release:controller 0.3.9 --summary "what changed" [--gate-passed <log>] [--yes] [--dry-run]
```

It runs explicit steps and checks each one's precondition first; `--dry-run` prints every command and
runs none (it still reads git state, and says where a real run would refuse). Progress is kept in
the git directory (`arc-release-<version>.json`), so after a failure the same command skips the
finished steps and continues at the failed one.

| Step | What it does |
| --- | --- |
| a. preconditions | On `main`, clean tree, at `origin/main` (after a fetch). |
| b. bump | Sets the version of `packages/agent-controller/package.json`, runs `pnpm install --lockfile-only`, `pnpm compatibility:update` and `pnpm compatibility:check`, and commits those three files only as `release: Controller <version> (<summary>)`. |
| c. gate | `pnpm gate:release`; `--gate-passed <log>` skips it for a gate you already ran on this commit. |
| d. push | `git push origin main`. Needs `--yes` or an interactive yes. |
| e. deploy | Only when the Relay or the website changed since the last `controller-v*` tag, otherwise it says it is skipped. Records the current Worker version as the rollback target, builds, `wrangler deploy`, then `scripts/deploy-readiness.mjs` (deadline 480 s). Needs `--yes` or yes. |
| f. release | Builds the package, creates the manifest (`scripts/controller-release.mjs`) and `gh release create controller-v<version>` with the four assets at the release commit. Needs `--yes` or yes. |
| g. report | Prints the rollback target and the reminder that the owner updates Controllers from Settings -> Computers. |

Create the tag through the GitHub release (step f), then explicitly dispatch npm publication when requested. A manual retry uses the same tag:

```sh
gh workflow run publish-controller.yml --ref controller-v0.1.0
```

## Scoped release gate

`pnpm gate:release [--base <ref>] [--plan] [--full]` decides what to run from the files changed
since the commit production runs (default: the newest `controller-v*` tag) and
`architecture/modules.json`, prints the plan with the reason for each tier, runs the tiers one at a
time, and stops at the first failure with its log (`.artifacts/gate-release/<time>/<tier>.log`).
`--plan` only prints; `--full` runs every tier.

| Tier | Runs when |
| --- | --- |
| `pnpm verify` | Always. |
| `pnpm test:components`, `pnpm test:preview-browser` | The client (`agent-client`, `agent-client-web`, `agent-remote-lab`, `agent-timeline`), the Relay, the protocol or a root manifest changed. |
| `pnpm test:e2e:flows`, then `E2E_BROWSER=webkit` | The client, Relay, protocol or Controller changed. After a Controller-only change, only the flow files whose id (`E1`, `E14b`, ...) a changed module names in its `flows` in `modules.json`; none when no flow does. A new flow file must be named by a module (a unit test checks it). |
| `pnpm smoke:quick` | The client or Relay changed. The script starts the instance with `ARC_LOCAL_JOURNALS=1` itself and afterwards restores it: stopped if it was stopped, else restarted as a normal run. |

The regenerated compatibility digest alone changes nothing. Run the gate on the release commit
(or on `main` before it) and pass its log to `release:controller --gate-passed`, or let step c run it.

The workflow never overwrites a published npm version. If publication succeeds
but the final registry check fails, inspect npm before retrying; an already
published version will be rejected. Change the package version for new releases.

## First publication

npm requires a package to exist before a trusted publisher can be configured.
If the package already exists and the account has publish permission, skip the
bootstrap publication and configure trust directly.

1. Merge and push this workflow and the package changes to `main`.
2. In npm, create a short-lived granular token with package write permission
   (publish, not stage-only), permission for the `@orchardworks` scope, and
   **Bypass two-factor authentication** enabled.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
   Add a repository secret named **NPM_BOOTSTRAP_TOKEN**. Paste the token there;
   do not put it in chat, source files, command arguments, or logs.
4. Create and push `controller-v0.1.0` at the intended merged commit. Run:

   ```sh
   gh workflow run publish-controller.yml --ref controller-v0.1.0 -f bootstrap=true
   ```

   Alternatively use **Actions → Publish Controller to npm → Run workflow**,
   select that tag, and enable the first-publication checkbox. Publishing a
   GitHub Release does not dispatch npm publication.
5. Once npm confirms the package exists, configure its Trusted Publisher as below.
6. Delete the GitHub bootstrap secret and revoke the temporary token in npm.
   Subsequent releases leave `bootstrap` false and use OIDC only. There is no
   automatic token fallback if OIDC fails.

## npm Trusted Publisher settings

In npm, open **Packages → @orchardworks/agent-remote-controller → Settings →
Trusted publishing**, select **GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `xuangong` |
| Repository | `agent-remote-control` |
| Workflow filename | `publish-controller.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable direct `npm publish` |

The npm owner is `orchardworks`; the GitHub owner is `xuangong`. These fields
identify the GitHub repository, not the npm account. Enter only the workflow
filename, without `.github/workflows/`. New trust configurations default to
staged publication, so explicitly allow direct publication for this workflow.

The workflow grants `id-token: write` only to the publish job and uses npm
11.15.0 with Node 22.23.2. The generated package includes the matching public
GitHub repository URL required for provenance. After the first successful OIDC
release, npm's **Require two-factor authentication and disallow tokens** setting
can prevent future token-based publication while keeping OIDC publication working.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust).
