#!/usr/bin/env bash
# scripts/lint-mermaid.sh — docs/current mermaid diagram gate.
#
# WHY THIS EXISTS. A mermaid block that does not parse renders as an error box
# wherever the doc is read, and nobody clicks a diagram to check it. A broken one
# is therefore the same class of defect as a false sentence, except that no
# reader ever reports it: one reached main under an explicit human check, because
# that check was run against a worktree holding an uncommitted fix. Diagrams are
# load-bearing in docs/current now, so the only durable answer is a gate that
# reads the committed tree on every PR.
#
# WHAT IS CHECKED. Every fenced ```mermaid block under docs/current (or under the
# roots given as arguments) is handed to mermaid's own parser, and two ways of
# being broken are reported, each with its file, its 1-based fence line, its
# index within the file and the offending line: a block the parser refuses, and
# a flowchart edge naming a node that no declaration introduces — which parses
# cleanly and renders a stray box. Both are exit 1. Nothing else is in scope:
# this gate says a diagram is well-formed, never that it says something true.
#
# WHAT IS READ, which is the whole point. This gate guards a COMMIT, so a verdict
# that describes only the files on disk is worthless — that is precisely the
# mistake that let the defect through: the check passed against a working tree
# holding a fix that was never in the commit. On CI the distinction is invisible
# because the runner checks out a commit, so the burden falls entirely on the
# local invocation, and it is answered structurally rather than by asking people
# to be careful:
#
#   • `--ref <rev>` reads the committed content of <rev> and nothing else. It is
#     how you ask "is main broken?" without touching your tree.
#   • With no --ref, the working tree is checked — that is what someone editing a
#     diagram needs — AND compared against HEAD. If they have diverged, HEAD is
#     checked too and BOTH verdicts are printed. A green working tree therefore
#     cannot be mistaken for a green commit, because when the two disagree you
#     are shown both and the exit code follows the worse of them.
#
# NOTHING IS WRITTEN. The parser renders nothing, so no SVG or sibling artifact
# can land in the repository; everything this script materializes lives under a
# mktemp directory that the EXIT trap removes. A gate that dirties the tree it
# guards gets worked around.
#
# NO BROWSER IS INVOLVED, and that is a deliberate cost decision. mermaid.parse()
# runs the same grammar the renderer runs and stops before layout, so mermaid +
# jsdom answers the whole corpus in about a second; @mermaid-js/mermaid-cli would
# instead download and drive a chromium — tens of seconds and ~150MB on every PR
# — to gate documentation. The dependencies are installed into a throwaway
# directory at pinned versions rather than added to the workspace, so a gate over
# docs costs the lockfile nothing.
#
# EXIT CODES. 1 means a diagram is broken. 2 means the question could not be
# answered — the dependencies would not install, a root is unreadable, or the
# parser could not resolve its own imports — and nothing may be concluded from
# it. The separation matters here more than usual: without a DOM, mermaid throws
# `DOMPurify.addHook is not a function` for diagrams that are perfectly valid, so
# a toolchain fault that read as a parse failure would send someone rewriting a
# correct diagram.
#
# The script SELF-TESTS before the real check, and only runs the real check if
# every case passes. Each case plants markdown in a throwaway directory and
# drives the SAME parser the real invocation drives.
# Referenced by .github/workflows/ci.yml `pr-gate`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned: mermaid's grammar is what this gate enforces, so an unpinned upgrade
# would silently change the verdict on documents nobody touched.
MERMAID_VERSION=11.16.1
JSDOM_VERSION=26.1.0

REF=""
ROOTS=()
while [ "$#" -gt 0 ]; do
	case "$1" in
	--ref)
		[ "$#" -ge 2 ] || {
			echo "ERROR: --ref needs a revision." >&2
			exit 2
		}
		REF="$2"
		shift 2
		;;
	--ref=*)
		REF="${1#--ref=}"
		shift
		;;
	-*)
		echo "usage: lint-mermaid.sh [--ref <rev>] [<root>...]" >&2
		exit 2
		;;
	*)
		ROOTS+=("$1")
		shift
		;;
	esac
done
[ "${#ROOTS[@]}" -gt 0 ] || ROOTS=(docs/current)

WORK="$(mktemp -d)"
ISOLATED="$(mktemp -d)"
trap 'rm -rf "$WORK" "$ISOLATED"' EXIT

echo "==> provisioning mermaid@$MERMAID_VERSION + jsdom@$JSDOM_VERSION (no browser)"
if ! npm install --prefix "$WORK" --no-save --no-audit --no-fund --loglevel=error \
	"mermaid@$MERMAID_VERSION" "jsdom@$JSDOM_VERSION" >"$WORK/npm.log" 2>&1; then
	echo "ERROR: cannot install the mermaid parser — this gate reached no verdict." >&2
	sed 's/^/  | /' "$WORK/npm.log" >&2
	exit 2
fi

# An ESM import resolves from the importing FILE's directory upward, not from
# the working directory, so the parser has to sit beside the node_modules just
# installed for it to see them.
PARSER="$WORK/mermaid-parse.mjs"
cp scripts/mermaid-parse.mjs "$PARSER"

# scan <dir> <root>... — parse every block under <root>... as seen from <dir>, so
# the paths reported are repository-relative whether the content came from the
# working tree or from an exported commit. The parser's own output IS the report.
scan() {
	local dir="$1"
	shift
	(cd "$dir" && node "$PARSER" "$@")
}

# export_ref <repo> <ref> <dest> <root>... — materialize the COMMITTED content of
# each root at <ref> under <dest>, keeping repository-relative paths. <dest> is
# rebuilt each time so no earlier export can survive into a later verdict.
# Returns 2 for a revision or path this repository cannot produce: a gate that
# cannot see what it guards must not report a pass.
export_ref() {
	local repo="$1" ref="$2" dest="$3"
	shift 3
	if ! git -C "$repo" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
		echo "ERROR: cannot resolve revision '$ref' — this gate reached no verdict." >&2
		return 2
	fi
	rm -rf "$dest"
	mkdir -p "$dest"
	if ! git -C "$repo" archive "$ref" -- "$@" | tar -x -C "$dest"; then
		echo "ERROR: cannot export $* at '$ref' — this gate reached no verdict." >&2
		return 2
	fi
}

# diverged_paths <repo> <ref> <root>... — every scanned path whose working-tree
# content differs from <ref>, tracked or not. This is the question the original
# defect turned on: a check run over a dirty tree answered for the disk and was
# read as an answer for the commit.
diverged_paths() {
	local repo="$1" ref="$2"
	shift 2
	git -C "$repo" diff --name-only "$ref" -- "$@"
	git -C "$repo" ls-files --others --exclude-standard -- "$@"
}

# check_repo <repo> <ref> <root>... — the whole verdict, over any repository. The
# real invocation and every self-test case call this same function, so a case
# exercises the code that gates PRs rather than a copy of it. With <ref> set,
# only that commit's content is read. With <ref> empty the working tree is read,
# and — when it has diverged from HEAD — HEAD is read too and BOTH verdicts are
# printed. Returns 0 clean, 1 broken, 2 no verdict; 2 outranks 1, because a
# question that was never answered must not be reported as one that was.
check_repo() {
	local repo="$1" ref="$2"
	shift 2
	local roots=("$@")
	local dest="$WORK/committed"
	local disk_status=0 committed_status=0 diverged

	if [ -n "$ref" ]; then
		echo "==> mermaid diagram check (${roots[*]} as committed at $ref)"
		export_ref "$repo" "$ref" "$dest" "${roots[@]}" || return $?
		scan "$dest" "${roots[@]}" || return $?
		return 0
	fi

	if ! diverged="$(diverged_paths "$repo" HEAD "${roots[@]}")"; then
		echo "ERROR: cannot compare the working tree against HEAD — this gate reached no verdict." >&2
		return 2
	fi

	echo "==> mermaid diagram check (${roots[*]})"
	if [ -z "$diverged" ]; then
		echo "    the working tree matches HEAD, so this verdict covers the commit"
		scan "$repo" "${roots[@]}" || return $?
		return 0
	fi

	echo "    these scanned paths differ between the working tree and HEAD:"
	printf '%s\n' "$diverged" | sed 's/^/      /'
	echo "    so both are checked — a pass on disk is not a pass for the commit"
	echo "--- working tree ---"
	scan "$repo" "${roots[@]}" || disk_status=$?
	echo "--- HEAD, as committed ---"
	export_ref "$repo" HEAD "$dest" "${roots[@]}" || return $?
	scan "$dest" "${roots[@]}" || committed_status=$?

	if [ "$disk_status" -eq 2 ] || [ "$committed_status" -eq 2 ]; then
		return 2
	fi
	if [ "$disk_status" -eq 0 ] && [ "$committed_status" -ne 0 ]; then
		echo "ERROR: your working tree parses but HEAD does not. The gate guards the commit," >&2
		echo "  so the fix counts only once it is committed." >&2
		return 1
	fi
	[ "$disk_status" -eq 0 ] && [ "$committed_status" -eq 0 ] && return 0
	return 1
}

# plant_fixtures — markdown planted under $WORK/selftest, never under docs/, so
# the deliberately broken fixtures are invisible to the real check.
plant_fixtures() {
	local root="$WORK/selftest"
	mkdir -p "$root/good" "$root/broken" "$root/ignored" "$root/indented"

	cat >"$root/good/ok.md" <<'FIXTURE'
# Valid

```mermaid
flowchart LR
  sdk["@orchardworks/agent-provider-sdk"]
  sdk --> server["server-go"]
```

```mermaid
sequenceDiagram
  participant Plugin
  Plugin->>Server: semantic_action
```
FIXTURE

	# The exact shape that reached main: mermaid 11 lexes the unquoted @ as a
	# link id. The fence sits on line 3 and the offending label on line 5, which
	# is what the line-number assertions below pin down.
	cat >"$root/broken/label.md" <<'FIXTURE'
# Broken

```mermaid
flowchart LR
  sdk[@orchardworks/agent-provider-sdk]
  sdk --> server[server-go]
```
FIXTURE

	# Neither of these is a diagram: one is a shell block that merely contains
	# mermaid source, the other a four-backtick block quoting a mermaid fence.
	cat >"$root/ignored/other.md" <<'FIXTURE'
# Not diagrams

```bash
flowchart LR
  sdk[@orchardworks/agent-provider-sdk]
```

````
```mermaid
flowchart LR
  sdk[@orchardworks/agent-provider-sdk]
```
````
FIXTURE

	cat >"$root/indented/list.md" <<'FIXTURE'
# Indented

- A diagram inside a list item:

  ```mermaid
  flowchart LR
    sdk[@orchardworks/agent-provider-sdk]
  ```
FIXTURE

	mkdir -p "$root/undeclared" "$root/declared"

	# The residue of a deletion: `rt` was declared once, the declaration went,
	# the two edges naming it stayed. This parses.
	cat >"$root/undeclared/orphan.md" <<'FIXTURE'
# Orphan

```mermaid
flowchart TB
  comp["Composition root"]
  ws["Realtime hub"]
  comp --> rt
  rt --> ws
```
FIXTURE

	# Every form of declaration that must NOT be reported: a shape on its own
	# line, a shape declared inline on the right of an edge, a subgraph id used
	# as an endpoint, and a flowchart written entirely in bare ids.
	cat >"$root/declared/forms.md" <<'FIXTURE'
# Declared

```mermaid
flowchart TB
  own["Own line"]
  subgraph grp["Group"]
    inner["Inner"]
  end
  own --> inline["Declared inline"]
  inline --> grp
```

```mermaid
flowchart LR
  A --> B
  B --> C
```
FIXTURE
}

self_test_failed=0
case_count=0

# status_for <word> — the exit code a case expects. An unknown word is a hard
# failure, so a typo in a case cannot quietly assert nothing.
status_for() {
	case "$1" in
	clean) echo 0 ;;
	broken) echo 1 ;;
	unusable) echo 2 ;;
	*)
		echo "internal error: unknown expectation '$1'" >&2
		exit 2
		;;
	esac
}

# judge <label> <clean|broken|unusable> <status> <output> [<must-appear>] [<must-not-appear>]
# The single verdict-checker every case runs through. The last two are
# `|`-separated substring lists: a gate that fails for the wrong file, or that
# names a file it has no quarrel with, is as broken as one that never fails.
judge() {
	local label="$1" expect="$2" status="$3" out="$4"
	local must_appear="${5:-}" must_not_appear="${6:-}"
	local expected token reason=""

	expected="$(status_for "$expect")"
	[ "$status" -eq "$expected" ] || reason="expected status $expected ($expect), got $status"
	while IFS= read -r token; do
		[ -n "$token" ] || continue
		case "$out" in *"$token"*) : ;; *) reason="${reason:-output never says: $token}" ;; esac
	done <<EOF
$(printf '%s' "$must_appear" | tr '|' '\n')
EOF
	while IFS= read -r token; do
		[ -n "$token" ] || continue
		case "$out" in *"$token"*) reason="${reason:-output says: $token, which is not at fault}" ;; esac
	done <<EOF
$(printf '%s' "$must_not_appear" | tr '|' '\n')
EOF

	case_count=$((case_count + 1))
	if [ -n "$reason" ]; then
		echo "  FAIL $label — $reason" >&2
		printf '%s\n' "$out" | sed 's/^/    | /' >&2
		self_test_failed=1
	else
		echo "  PASS $label"
	fi
}

# assert_parse <label> <clean|broken|unusable> <run-dir> <root> [<must-appear>] [<must-not-appear>]
# Drive the parser over one fixture root. <run-dir> holds the parser copy to run,
# which is how the missing-dependency case is expressed.
assert_parse() {
	local label="$1" expect="$2" run_dir="$3" root="$4"
	local out status

	if out="$(node "$run_dir/mermaid-parse.mjs" "$root" 2>&1)"; then status=0; else status=$?; fi
	judge "$label" "$expect" "$status" "$out" "${5:-}" "${6:-}"
}

# assert_check <label> <clean|broken|unusable> <repo> <ref> [<must-appear>] [<must-not-appear>]
# Drive the WHOLE verdict engine over one throwaway repository, always scoped to
# docs/current, which is what its fixtures carry.
assert_check() {
	local label="$1" expect="$2" repo="$3" ref="$4"
	local out status

	if out="$(check_repo "$repo" "$ref" docs/current 2>&1)"; then status=0; else status=$?; fi
	judge "$label" "$expect" "$status" "$out" "${5:-}" "${6:-}"
}

# plant_doc <path> <good|broken> — one markdown file holding one diagram, either
# quoted or carrying the unquoted @ that mermaid 11 lexes as a link id.
plant_doc() {
	local path="$1" kind="$2"
	mkdir -p "$(dirname "$path")"
	case "$kind" in
	good) printf '# D\n\n```mermaid\nflowchart LR\n  sdk["@orchardworks/agent-provider-sdk"]\n```\n' >"$path" ;;
	broken) printf '# D\n\n```mermaid\nflowchart LR\n  sdk[@orchardworks/agent-provider-sdk]\n```\n' >"$path" ;;
	*)
		echo "internal error: unknown fixture kind '$kind'" >&2
		exit 2
		;;
	esac
}

# build_case_repo <dir> <committed> <on-disk> — a throwaway repository carrying
# docs/current/d.md committed in one state and left on disk in another. When the
# two differ the file stays uncommitted, which is the exact shape of the incident
# this gate exists for.
build_case_repo() {
	local dir="$1" committed="$2" on_disk="$3"
	mkdir -p "$dir"
	git -C "$dir" init -q -b main
	git -C "$dir" config user.email lint@invalid
	git -C "$dir" config user.name lint
	# git-hooks/pre-commit refuses commits on main, and a developer who installed
	# it has core.hooksPath set; these fixtures commit on main on purpose.
	git -C "$dir" config core.hooksPath /dev/null
	plant_doc "$dir/docs/current/d.md" "$committed"
	git -C "$dir" add -A
	git -C "$dir" commit -q -m base
	[ "$committed" = "$on_disk" ] || plant_doc "$dir/docs/current/d.md" "$on_disk"
}

# SELF-TEST — runs on every invocation, before the real check. It proves only
# what these cases cover. Over the parser: that a valid corpus passes and is
# counted, that the label shape which reached main is refused at the right lines,
# that a fence which is not a mermaid fence is not a diagram, that an indented
# fence still is one, that a directory root is walked and judged file by file,
# and that "no verdict" never reads as a pass. Over the verdict engine: that a
# fix living only on disk never makes the commit look green.
run_self_test() {
	echo "==> mermaid self-test (fixtures under $WORK/selftest)"
	local root="$WORK/selftest"
	plant_fixtures
	cp scripts/mermaid-parse.mjs "$ISOLATED/mermaid-parse.mjs"

	assert_parse "a valid file parses, and every block is counted" clean "$WORK" \
		"$root/good/ok.md" \
		"OK|2 mermaid block(s) in 1 file(s)"

	assert_parse "an unquoted @ in a label is refused at its own line" broken "$WORK" \
		"$root/broken/label.md" \
		"label.md:3|offending line: $root/broken/label.md:5|Parse error"

	assert_parse "a fence that is not a mermaid fence is not a diagram" clean "$WORK" \
		"$root/ignored" \
		"0 mermaid block(s) in 0 file(s)"

	assert_parse "an indented fence is still a diagram" broken "$WORK" \
		"$root/indented" \
		"list.md"

	assert_parse "a directory root is walked, and only the broken files are named" broken "$WORK" \
		"$root" \
		"label.md|list.md" \
		"ok.md|other.md"

	assert_parse "an unreadable root is refused, not passed" unusable "$WORK" \
		"$root/absent" \
		"cannot read"

	# The one failure mode that must never be mistaken for a broken diagram:
	# with no DOM, mermaid refuses valid flowcharts. Running the parser from a
	# directory with no node_modules of its own proves the refusal is a status 2
	# that names the missing dependency.
	assert_parse "a parser without its dependencies is refused, not passed" unusable "$ISOLATED" \
		"$root/good/ok.md" \
		"not resolvable"

	# The second defect class: these parse, so only inspecting the parse result
	# catches them.
	assert_parse "an edge naming an undeclared node is refused, and its edges are named" broken "$WORK" \
		"$root/undeclared/orphan.md" \
		'no node "rt" is declared|comp --> rt|rt --> ws|offending line:'

	assert_parse "a declaration in any form is not an undeclared node" clean "$WORK" \
		"$root/declared" \
		"2 mermaid block(s) in 1 file(s)"

	# The incident itself: the fix exists on disk, the commit still carries the
	# break. A gate that answers for the disk calls this green.
	build_case_repo "$WORK/repo-fix-on-disk" broken good
	assert_check "a fix living only on disk does not make the commit green" broken \
		"$WORK/repo-fix-on-disk" "" \
		"differ between the working tree and HEAD|--- working tree ---|--- HEAD, as committed ---|the fix counts only once it is committed"

	build_case_repo "$WORK/repo-break-on-disk" good broken
	assert_check "a break living only on disk is still a break" broken \
		"$WORK/repo-break-on-disk" "" \
		"--- working tree ---|d.md"

	build_case_repo "$WORK/repo-clean" good good
	assert_check "a clean tree gives one verdict, and it covers the commit" clean \
		"$WORK/repo-clean" "" \
		"matches HEAD, so this verdict covers the commit" \
		"--- working tree ---"

	build_case_repo "$WORK/repo-ref" broken good
	assert_check "--ref reads the commit, never the disk" broken \
		"$WORK/repo-ref" HEAD \
		"as committed at HEAD|d.md"

	build_case_repo "$WORK/repo-absent-ref" good good
	assert_check "an unresolvable revision is refused, not passed" unusable \
		"$WORK/repo-absent-ref" refs/heads/absent \
		"cannot resolve"

	if [ "$self_test_failed" -ne 0 ]; then
		echo "mermaid self-test FAILED — the gate is mis-wired; aborting before the real check." >&2
		exit 2
	fi
	echo "self-test PASS ($case_count cases)"
}

run_self_test

real_status=0
check_repo . "$REF" "${ROOTS[@]}" || real_status=$?
exit "$real_status"
