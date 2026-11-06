# Reading the instance through its API

```bash
pnpm --silent local api v1/remote/hosts
pnpm --silent local api <v1/path> [--method M] [--data JSON]
```

The command signs in once as the local user, calls the instance's user API
(`/u/<user>/<path>`) and signs out again. It needs a running instance. Behaviour:

- The path must start with `v1/` (`API paths start with v1/, for example v1/remote/hosts.`).
- The method is `GET`, or `POST` when `--data` is given without `--method`.
  `--data` must be JSON (`--data must be JSON: …`), and a `GET` or `HEAD` request
  cannot carry it.
- It prints the response body. A status of 400 or more also prints `HTTP <status>`
  to stderr and exits 1.
- Use `--silent` when a script parses the output: without it pnpm prints a banner
  first. Print only the fields you need.

Use it to read state the website reads: Hosts and their providers
(`hosts[].id`, `name`, `online`, `providers[].providerId`) and other `v1/`
resources. Find a resource's path in the page's network requests or in
`packages/agent-remote-hosted/src/`.

Writes (`--method POST --data '{...}'`) are acceptable only to prepare fixtures
for a check that then uses the page — for example creating several items before
testing how the page lists them. An API write never counts as verifying the page
control that performs the same action. Create and change only resources your
test created.

Each call is a sign-in against the 30-per-minute limit: read what you need in as
few calls as possible and never poll.
