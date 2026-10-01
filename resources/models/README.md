# resources/models – Live2D models

Flowy renders a Live2D Cubism model (`*.model3.json` + `.moc3`, textures, motions, …) with
PixiJS and `pixi-live2d-display-lipsyncpatch`. Model files are **not** part of the repository
(`.gitignore` excludes everything in this folder except this README).

## `default/` – the bundled sample model

```
npm run setup:live2d            # interactive: shows both licenses, asks for consent
npm run setup:live2d -- --yes   # non-interactive (or FLOWY_ACCEPT_LIVE2D=1)
npm run setup:live2d -- --model Haru   # Hiyori (default) | Haru | Mao | Natori
```

The script downloads an official sample model from
`Live2D/CubismWebSamples` (tag `5-r.5`, via jsDelivr with raw.githubusercontent.com as fallback)
into `default/`, preserving the relative paths of the manifest (`FileReferences`), and writes
`LICENSE.txt` (Free Material License notice + required credit line) and `SOURCE.txt` (URL, tag,
file list). It also fetches the proprietary Cubism Core runtime into
`src/renderer/public/vendor/live2dcubismcore.min.js`. Re-running skips existing files; `--force`
re-downloads.

`electron-builder` copies `resources/models` to `<install dir>/resources/models`, and the main
process serves `models/default` through the `flowy-model://` protocol when `avatar.modelPath` is
empty (`src/main/paths.ts`, `src/main/windows/modelProtocol.ts`).

### License (short version – the agreements prevail)

The sample models are provided by Live2D Inc. under the
[Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
and the [Sample Data Terms of Use](https://www.live2d.com/eula/live2d-sample-model-terms_en.html):

- free for individuals and small businesses (annual sales below 10 million JPY), commercial use included,
- may be embedded in a derivative work such as Flowy,
- the raw model files must **not** be redistributed on their own (no "model packs"), the design
  must not be altered, copyright notices stay,
- `Natori` is a collaboration character: non-commercial only, no alterations,
- required credit (shown in Flowy's About page and the README):

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized
> in accordance with conditions and terms set by Live2D Inc.

## Your own model

Point `avatar.modelPath` (Settings → Look / Aussehen → "Live2D-Modell") at any `*.model3.json`;
its directory is served instead of `default/`. Cubism 3/4/5 `.moc3` models work; Cubism 2.1
`.model.json` models are not supported (the Cubism 2 runtime is discontinued).

Keep the licensing of third-party models in mind: marketplace models (nizima, Booth, …) come with
their own terms, and game rips are not allowed. See `README.md`, section "Live2D models".
