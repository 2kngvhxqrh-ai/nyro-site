# nyro-site

The public page for Nyro, a local-first personal AI operating system.

This repository holds the page only — `index.html`, served by GitHub Pages.
The system itself lives in a separate private repository.

## What Nyro is

Four small parts: a markdown vault it remembers in, a skill layer that decides
what fires, a terminal instrument panel, and a push-to-talk voice loop where
speech-to-text and text-to-speech both run locally.

The constraint that shapes it: you have to be able to read everything the system
knows in a text editor, with nothing running.

## `nyro/` — Phase 1 foundation (work in progress)

This repository was created to hold the public page only. The `nyro/`
directory is a self-contained Phase 1 implementation of the NYRO system —
API, core, model router, provider adapters, database and web UI — added here
because the private system repository was not available at the time.

It does not affect the page: GitHub Pages still serves `index.html` from the
repository root.

If the system belongs in its own repository, `nyro/` moves there as a unit
with no changes. See [`nyro/README.md`](nyro/README.md).
