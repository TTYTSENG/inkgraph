# Third-party notices

InkGraph original code is licensed under GNU AGPL v3 or later. Dependencies and data assets retain their own licenses; installing dependencies preserves their published license/copyright notices in node_modules. They are not relicensed by this repository.

| Component | Version | License / attribution | Source |
| --- | --- | --- | --- |
| citeproc-js (`citeproc`) | 2.4.63 | Copyright © 2009–2019 Frank Bennett. The delivered citeproc_commonjs.js grants a choice of CPAL v1+ or AGPL v3+. InkGraph selects **AGPL v3+** (the package.json license metadata uses an older AGPL identifier; the original source header is retained by the package). | https://github.com/Juris-M/citeproc-js |
| JSZip | 3.10.1 | MIT option; © Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso | https://github.com/Stuk/jszip |
| Mammoth | 1.11.0 | BSD-2-Clause; © Michael Williamson | https://github.com/mwilliamson/mammoth.js |
| PDF.js (`pdfjs-dist`) | 5.4.624 | Apache-2.0; Mozilla Foundation and contributors | https://github.com/mozilla/pdf.js |
| APA CSL style | pinned commit in provenance.json | CC BY-SA 3.0; Brenton M. Wiernik, Andrew Dunning and listed contributors; original `<info>` and `<rights>` retained unmodified | https://github.com/citation-style-language/styles |
| CSL en-US locale | pinned commit in provenance.json | CC BY-SA 3.0; listed authors and contributors; original `<info>` and `<rights>` retained unmodified | https://github.com/citation-style-language/locales |

APA style and locale assets are bundled verbatim in vendor. The Creative Commons Attribution-ShareAlike 3.0 license applies to those assets: https://creativecommons.org/licenses/by-sa/3.0/ . Bundled upstream README files supply further attribution and repository context.

The interface and report footer acknowledge the citation processor. Source screenshots contain only synthetic demonstration content. No user research documents or API credentials are part of the repository.

## Web research dependencies

## Android capture and local recognition

The Android app uses the Android SDK, Kotlin and AndroidX build dependencies under their upstream terms. No SDK or JDK distribution is committed. Local recognition models are downloaded separately, not bundled with source or APK. Keep the downloaded packages' license files and model cards when redistributing an environment; package licenses do not alone establish model-weight licenses.

| Component | Version | License recorded in installed metadata | Source |
| --- | --- | --- | --- |
| archiver | 8.0.0 | MIT | https://github.com/archiverjs/node-archiver |
| yauzl | 3.4.0 | MIT | https://github.com/thejoshwolfe/yauzl |
| RapidOCR | 3.10.0 | Apache-2.0 | https://github.com/RapidAI/RapidOCR |
| faster-whisper | 1.2.1 | MIT | https://github.com/SYSTRAN/faster-whisper |
| ONNX Runtime | 1.31.0 | MIT | https://github.com/microsoft/onnxruntime |
| CTranslate2 | 4.8.3 | MIT | https://github.com/OpenNMT/CTranslate2 |
| PyAV | 19.0.2 | BSD-3-Clause; linked FFmpeg components retain separate notices | https://github.com/PyAV-Org/PyAV |
| NumPy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | https://github.com/numpy/numpy |
| Pillow | 13.0.0 | MIT-CMU | https://github.com/python-pillow/Pillow |
| huggingface-hub | 2.3.0 | Apache-2.0 | https://github.com/huggingface/huggingface_hub |
| OpenCV headless | 5.0.0.93 | Apache 2.0; bundled notices retained | https://github.com/opencv/opencv-python |
| psutil | 7.2.2 | BSD-3-Clause | https://github.com/giampaolo/psutil |

Tokenizers and OmegaConf are pinned in workers/requirements.txt; their installed metadata did not declare a license expression in the inspected environment. Consult their shipped license notices before redistribution. Model hashes and package versions are recorded locally in model-manifest.json during preparation; do not interpret these hashes as a license grant.

### Web research packages

Direct dependencies added for web research retain upstream notices in node_modules:

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Mozilla Readability | 0.6.0 | Apache-2.0 | https://github.com/mozilla/readability |
| jsdom | 30.1.2 | MIT | https://github.com/jsdom/jsdom |
| Turndown | 7.2.4 | MIT | https://github.com/mixmark-io/turndown |
| turndown-plugin-gfm | 1.0.2 | MIT | https://github.com/mixmark-io/turndown-plugin-gfm |
| Playwright Core | 1.64.1 | Apache-2.0; bundled third-party notices retained | https://github.com/microsoft/playwright |
| https-proxy-agent | 9.1.0 | MIT | https://github.com/TooTallNate/proxy-agents |

