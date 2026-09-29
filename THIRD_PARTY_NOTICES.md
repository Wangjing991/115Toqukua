# Third-party software notices

This application is distributed under GNU Affero General Public License version 3 only. See LICENSE. Original copyright and license notices of bundled components remain applicable.

## OpenList v4.2.6

- Project: https://github.com/OpenListTeam/OpenList
- Exact version source and build instructions: https://github.com/OpenListTeam/OpenList/tree/v4.2.6
- Source archive: https://github.com/OpenListTeam/OpenList/archive/refs/tags/v4.2.6.tar.gz
- License: GNU Affero General Public License version 3 (AGPL-3.0).
- Original license: vendor/licenses/OpenList-LICENSE.txt.
- Unmodified upstream binary: official openlist-windows-amd64.zip release asset.
- Official archive SHA256: 10d24913f86843e347eefac219c61224628bbd5d3c7443b2ee119c168a8cb3b9.
- Digest source: https://github.com/OpenListTeam/OpenList/releases/expanded_assets/v4.2.6.

The application includes the tagged source archive in resources/source/OpenList-v4.2.6.tar.gz. The project's source distribution also includes that archive. OpenList retains the upstream project and contributor copyright notices. Its Go module dependencies have their respective licenses; consult the included source go.mod/go.sum and build workflow.

The unmodified binary reports WebVersion v4.2.6. Matching OpenList-Frontend source is included as resources/source/OpenList-Frontend-v4.2.6.tar.gz, with its original license at resources/licenses/OpenList-Frontend-LICENSE.txt. Exact upstream source: https://github.com/OpenListTeam/OpenList-Frontend/tree/v4.2.6. Source archives have locally computed SHA256 values recorded in vendor/manifest.json; these are distinguished from the official binary-archive digest and are not represented as upstream-published source checksums.

## Electron 44.4.5

- Project: https://github.com/electron/electron/tree/v44.4.5
- License: MIT; original license included in resources/licenses/Electron-LICENSE.txt.
- Electron includes Chromium, Node.js, V8, FFmpeg and additional components under their respective licenses. Electron's distributed LICENSES.chromium.html remains beside the application executable in the portable extraction, and an additional copy is included in resources/licenses.

## Build tooling

electron-builder 26.17.0 is used only for packaging (MIT): https://github.com/electron-userland/electron-builder/tree/electron-builder%4026.17.0. Its lockfile identifies the other build dependencies. The portable launcher is generated using electron-builder's NSIS tooling and is subject to those components' original licenses.

OpenList Transfer is an independent project. Product names identify supported services and do not imply endorsement.
