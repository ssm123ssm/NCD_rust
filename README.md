# NCD Rust

Desktop application for exploring non-communicable disease admission trends from bundled CSV datasets. The UI is built with React and Recharts, and the data layer is implemented in Rust with Tauri.

## What It Does

- Loads bundled CSV data from [`src-tauri/resources`](src-tauri/resources).
- Lets you explore admissions by disease group and sex.
- Supports three metrics:
  - admissions
  - crude rates
  - standardized rates
- Includes cause-specific drilldowns for cardiovascular disease and cancer.

The frontend calls Rust commands in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs), where CSV parsing, aggregation, and rate calculations are handled.

## Stack

- Tauri 2
- Rust
- React
- Vite
- Recharts

## Project Structure

- [`src`](src): React frontend
- [`src/App.jsx`](src/App.jsx): main application UI and chart logic
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): Tauri commands and CSV/query logic
- [`src-tauri/resources/data_dx`](src-tauri/resources/data_dx): disease admission CSV files
- [`src-tauri/resources/data_pop`](src-tauri/resources/data_pop): population CSV files
- [`.github/workflows/build.yml`](.github/workflows/build.yml): CI workflow for macOS and Windows builds
- [`.github/workflows/release.yml`](.github/workflows/release.yml): tag-triggered GitHub Releases workflow

## Prerequisites

- Node.js 20 or newer
- npm
- Rust stable toolchain
- Tauri system dependencies for your platform

Tauri dependency setup:
- https://v2.tauri.app/start/prerequisites/

## Local Development

Install dependencies:

```bash
npm ci
```

Run the desktop app in development mode:

```bash
npm run tauri dev
```

If you only want to build the frontend:

```bash
npm run build
```

## Production Build

Build the desktop application locally:

```bash
npm run tauri build
```

Tauri will emit platform-specific bundles under [`src-tauri/target/release/bundle`](src-tauri/target/release/bundle).

## Data Files

The application bundles CSV files through Tauri config in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json). Current resource directories:

- [`src-tauri/resources/data_dx`](src-tauri/resources/data_dx)
- [`src-tauri/resources/data_pop`](src-tauri/resources/data_pop)

These CSVs are intentionally kept under version control.

## GitHub Actions

This repository includes a workflow that builds the app on:

- `macos-latest`
- `macos-26-intel`
- `windows-latest`

The workflow runs on manual dispatch only. Build artifacts are uploaded from GitHub Actions for both platforms.

This repository also includes a release workflow that runs on tags matching `v*` and publishes GitHub Releases with attached build assets.

Example release flow:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Notes

- Current CI builds are unsigned.
- To ship production-ready macOS and Windows distributions, add platform signing and notarization to the workflow.
