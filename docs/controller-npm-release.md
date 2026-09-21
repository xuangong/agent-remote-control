# Controller npm releases

The public package is `@orchardworks/agent-remote-controller`; its executable
remains `agent-remote-controller`. It supports macOS and Linux, not native Windows.
The source workspace stays private. Always publish the generated tarball, never
the repository root or the internal workspace package.

## GitHub release workflow

`.github/workflows/publish-controller.yml` builds and tests on GitHub-hosted Linux
and macOS runners. The publish job waits for both platforms and publishes the
exact Linux-built tarball using npm Trusted Publishing (OIDC) with provenance.
No long-lived npm token is needed after initial setup.

Publishing a non-prerelease GitHub Release with a `controller-vX.Y.Z` tag starts
the workflow. Ordinary pushes and creating a tag alone do not publish. Manual
runs must also target a release tag, not a branch. The tag must match the version
in `packages/agent-host/package.json`, and its commit must be on `main` history.
Prerelease versions are deliberately excluded from this workflow.

Before a release, update that package's version, refresh `pnpm-lock.yaml`, run
`pnpm compatibility:update`, review the changes, and merge them to `main`.
Create a tag at the intended commit, then publish its GitHub Release. A manual
retry uses the same tag:

```sh
gh workflow run publish-controller.yml --ref controller-v0.1.0
```

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
   select that tag, and enable the first-publication checkbox. Do not publish a
   GitHub Release for the same version to trigger a second npm publication.
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
