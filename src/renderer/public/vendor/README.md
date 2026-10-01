# Vendor runtime files

`npm run setup:live2d` downloads the proprietary **Live2D Cubism Core** runtime
(`live2dcubismcore.min.js`) into this folder after you accept Live2D's license. It is not committed.

If the file is missing, the overlay tries the official CDN at runtime
(`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`) and otherwise falls back
to the built-in procedural character.
