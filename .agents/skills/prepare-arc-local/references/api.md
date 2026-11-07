# Reading the instance through its API

```bash
agent-remote-controller-dev api GET /v1/remote/hosts
agent-remote-controller-dev api POST /v1/<path> --body '{…}'
```

The Controller command line sends the request with its own sign-in (see
[command line](cli.md#sign-in)), so it may be repeated. Prefer it. When
`status` shows `command line: signed out`, use the fallback:

```bash
pnpm --silent local api v1/remote/hosts
pnpm --silent local api <v1/path> [--method M] [--data JSON]
```

That command signs in once as the local user, calls the instance's user API and
signs out again. It needs a running instance. The guide's
[Inspecting the instance](../../../../docs/local-development.md#inspecting-the-instance)
describes the path rule, `--method`, `--data` and the `HTTP <status>` error exit.
What matters when you use it:

- Use `--silent` when a script parses the output: without it pnpm prints a banner
  first. Print only the fields you need.
- Each `pnpm local api` call is a sign-in. Read what you need in as few calls as
  possible and never poll it (see the
  [sign-in budget](../SKILL.md#machine-use-and-the-sign-in-budget)).

Use it to read state the website reads: Hosts and their providers
(`hosts[].id`, `name`, `online`, `providers[].providerId`) and other `v1/`
resources. Find a resource's path in the page's network requests or in
`packages/agent-remote-hosted/src/`.

Writes are acceptable only to prepare fixtures for a check that then uses the
page — for example creating several items before testing how the page lists
them. An API write never counts as verifying the page control that performs the
same action. Create and change only resources your test created.
