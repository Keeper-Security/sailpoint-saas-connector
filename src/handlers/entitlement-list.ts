import {
    ConnectorError,
    Context,
    logger,
    Response,
    StdEntitlementListInput,
    StdEntitlementListOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import {
    buildTeamFolderMap,
    buildNodePathMap,
    toFolderEntitlements,
    toNodeEntitlement,
    toRoleEntitlement,
    toTeamEntitlement,
    toRecordEntitlement,
} from '../utils/keeper-mappings'
import { getAllShareableFolders, getRecordList } from '../utils/helper'
import { SUPPORTED_TYPES } from '../utils/helper'

export function createEntitlementListHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdEntitlementListInput,
        res: Response<StdEntitlementListOutput>
    ): Promise<void> => {
        const type = input.type
        logger.info(`Listing entitlements of type "${type}"`)
        await client.syncVault()
        logger.info('Synced vault while listing entitlements')
        await client.syncEnterprise()
        logger.info('Synced enterprise while listing entitlements')

        const vaultTree = await client.listVaultTree()

        switch (type) {
            case 'node': {
                const nodes = await client.listNodes()
                logger.info(`Fetched ${nodes.length} Keeper nodes`)

                for (const node of nodes) {
                    res.send(toNodeEntitlement(node))
                }
                return
            }
            case 'team': {
                const teams = await client.listTeams()
                const nodes = await client.listNodes()
                // All shareable folders so team.folders match entitlement list
                const folders = getAllShareableFolders(vaultTree)
                const nodePathToId = buildNodePathMap(nodes)
                const teamUidToFolderIds = buildTeamFolderMap(folders)
                logger.info(`Fetched ${teams.length} Keeper teams`)
                for (const team of teams) {
                    res.send(toTeamEntitlement(team, nodePathToId, teamUidToFolderIds.get(team.team_uid) ?? []))
                }
                return
            }
            case 'role': {
                const roles = await client.listRoles()
                const nodes = await client.listNodes()
                const nodePathToId = buildNodePathMap(nodes)
                logger.info(`Fetched ${roles.length} Keeper roles`)
                for (const role of roles) {
                    res.send(toRoleEntitlement(role, nodePathToId))
                }
                return
            }
            case 'record': {
                const records = getRecordList(vaultTree)

                for (const record of records) {
                    res.send(toRecordEntitlement(record))
                }
                return
            }
            case 'folder': {
                // All classic shared_folder / NSF nested_share_folder from vault tree
                const folders = getAllShareableFolders(vaultTree)
                let entitlementCount = 0
                for (const folder of folders) {
                    for (const ent of toFolderEntitlements(folder)) {
                        res.send(ent)
                        entitlementCount++
                    }
                }
                logger.info(
                    `Fetched ${folders.length} Keeper folders → ` +
                        `${entitlementCount} folder entitlements (by permission)`
                )
                return
            }
            default:
                throw new ConnectorError(
                    `Unsupported entitlement type "${type}"; expected one of: ${SUPPORTED_TYPES.join(', ')}`
                )
        }
    }
}
