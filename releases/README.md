# Release notes

Each release has a `vX.Y.Z.md` file. These files are the source of truth for GitHub release bodies, including backfilled notes for older tags.

Use this small YAML frontmatter schema, in this order, with unquoted values:

```yaml
---
version: 0.2.0
tag: v0.2.0
breaking: true
---
```

`breaking` means users may need to change commands, scripts, or library integrations. Below the frontmatter, describe changes, migration steps, and distribution limitations. The renderer deliberately accepts only these three fields; extend its parser and tests if the schema grows.

## Cut a release

1. Write the next version's notes. For pre-1.0 releases, use a minor bump for breaking CLI/API changes and a patch for compatible fixes.
2. Commit code and notes with a clean working tree.
3. Run `pnpm -w release minor` or `pnpm -w release patch`.
4. The script validates the notes before changing the version, runs checks, commits the version bump, creates an annotated tag, and pushes GitHub and Gitea.
5. If `gh` is available and authenticated, the script finds the Release workflow by commit and watches that exact run. A watch failure does not undo a successful push. Inspect runs before rerunning the release command, which would otherwise bump again.
6. The GitHub workflow checks the tag against the CLI version, renders the matching notes into the release body, and publishes `patdown`, `@patdown/rules`, `@patdown/pi`, `@patdown/claude`, and `@patdown/packs` to npm.
7. The same git tag is what consumers pin for the composite action (`uses: tyler-dot-earth/patdown@vX.Y.Z`). The action defaults to installing that same CLI version from npm, so cut the npm publish before pointing people at a new action tag.

`pnpm -w check` includes release-note validation. The release renderer removes frontmatter:

```sh
node scripts/release-notes.mjs v0.2.0
```

## Backfill or correct published notes

Commit edits to the corresponding markdown file, then update the GitHub body explicitly:

```sh
node scripts/release-notes.mjs v0.1.0 > /tmp/patdown-v0.1.0-notes.md
gh release edit v0.1.0 --repo tyler-dot-earth/patdown --notes-file /tmp/patdown-v0.1.0-notes.md
```

This edits release prose only. It does not move a tag or change historical source archives. Older tags predate this directory; their notes live on the current branch. Do not use `--verify-version` when backfilling an old release from a newer checkout.
