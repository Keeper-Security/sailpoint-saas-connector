import {
    ConnectorError,
    ConnectorErrorType,
    Context,
    KeyID,
    logger,
    Response,
    StdEntitlementReadInput,
    StdEntitlementReadOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import {
    buildTeamFolderMap,
    buildNodePathMap,
    toFolderEntitlement,
    toNonSharableFolderEntitlement,
    toNodeEntitlement,
    toRoleEntitlement,
    toTeamEntitlement,
} from '../utils/keeper-mappings'
import { FolderPermission, isValidPermission, parseFolderEntitlementId } from '../utils/folder-permissions'
import { getAllShareableFolders } from '../utils/helper'

const SUPPORTED_TYPES = ['node', 'team', 'role', 'folder'] as const

export function createEntitlementReadHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdEntitlementReadInput,
        res: Response<StdEntitlementReadOutput>
    ): Promise<void> => {
        const type = input?.type
        // `key.simple.id` holds the strict identityAttribute value from the schema;
        // `input.identity` may be set to the displayAttribute value in some tools.
        // Prefer the key and fall back to `identity` so both ISC and local test
        // harnesses (spcx / Postman) work reliably.
        const identity = safeKeyId(input) ?? input?.identity
        if (!identity) {
            throw new ConnectorError(`std:entitlement:read called without an identity (type: ${type ?? 'unknown'})`)
        }

        logger.info(`Reading Keeper ${type} entitlement ${identity}`)

        switch (type) {
            case 'node': {
                // Nodes' full path is derived from the whole tree, so we still need the
                // full node list to reconstruct the same view we emit during list.
                const nodes = await client.listNodes()
                const node = nodes.find((n) => String(n.node_id) === identity)
                if (!node) {
                    throw new ConnectorError(`Keeper node with id "${identity}" not found`, ConnectorErrorType.NotFound)
                }
                res.send(toNodeEntitlement(node))
                return
            }

            case 'team': {
                const teams = await client.listTeams()
                const nodes = await client.listNodes()
                const folders = await client.listAllFolders()
                const team = teams.find((t) => t.team_uid === identity)
                if (!team) {
                    throw new ConnectorError(
                        `Keeper team with uid "${identity}" not found`,
                        ConnectorErrorType.NotFound
                    )
                }
                const teamUidToFolderIds = buildTeamFolderMap(folders)
                res.send(toTeamEntitlement(team, buildNodePathMap(nodes), teamUidToFolderIds.get(team.team_uid) ?? []))
                return
            }

            case 'role': {
                const roles = await client.listRoles()
                const nodes = await client.listNodes()
                const role = roles.find((r) => String(r.role_id) === identity)
                if (!role) {
                    throw new ConnectorError(`Keeper role with id "${identity}" not found`, ConnectorErrorType.NotFound)
                }
                res.send(toRoleEntitlement(role, buildNodePathMap(nodes)))
                return
            }

            case 'folder': {
                const { uid, permission } = parseFolderEntitlementId(identity)
                const vaultTree = await client.listVaultTree()
                const folders = getAllShareableFolders(vaultTree)
                const folder = folders.find((f) => f.uid === uid)
                if (!folder) {
                    throw new ConnectorError(`Keeper folder with uid "${uid}" not found`, ConnectorErrorType.NotFound)
                }
                if (folder.folderType === 'non-sharable') {
                    if (permission != null) {
                        throw new ConnectorError(
                            `Non-sharable folder id must be raw uid, got "${identity}"`,
                            ConnectorErrorType.NotFound
                        )
                    }
                    res.send(toNonSharableFolderEntitlement(folder))
                    return
                }
                if (!permission || !isValidPermission(folder.folderType, permission)) {
                    throw new ConnectorError(
                        `Invalid permission "${permission ?? ''}" for folderType "${folder.folderType}" ` +
                            `(id "${identity}")`,
                        ConnectorErrorType.NotFound
                    )
                }
                res.send(toFolderEntitlement(folder, permission as FolderPermission))
                return
            }

            default:
                throw new ConnectorError(
                    `Unsupported entitlement type "${type}"; expected one of: ${SUPPORTED_TYPES.join(', ')}`
                )
        }
    }
}

/** Returns the key's simple id if present, else null. KeyID throws on missing keys. */
function safeKeyId(input: StdEntitlementReadInput): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}
