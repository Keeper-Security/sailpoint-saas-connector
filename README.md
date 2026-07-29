# Keeper Security Connector for SailPoint Identity Security Cloud

Govern Keeper Security enterprise users and access from SailPoint Identity Security Cloud (ISC). This SaaS connector integrates with **Keeper Commander Service Mode API v2** so you can aggregate accounts and entitlements, correlate identities, and provision access without custom scripts.

---

## Overview

The Keeper Security connector enables identity governance for your Keeper enterprise, including:

- Account aggregation and single-account refresh
- Entitlement aggregation for nodes, teams, roles, folders, and records
- Account lifecycle: create, update (entitlements), enable, disable, and delete
- Test connection against your Commander Service Mode endpoint

Identity on Keeper accounts is the user’s **email**. ISC Enable/Disable maps to Keeper lock/unlock. The account **status** attribute preserves Keeper’s native value (`Active`, `Invited`, `Locked`, and similar).

---

## Supported features

- Test connection
- Account aggregation
- Account read / reload
- Entitlement aggregation
- Entitlement read
- Create account
- Update account (entitlements)
- Enable / disable account
- Delete account

### Entitlement types

| Type | Description |
|---|---|
| **node** | Keeper enterprise node (organizational unit). Users belong to exactly one node. |
| **team** | Keeper team membership |
| **role** | Keeper role membership |
| **folder** | Shared folder access (classic and NSF), including permission level |
| **record** | Record shares granted directly to the user (classic and NSF) |

---

## Prerequisites

Before configuring a source in ISC, ensure the following:

1. **Keeper enterprise** with administrative access to manage users, teams, roles, and sharing.
2. **Keeper Commander Service Mode** running and reachable from SailPoint’s cloud (or your allowed network path), with a valid Service Mode API key.
3. **SailPoint ISC** admin permissions to create sources, configure correlation, and run aggregations.

> **Network:** The Service Mode URL must be reachable from the ISC connector runtime. For private or firewall-restricted Commander hosts, expose Service Mode with a supported tunnel such as **ngrok** or **Cloudflare Tunnel**, then use the public tunnel URL as the Service Mode API URL in the source configuration.

---

## Commander Service Mode Setup

In order to communicate between the Keeper Security SaaS Connector and Keeper, and to maintain zero knowledge and full end-to-end encryption, the Commander Service Mode are hosted by each customer on their own infrastructure to interact with the source.

To enable the source to authenticate and execute commands within the Keeper tenant, an authorized Keeper Commander configuration file must be created. This configuration can be generated on a host computer or workstation.

- [Install Keeper Commander](https://docs.keeper.io/keeperpam/commander-cli/commander-installation-setup) locally on your machine
- If required, create a new Keeper service account dedicated to this integration, ensuring it has access to the relevant records and folders and the ability to perform record and folder sharing.
- Login to Commander with the Keeper Service account (```serviceuser@company.com```)

# TODO 
add below in detail for ```sailpoint-app-setup``` command

### Tunneling Configuration (Optional)

If external access is required, configure one of the following:

| Prompt | Description |
|---|---|
| Ngrok Auth Token | Your ngrok authentication token for public URL generation. |
| Ngrok Custom Domain | Custom ngrok domain (e.g., `myapp.ngrok.io`). |
| Cloudflare Tunnel Token | Cloudflare tunnel token for public URL generation. |
| Cloudflare Custom Domain | Your Cloudflare domain (e.g., `slack.company.com`). |

> Ngrok and Cloudflare are mutually exclusive. Choose one if needed. This is NOT a requirement for the Slack App. But if you are using other integrations such as our Jira app, you might need to set up a cloud tunnel.


## Install from the Marketplace

1. In ISC, open **Admin → Connections → Sources** (or the **Marketplace / Connector Catalog**, depending on your tenant UI).
2. Find **Keeper Security** and select **Configure** / **Create Source**.
3. Complete the source configuration fields below, then save.
4. Run **Test Connection**.
5. Configure **account correlation**, then run **entitlement aggregation** followed by **account aggregation**.

---

## Source configuration

| Field | Required | Description |
|---|---|---|
| **Keeper Commander Service Mode API URL** | Yes | Base URL of Commander Service Mode **without** the `/api/v2/` path (example: `https://commander.example.com`) |
| **Keeper Commander Service Mode API Key** | Yes | Service Mode API key used for authentication |
| **Keeper Service Mode Poll Timeout (seconds)** | No | How long the connector waits for a Commander command to finish. Default: `60` |

---

## Account schema (summary)

| Attribute | Notes |
|---|---|
| **email** | Account identity (required) |
| **name** | Display name (required on create) |
| **userId** | Keeper enterprise user id (read-only) |
| **status** | Keeper status (`Active`, `Invited`, `Locked`, …) |
| **jobTitle** | Optional; set on create |
| **twoFactorEnabled** | Read-only |
| **aliases** | Read-only |
| **node** | Managed entitlement (required on create; single-valued) |
| **teams** | Managed entitlement (multi) |
| **roles** | Managed entitlement (multi) |
| **folders** | Managed entitlement (multi) |
| **records** | Managed entitlement (multi) |

### Account status in ISC

| Keeper `status` | ISC account state |
|---|---|
| `Active` | Enabled |
| `Invited`, `Locked`, and other non-active values | Disabled |

ISC **Enable** / **Disable** call Keeper unlock / lock. Use the **status** attribute when you need the native Keeper value.

---

## Recommended setup in ISC

### 1. Correlation

Correlate Keeper accounts to identities by email, for example:

- Account attribute **email** → Identity attribute **Work Email** (or the attribute that holds corporate email in your tenant)

Without a matching identity, aggregated accounts remain **uncorrelated**.

### 2. Aggregation order

1. Run **Entitlement Aggregation** first (nodes, teams, roles, folders, records).
2. Run **Account Aggregation** second so entitlement assignments resolve correctly.

Re-run account aggregation after major entitlement catalog changes.

### 3. Provisioning

Enable provisioning on the source when you want create / update / enable / disable / delete from ISC.

**Create account** typically requires:

- **email**
- **name**
- **node** (Keeper node id)

Optional on create: **jobTitle**, initial **roles** / **teams** (Note: These **roles/teams** will only be assigned to the user once they become **active**.).

**Account update** is entitlement-focused (node, teams, roles, folders, records). Profile fields such as **name** and **jobTitle** are applied at create time and are not updated by the connector’s update handler.

Configure a **Create Account** provisioning policy so ISC can populate required attributes (including dynamic **node** mapping via transforms when needed).

### 4. Folders and records

Folder and record entitlements represent shareable access governed through the Commander service account. Plan which folders/records should be in scope for IGA before enabling wide entitlement aggregation or assignment.

---

## Operational notes

| Topic | Guidance |
|---|---|
| **Test Connection** | Validates reachability and Commander session. Fix connectivity before aggregating. |
| **Delete** | Permanently removes the Keeper enterprise user. The connector refuses to delete the Commander service account itself. |
| **Partial entitlement updates** | When multiple folder/record changes are requested, the connector continues after individual failures and reports aggregated errors for items that did not succeed. |
| **Poll timeout** | Increase **Poll Timeout** if Commander commands frequently time out on large enterprises. |

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| Test Connection fails (401 / unauthorized) | Service Mode API key; Commander login session |
| Test Connection fails (timeout / unreachable) | URL (no `/api/v2/`), DNS, firewall / ISC egress to Commander |
| Aggregation incomplete or stale | Commander Service Mode health; increase poll timeout; re-run entitlement then account aggregation |
| All accounts uncorrelated | Correlation rule and identity email population from your authoritative source |
| Create fails missing node/name/email | Create Account provisioning policy mappings |
| Enable / Disable missing in UI | Source provisioning enabled; account not treated as ISC “locked” (connector maps Keeper lock to Disabled) |

---

## Resources
- [Keeper Enterprise Guide](https://docs.keeper.io/enterprise-guide)
- [Keeper Commander Service Mode](https://docs.keeper.io/keeperpam/commander-cli/service-mode-rest-api)

## Support

For support or feature requests, please [open a Github issue](https://github.com/Keeper-Security/sailpoint-saas-connector/issues) or contact:
- Email: commander@keepersecurity.com
