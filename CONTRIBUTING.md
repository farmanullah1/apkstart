# Contributing

Issues and pull requests are welcome. This project's principle is **a zero-dependency shell with predictable
behaviour**, so please read the conventions below first.

## Development environment

See `docs/DEV-ENV.md`.

## Self-check before committing

```
npm test          # pure Node unit tests + engine pipeline tests (no network, no VM needed)
```

For UI changes, also run a smoke screenshot pass to confirm the layout has not collapsed:

```
npm run shots
```

## Code conventions

- **The shell takes no third-party runtime dependencies.** ZIP / AXML / ARSC / PNG / ICO parsing under
  `src/core/` is all hand-written; prefer "can this be done with Node built-ins?" over pulling in a big
  package for a small feature.
- The renderer is plain HTML/CSS/JS with no front-end framework.
- All Android interaction goes through `src/core/adb.js`; never assemble adb commands ad hoc elsewhere.
- The main and renderer processes only talk over the allowlisted channels exposed by `preload.js`, with
  `contextIsolation` kept on.
- Comments and UI copy are in English; identifiers are in English too.

## Testing conventions

- When no real APK is available the tests skip the APK parsing part automatically; to cover it, point an
  environment variable at any APK:

  ```
  APKSTART_TEST_APK=C:\path\to\app.apk npm test
  ```

- Tests must not reach the internet. Anything that needs network behaviour should start a local `http`
  server (see `test/engine-test.js`).

## Commit messages

Use Conventional Commits, for example:

```
feat(engine): support importing a qcow2 disk from a custom path
fix(axml): correct the attribute table base offset
docs: add notes on enabling WHPX
```

## Legal and boundaries

- This project does not distribute any Android system image, QEMU binary or Google component; users
  download them on demand on their own machine.
- Never commit commercial APKs, cracking tools or anything that infringes third-party copyright.
