# Keeper SaaS Connector

SailPoint SaaS connector for **Keeper Security** enterprise user governance. The connector talks to Keeper through **Keeper Commander Service Mode**.

## How it works

1. ISC (or local `spcx`) supplies Service Mode credentials in source config.
2. `KeeperClient` submits Commander commands via `POST /api/v2/executecommand-async`.
3. The client polls `GET /api/v2/result/{request_id}` until the command completes (or times out).

Default poll timeout is **60 seconds** (configurable via `pollTimeoutSeconds`).

## Capabilities

| Area | Commands |
|------|----------|
| Connection | `std:test-connection` |
| Accounts | `std:account:list`, `std:account:read`, `std:account:create`, `std:account:disable`, `std:account:enable`, `std:account:update` |
| Entitlements | `std:entitlement:list`, `std:entitlement:read` |

> **Current implementation:** `std:test-connection` is wired (runs Commander `this-device`). Remaining commands are declared in `connector-spec.json` for the planned account/entitlement surface.

### Source configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `serviceModeApiUrl` | text | yes | Commander Service Mode base URL (**without** `/api/v2/`) |
| `serviceModeApiKey` | secret | yes | Service Mode API key (`api-key` header) |
| `pollTimeoutSeconds` | text | no | Async result poll timeout in seconds (default: `60`) |

---

## Prerequisites

| Tool | Notes |
|------|--------|
| **Node.js 18.12+** | Required by SailPoint Connector SDK |
| **SailPoint CLI** | `sailpoint-cli` via Homebrew (`sail` command) |
| **SailPoint tenant** | ISC demo/prod tenant with PAT configured |
| **Keeper Commander Service Mode** | Running Service Mode endpoint with a valid API key |
| **npm** | For build and packaging |

### SailPoint CLI setup

```bash
sail env list
sail env use keeper-security
sail conn list
```

PAT must include connector upload scopes (e.g. `sp:scopes:all` for demo tenants).

---

## Project structure

```
keeper-security/
├── src/
│   ├── index.ts                    # SailPoint connector entry
│   ├── client/
│   │   └── keeper-client.ts        # Commander Service Mode HTTP client
│   ├── handlers/
│   │   └── test-connection.ts      # std:test-connection
│   ├── model/
│   │   ├── config.ts               # SourceConfig
│   │   └── service-mode-api.ts     # Service Mode request/response types
│   └── utils/
│       ├── api-error.ts
│       └── errors.ts
├── tests/
├── connector-spec.json             # Commands + source config UI
├── package.json
├── tsconfig.json
└── dist/                           # Built output (gitignored)
```

**Not in repo / not in zip:** secrets, `config.json` (optional local-only file for CLI validate).

---

## Local development

```bash
cd keeper-security
npm install
npm run build
npm run dev
```

Dev server: `http://localhost:3000`.

### Example requests

**Test connection**

```json
{
  "type": "std:test-connection",
  "input": {},
  "config": {
    "serviceModeApiUrl": "https://your-commander-host.example.com",
    "serviceModeApiKey": "<service-mode-api-key>",
    "pollTimeoutSeconds": "60"
  }
}
```

### Optional: CLI validate

```bash
sail conn validate -p config.json -c keeper-security -r
```

Example `config.json` (local only — do not commit):

```json
{
  "serviceModeApiUrl": "https://your-commander-host.example.com",
  "serviceModeApiKey": "<service-mode-api-key>",
  "pollTimeoutSeconds": "60"
}
```

---

## Build and package for upload

```bash
npm run build
npm run pack-zip
```

Output: packaged zip under `dist/` (contains `index.js` + `connector-spec.json` only).

```bash
sail env use keeper-poc
sail conn create keeper-security   # first time only
sail conn upload -c keeper-security -f dist/keeper-security-0.1.0.zip
sail conn list
```

Re-upload after code changes: bump `package.json` version, rebuild, upload.

---

## Create source in ISC

1. Admin → Connections → Sources → Create New Source → **keeper-security**
2. Enter:
   - **Keeper Commander Service Mode API URL**
   - **Keeper Commander Service Mode API Key**
   - Optional **Poll Timeout (seconds)**
3. Test Connection → (then Account / Entitlement Aggregation once those handlers ship)

Credentials live **only** in ISC source config. Never commit or zip them.

---

## Auth / runtime notes

| Issue | Meaning |
|-------|---------|
| `401` / unauthorized | Invalid or missing `serviceModeApiKey` |
| Connection refused / DNS | `serviceModeApiUrl` unreachable from the runtime (local or ISC egress) |
| Poll timed out | Commander did not finish before `pollTimeoutSeconds`; increase timeout or check Service Mode health |
| Unexpected response status | Service Mode returned a non-success result; inspect Commander logs |

Aggregation/provisioning in ISC cloud requires a working Test Connection first.

---

## Commands reference

```bash
npm install
npm run build
npm run pack-zip
npm run dev
sail conn upload -c keeper-security -f dist/keeper-security-0.1.0.zip
sail conn list
```

---

## Version

- Connector: `keeper-security@0.1.0`
