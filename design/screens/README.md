# Screen mockups

Static screens for the Team Memory app redesign, drawn before the logic is
built. `build.py` writes one board per screen and the `canvas.json` of a
claude.ai Design artifact, where the user comments on the boards.

- Canvas: https://claude.ai/artifact/7YtjiA6px4DjKLGQDUeENZ (opens for its owner only).
- One flow per row, from its first screen to its last. A screen that several
  flows pass through is drawn again in each row.
- Board titles read `<row> · <n>/<count> <code> <name>`, for example
  `3-2 · 3/7 W3 프로젝트 · 서버마다 고르기 · 적용`. The first board, 경우의
  수 지도, lists the rules of this version and what each screen code means.
- The screens use example data only: `example.com` addresses and the
  teammates alice, bob, carol, dave and erin.

## Build

```sh
python3 design/screens/build.py
```

It writes `design/screens/out/project/`, which git ignores:
`<row>_<n>_<code>.dc.html` for each board, `CaseMap.dc.html` and
`canvas.json`. Each board is plain HTML and opens in a browser.

## Check

```sh
node design/screens/check.mjs [shot-dir]
```

It opens every board in headless Chrome at its canvas size and lists text that
spills out of its box or off the board. Given a directory, it also saves a PNG
of each board there. It needs Node 22 or later. Set `CHROME` when Chrome is
not at `/Applications/Google Chrome.app`.

## Publish to the canvas

The canvas editor writes its own keys into `canvas.json` (pages, the design
system), and the user may change boards there. `build.py` replaces only
`boards`, `notes` and `order`, and keeps every other key of the
`canvas.json` already in `out/project/`.

1. Read `project/canvas.json` from the artifact, save it as
   `out/project/canvas.json`, then run `build.py`.
2. Publish with the Artifact tool:
   - `url`: the canvas
   - `root`: `design/screens/out`
   - `file_path`: `design/screens/out/project/canvas.json`
   - `files`: each `project/<board>.dc.html` mapped to itself, and each
     board that no longer exists mapped to `null`
3. If the publish is refused because a board changed on the canvas, read that
   board and carry its change into `build.py` before publishing again.
