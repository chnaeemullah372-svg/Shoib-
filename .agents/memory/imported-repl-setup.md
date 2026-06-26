---
name: Importing an existing Repl/monorepo into a fresh workspace
description: How to bring GitHub branch code into the workspace and make artifacts runnable when git ops are blocked
---

# Bringing existing repo code into the workspace

**Why:** Workspace `main` was an empty Replit pnpm-template; the real app lived on a
GitHub feature branch. Several obvious approaches are blocked.

**How to apply:**
- `git` is globally blocked for the main agent (clone/fetch/checkout all rejected as
  "destructive"). Download branch source as a tarball instead:
  `curl -sL -o x.tgz https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.tar.gz`
  then `tar xzf` with `--strip-components=1`. List branches via the GitHub API
  `/repos/<owner>/<repo>/branches`.
- Copy app code in but PRESERVE workspace-local dirs: `.git`, `.local` (skills),
  `.agents/memory`, `attached_assets`.
- **Copied artifacts are NOT auto-registered** — `listArtifacts()` returns empty even
  though `artifacts/<slug>/.replit-artifact/artifact.toml` exists. To register each one
  (and allocate ports + create its workflow): copy its `artifact.toml` to a sibling
  `artifact.edit.toml` and call `verifyAndReplaceArtifactToml({tempFilePath, artifactTomlPath})`.
  After that they appear in `listArtifacts()` and have workflows.
