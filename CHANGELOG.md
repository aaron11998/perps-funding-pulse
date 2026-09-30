# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-24 (Initial release)

### Added
- Workers entrypoint with `/health`, `/.well-known/x402.json` (free), and `POST /funding` (paid $0.01 Base USDC via x402).
- Perps funding rates from Hyperliquid, Binance, dYdX.
- x402 middleware with exact scheme, Base USDC.
- Offline unit tests (15 tests in test/pulse.test.ts).
