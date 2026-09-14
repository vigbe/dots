# dots — ASCII Studio

`vicbas.com/dots` — a Spanish-language, client-side image → animated ASCII art converter. No build step, no backend: everything runs in the browser.

## Structure

```
index.html              Entry point: SEO meta + JSON-LD, fonts, semantic layout (Spanish UI)
assets/
  style.css             Design system ("terminal refinado": dark, mono-first, hairline borders)
  app.js                All logic. Classic script (no type="module"), loaded with defer,
                        works from file:// as well
  og.png                Generated social card (1200×630) referenced by og:image / twitter:image
  vendor/gif.js         Self-hosted gif.js 0.2.0 (UMD build, defines global GIF)
  vendor/gif.worker.js  gif.js web worker, referenced only via the local relative path
robots.txt              Crawl rules; explicitly welcomes AI crawlers. Canonical copy — must
                        also live at the domain root (see "SEO & AI discoverability")
sitemap.xml             Single-URL sitemap for https://vicbas.com/dots
llms.txt                Markdown overview for generative/LLM engines (Spanish)
```

There is no bundler or package script for the page itself. Edit files and refresh.

## Features

- **Input**: drag & drop, file picker, or paste from clipboard (Ctrl/Cmd+V). Images never leave the browser.
- **Live camera**: project the device camera through the same ASCII engine in real time (see [Live camera](#live-camera)).
- **Conversion**: six character densities, resolution / contrast / brightness controls, inversion, char aspect correction (1.65).
- **Effects** (live preview at 18 fps and exported in the animated GIF): matrix, ondas (wave), glitch, respirar (breathe), escaneo (scan), lluvia (rain), neon, cyber, plasma, vibrar (vibrate), pixelate.
- **Colors**: monochrome, 9 solid colors, 6 gradients (gradients take precedence over solid colors).

## Live camera

The **Cámara** control group (plus the button in the drop zone) turns the device camera into a live ASCII projection. The feed is sampled into the same sampling canvas and pushed through the exact same `pixelsToAscii` + `computeFrame` pipeline as a loaded image, so **every control keeps working live** — resolution, contrast, brightness, inversion, color, gradient, effect and speed. The live preview is capped at 110 columns and throttled to ~16 fps for performance, regardless of the resolution slider; **Capturar** grabs the current frame at the camera's native `videoWidth`/`videoHeight` and feeds it through the same code path as a file upload, so every export (TXT copy/download, SVG, ANSI, animated GIF, HTML embed) works on it at full resolution. The camera keeps running after a capture, so you can grab several frames in a row; **Detener** releases every track immediately and restores the previously loaded image (or the last captured frame) to the editor.

- **HTTPS / secure context required.** `getUserMedia` only exists in secure contexts. On plain HTTP the camera controls are disabled and the status bar notes it (`cámara no disponible (se requiere HTTPS)`). The production site is served over HTTPS at `vicbas.com/dots`, so this only affects insecure local previews.
- **Privacy: the camera never leaves your device.** Frames are sampled into an in-page `<canvas>` and converted to text locally. There is no backend at all — nothing is uploaded, stored or transmitted anywhere. While the camera is open the status bar shows a red `● CÁMARA ACTIVA` indicator as a persistent privacy affordance; hiding the tab pauses sampling (the stream you explicitly started stays open), and closing/navigating away from the page releases it.
- The front camera defaults to mirror mode (**Espejo**), like a selfie preview; rear cameras un-mirror automatically, and the toggle is always one click away. With more than one video input, a device selector appears.

## Export formats

| Format | File | Notes |
|---|---|---|
| TXT copy | clipboard | `navigator.clipboard` with a `textarea` + `execCommand` fallback for `file://` |
| TXT download | `dots-ascii.txt` | plain UTF-8 text |
| SVG | `dots-ascii.svg` | self-contained `<svg xmlns=…>` sized from cols/rows with monospace metrics (0.6em advance, 1.15em line height); one `<text>` per row — single fill for mono/solid, per-row interpolated fill for gradients; dark `<rect>` background; renders standalone and inside `<img>` (e.g. GitHub READMEs) |
| ANSI | `dots-ascii.ans` + "Copiar ANSI" | 24-bit truecolor `\x1b[38;2;R;G;Bm` per character; consecutive same-color runs are grouped; reset `\x1b[0m` at end of each line; solid = one escape per line, monochrome = no escapes. Paste it into any truecolor terminal |
| Animated GIF | `dots-ascii.gif` | 10 fps, 2 s, rendered with the **local** vendored gif.js worker (`assets/vendor/gif.worker.js`). The export button always resets in a `finally` block; errors surface in the status bar |
| HTML embed | modal | static or self-animating snippet (the selected effect) ready to paste into any page |

## Vendored gif.js

gif.js 0.2.0 is vendored under `assets/vendor/` (downloaded once from unpkg at build time, not at runtime). The app references only the local relative path — there are **zero runtime CDN dependencies**; the only external resource is Google Fonts (JetBrains Mono + Inter).

## Accessibility notes

- Icon-only controls carry `aria-label`s; the status bar is `aria-live="polite"`.
- `:focus-visible` outlines everywhere; the drop zone is keyboard-operable (Enter/Space).
- Decorative motion (blinking cursor, ambient grid, transitions) is disabled under `prefers-reduced-motion`. The ASCII preview animation itself is the tool's core content and stays on while an effect is selected — choose "Sin efecto" for a static render.

## SEO & AI discoverability

v2.1 adds a discoverability layer aimed at both classic search (Google) and generative engines (ChatGPT, Perplexity, Gemini, AI Overviews). Those engines quote **visible text** and cannot run the tool's JavaScript, so the layer has two parts:

- **Meta layer** (`index.html`): keyword-strong Spanish title and description, `robots` meta with `max-snippet:-1, max-image-preview:large`, `theme-color`, canonical `https://vicbas.com/dots` (every URL reference — og:url, JSON-LD, sitemap — matches it exactly, no trailing slash), polished OG/Twitter cards, and a generated `assets/og.png` social card (1200×630, PIL/Menlo).
- **Visible semantic content** (`index.html`): a compact "¿Qué es dots?" card plus a native `<details>` FAQ, placed after the tool and **outside** the hidden `#workspace` so it is statically crawlable. The FAQ answers describe current, true functionality only.
- **JSON-LD** (`index.html`): one `@graph` script with three entities — an enriched `WebApplication` (Spanish, free, local processing, full feature list), an `Organization` (`Vicbasertec`), and a `FAQPage` whose Question/Answer pairs mirror the visible FAQ text verbatim, per Google's guideline that schema must match on-page content. **No fake signals**: no `aggregateRating`, no reviews, no invented usage counts — those are spam penalties.
- **Crawl files**: `sitemap.xml` (single URL in canonical form), `robots.txt` (welcomes common AI crawlers explicitly: GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Amazonbot, Applebot-Extended, meta-externalagent) and `llms.txt` (Spanish, llmstxt.org format).

### One-time manual step: domain-root copies

The FTPS deploy only ever writes inside `/dots/` and never touches the domain root. `robots.txt` and `llms.txt` are **only honored at the domain root** (`https://vicbas.com/robots.txt`, `https://vicbas.com/llms.txt`), so the repo copies here are the canonical sources: copy them once (and after every edit) to the domain root via **cPanel → File Manager**. `sitemap.xml` works fine served from `/dots/`, but it is also valid if copied to the root — its single `<loc>` is the absolute URL `https://vicbas.com/dots`, and the `Sitemap:` line in robots.txt points at the root copy.

Also recommended: submit `https://vicbas.com/dots` in **Google Search Console** (URL inspection → request indexing) so the meta layer and FAQ rich result are picked up quickly.

## Deploy

The site is deployed by uploading **every non-excluded file** in this directory over FTPS to cPanel (pre-push, see `../DEPLOY.md`). There is no build artifact: what is in the working tree is what goes live. Do not commit or upload local state (`.atl/`, `node_modules/`, etc. — see `.gitignore`).

## Local preview

Open `index.html` directly in a browser (`file://`), or serve the directory statically. Note that from `file://` the GIF export is limited by browsers blocking web workers on the `file:` origin — every other feature works; the error is reported in the status bar if it happens.
