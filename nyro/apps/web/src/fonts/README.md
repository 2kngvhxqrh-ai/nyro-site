# IBM Plex, vendored

These `.woff2` files and `plex.css` replace a `<link>` to
`fonts.googleapis.com`. Two reasons, both structural rather than cosmetic:

- **Privacy.** NYRO's whole claim is that your conversations stay on your
  machine. A page that tells a third party about every load undercuts that
  before you have typed anything.
- **Offline.** `local_only` mode is the mode this project exists for. On a
  machine with no internet the CDN face never arrived and the UI silently fell
  back to the system monospace.

`font-display: swap` and the fallback stacks in `../index.css` still apply, so
a face that fails to load is never a blank screen.

## What is here

Latin and Latin Extended only. Google also serves Cyrillic, Greek and
Vietnamese subsets; including them roughly triples the bytes for coverage the
UI's own chrome does not use. Model output in those scripts still renders —
`unicode-range` simply lets the browser use its own font for those codepoints.

Weights: Mono 400 and 600, Sans 400–500. Mono 500 is absent because nothing in
`apps/web` uses `font-medium`; if something starts to, add the face back rather
than letting the browser snap it to a neighbour.

IBM Plex Sans ships as **one** file per subset covering weights 400–500:
Google served byte-identical downloads for both weights, because it is a
variable font. `plex.css` declares the range rather than storing the file
twice.

## Regenerating

```bash
curl -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap"
```

The user agent matters: without a modern one Google returns `.ttf` sources
instead of `.woff2`. Keep the `latin` and `latin-ext` blocks, download each
`src` URL, check for duplicate files with `md5sum` before adding a face, and
point the `src` at the local filename.

IBM Plex is licensed under the SIL Open Font License 1.1, which permits
redistribution with the software. See `LICENSE-OFL.txt`.
