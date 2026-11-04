# Contributing to GB.js

Contributions are welcome through GitHub issues and pull requests. Keep changes focused, include tests for observable behavior, and avoid committing copyrighted game ROMs or firmware.

## Development setup

GB.js requires Node.js 20 or newer.

```bash
npm ci
npm test
```

`npm test` builds the package, type-checks the source, runs ESLint, and executes the unit suite. Add or update unit tests for every behavior change.

## Conformance data

External hardware-test ROMs and locally dumped firmware are not stored in Git or published to npm. Prepare the public conformance suites with:

```bash
npm run data:fetch
npm run data:build
npm run data:verify
npm run test:conformance
```

The build step requires `make` and `unzip`. Building the mGBA suite additionally requires devkitARM or Docker. The scripts pin upstream revisions and verify downloaded files and generated inventories. Keep everything below `test-data/`; do not move generated ROMs into tracked directories.

Original Nintendo firmware is optional. Contributors may import their own hardware dumps for local testing with `npm run data:bios -- <model> <path>`. Never attach firmware or commercial ROMs to issues or pull requests.

## Pull requests

- Explain the hardware behavior or public API being changed.
- Keep unrelated formatting and refactoring out of the change.
- Add focused tests and run `npm test`.
- Run the conformance suite when changing CPU, bus, timing, PPU, APU, DMA, cartridge, or firmware behavior.
- Update the README and architecture document when public APIs or implementation boundaries change.

Maintainers run `npm run release:check` before publishing. It requires prepared conformance data and verifies the npm package contents with a dry run.