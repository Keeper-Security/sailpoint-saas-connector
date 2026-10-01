# Changelog

## [1.0.1]

### Security
- Extended the service-account protection guard from `std:account:delete` to `std:account:disable` and `std:account:update`.

### Added
- `syncCacheTtlSeconds` config option to control enterprise/vault sync freshness (default: 30s).

### Changed
- Cached `syncEnterprise()` / `syncVault()` with TTL + single-flight coalescing to avoid redundant full re-syncs; cache is invalidated on any mutating call.

### Documentation
- Added setup instructions and SailPoint CLI upload instructions to the README.

## [1.0.0]

Initial release.
