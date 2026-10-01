# Third-party notices

Flowy itself is MIT-licensed (`package.json`). It builds on the following third-party software and
services. The full license texts of the npm packages are in `node_modules/<package>/LICENSE`
(and are bundled into the installer by electron-builder).

## Live2D Cubism Core (proprietary)

`src/renderer/public/vendor/live2dcubismcore.min.js` – downloaded by `npm run setup:live2d` from
`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`. It is **not** part of this
repository.

> Live2D Cubism Core
> (C) 2019 Live2D Inc. All rights reserved.
> This file is licensed pursuant to the license agreement below.
> This file corresponds to the "Redistributable Code" in the agreement.
> https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html

The file is governed by the **Live2D Proprietary Software License Agreement**
(https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html). In short:

- Cubism Core is "Redistributable Code": it may be copied and distributed as part of a derivative
  work such as Flowy (section 5). It may not be modified, reverse engineered, decompiled, distributed
  on its own, or used with competing middleware (section 6); its license header must stay intact.
- End users of Flowy must accept these protective terms (section 5.2) – this is why
  `npm run setup:live2d` asks for consent before downloading.
- "General Users" and "Small-Scale Enterprises" (most recent annual sales below 10,000,000 JPY) may
  publish derivative works without a separate Live2D Publication License and without fees
  (section 2.2). **Business users above that threshold need a Cubism SDK Release License:**
  https://www.live2d.com/en/download/cubism-sdk/release-license/
- The exemption does not apply to "Expandable Applications" (section 1.5: works that use or
  generate an indefinite number of models by adding files, e.g. avatar or streaming apps). Flowy's
  "custom model path" setting may put it in that category – see README, section "Live2D models".
- Live2D, Cubism and the Live2D logo are trademarks of Live2D Inc.

## Live2D Cubism Framework (Live2D Open Software License)

`pixi-live2d-display-lipsyncpatch` compiles a copy of the Cubism Web Framework into its bundle.
The framework is licensed under the **Live2D Open Software License Agreement**
(https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html): it may be modified
and redistributed as part of derivative works; copyright notices must be kept; publication follows
the same Publication-License regime as above.

## Live2D sample model (Free Material License)

`resources/models/default/` – an official sample model (default: "Hiyori", alternatively Haru,
Mao or Natori) downloaded by `npm run setup:live2d` from
https://github.com/Live2D/CubismWebSamples (tag `5-r.5`, `Samples/Resources/<Model>/`). Not part
of this repository.

> This content uses sample data owned and copyrighted by Live2D Inc.
> The sample data are utilized in accordance with conditions and terms set by Live2D Inc.

Licensed under the **Live2D Free Material License Agreement**
(https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) and the
**Sample Data Terms of Use** (https://www.live2d.com/eula/live2d-sample-model-terms_en.html).
Usable by individuals and small businesses (annual sales below 10,000,000 JPY) for commercial and
non-commercial purposes as part of a derivative work. The raw model files may not be redistributed
on their own, the designs may not be altered (Hiyori: "no design alterations"), copyright notices
must stay. "Natori" (Jin Natori) is a collaboration character: non-commercial use only, no
alterations, no redistribution.

## Fish Audio (voice, cloud) and Fish Speech (voice, local)

- **Fish Audio API** (`https://api.fish.audio`, text-to-speech and speech-to-text) is an online
  service of Fish Audio. Use requires an account and an API key and is subject to Fish Audio's
  Terms of Service and pricing (https://fish.audio/). Voices (`reference_id`) are created by their
  respective authors on fish.audio and are subject to the terms shown on the voice's page
  (https://fish.audio/m/<id>). Flowy only sends the text to be spoken (plus optional emotion cues)
  and, for speech-to-text, the recorded push-to-talk audio.
- **Fish Speech** (local server, optional) – https://github.com/fishaudio/fish-speech. The source
  code is licensed under the Apache License 2.0. The **S1-mini model weights**
  (https://huggingface.co/fishaudio/s1-mini) are licensed **CC BY-NC-SA 4.0 (non-commercial)** and
  are gated (you must accept the terms on Hugging Face). Flowy does not bundle any of it; it only
  talks to a server you run yourself.

## Anthropic Claude

Flowy's "brain" calls the Anthropic Messages API (https://docs.anthropic.com) via
`@anthropic-ai/sdk` with your own API key. Use is subject to Anthropic's Consumer/Commercial Terms
and Usage Policy (https://www.anthropic.com/legal). Screenshots, transcribed speech, the active
window title and tool results are sent to the API only during a turn (see README, "Screen
awareness & privacy"). Claude is a trademark of Anthropic, PBC.

## npm packages

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| electron | 44.x | MIT | Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc. |
| pixi.js | 7.4.3 | MIT | Copyright (c) 2013-2023 Mathew Groves, Chad Engler |
| pixi-live2d-display-lipsyncpatch | 0.5.0-ls-8 | MIT | Copyright (c) 2020 Guan (guansss); lipsync patch by RaSan147 |
| @anthropic-ai/sdk | 0.131.x | MIT | Copyright (c) Anthropic, PBC |
| @msgpack/msgpack | 3.x | ISC | Copyright (c) FUJI Goro |
| zod | 4.x | MIT | Copyright (c) Colin McDonnell |
| @mozilla/readability | 0.6.x | Apache-2.0 | Copyright (c) Mozilla |
| html-to-text | 10.x | MIT | Copyright (c) Malte Legenhausen, KillyMXI |
| linkedom | 0.18.x | ISC | Copyright (c) Andrea Giammarchi |

Development-only tooling (not shipped): electron-vite (MIT), vite (MIT), vitest (MIT),
electron-builder (MIT), TypeScript (Apache-2.0).

### MIT License (electron, pixi.js, pixi-live2d-display-lipsyncpatch, @anthropic-ai/sdk, zod, html-to-text)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License (@msgpack/msgpack, linkedom)

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### Apache License 2.0 (@mozilla/readability)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
in compliance with the License. You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

## Other

- Chromium / Node.js and their dependencies ship inside Electron; their notices are in the Electron
  distribution (`LICENSES.chromium.html`).
- Windows PowerShell is used as a system integration layer (`resources/ps/flowy-host.ps1`); no
  Microsoft code is redistributed.
- DuckDuckGo (default web search, HTML endpoint) and Brave Search API (optional, needs a key) are
  used by the `web_search` tool subject to their respective terms.
