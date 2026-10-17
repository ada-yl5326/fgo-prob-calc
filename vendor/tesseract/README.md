# Tesseract.js（文字识别，「从 Laplace 截图导入」用）

只在点「从截图导入」时才下载；Service Worker 把它们存进单独的缓存（不随网页版本更新重新下载）。

| 文件 | 来源 |
|---|---|
| tesseract.min.js、worker.min.js | npm `tesseract.js@5.1.1` 的 dist/（删掉了 sourceMappingURL 一行） |
| tesseract-core-simd-lstm.wasm.js、tesseract-core-lstm.wasm.js | npm `tesseract.js-core@5.1.1`（浏览器支持 SIMD 时用前者） |
| eng.traineddata.gz | npm `@tesseract.js-data/eng@1.0.0` 的 4.0.0_best_int/ |

许可证：Apache License 2.0（见 LICENSE-* 文件）。升级版本时同时改 sw.js 里的 OCR_CACHE 名称。
