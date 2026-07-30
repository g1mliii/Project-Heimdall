# Third-party licenses — Heimdall Capture

Heimdall Capture itself is MIT-licensed, like the rest of this repository.

## Intel PresentMon

The installer bundles **Intel PresentMon 2.4.1** (`PresentMon-2.4.1-x64.exe`,
redistributed unmodified as `presentmon.exe`). It is the program that performs
the actual frame-time capture; Heimdall Capture spawns it, reads its CSV output
and does not patch or wrap it.

- Upstream: <https://github.com/GameTechDev/PresentMon>
- Release: <https://github.com/GameTechDev/PresentMon/releases/tag/v2.4.1>
- SHA-256 of the pinned asset:
  `d74183e7ae630f72cd3690be0373ecbfdc6cbb86578148aab8fa2a7166068f34`
  (verified by `scripts/fetch-presentmon.mjs` on every build)

PresentMon is distributed under the MIT License:

```
Copyright (C) 2017-2024 Intel Corporation

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

## Webfonts

Three faces are vendored into the application bundle
(`src/assets/fonts`, fetched by `scripts/fetch-fonts.mjs`). All three are
licensed under the **SIL Open Font License 1.1**:

- **Space Grotesk** — Florian Karsten, <https://fonts.google.com/specimen/Space+Grotesk>
- **Hanken Grotesk** — Hanken Design Co., <https://fonts.google.com/specimen/Hanken+Grotesk>
- **JetBrains Mono** — JetBrains, <https://fonts.google.com/specimen/JetBrains+Mono>

## Rust and JavaScript dependencies

Crate and package licenses are recorded in `Cargo.lock` and `pnpm-lock.yaml`.
Run `cargo tree` / `pnpm licenses list` for the full transitive set.
