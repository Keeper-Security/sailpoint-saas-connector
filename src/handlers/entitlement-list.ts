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
    buildFolderMaps,
    buildNodePathMap,
    toFolderEntitlement,
    toNodeEntitlement,
    toRoleEntitlement,
    toTeamEntitlement,
    toRecordEntitlement,
} from '../utils/keeper-mappings'

const SUPPORTED_TYPES = ['node', 'team', 'role', 'folder', 'record'] as const

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
                const [teams, nodes, folders] = await Promise.all([
                    client.listTeams(),
                    client.listNodes(),
                    client.listAllFolders(),
                ])
                const nodePathToId = buildNodePathMap(nodes)
                const { teamUidToFolderIds } = buildFolderMaps(folders, teams)
                logger.info(`Fetched ${teams.length} Keeper teams`)
                for (const team of teams) {
                    res.send(
                        toTeamEntitlement(team, nodePathToId, teamUidToFolderIds.get(team.team_uid) ?? [])
                    )
                }
                return
            }

            case 'role': {
                const [roles, nodes] = await Promise.all([client.listRoles(), client.listNodes()])
                const nodePathToId = buildNodePathMap(nodes)
                logger.info(`Fetched ${roles.length} Keeper roles`)
                for (const role of roles) {
                    res.send(toRoleEntitlement(role, nodePathToId))
                }
                return
            }
            case 'record': {
                const records = await client.listRecords()
                logger.info(`Fetched ${records.length} Keeper records`)
                for (const record of records) {
                    res.send(toRecordEntitlement(record))
                }
                return
            }
            
            case 'folder': {
                const folders = await client.listAllFolders()
                logger.info(`Fetched ${folders.length} Keeper folders`)
                for (const folder of folders) {
                    res.send(toFolderEntitlement(folder))
                }
                return
            }

            default:
                throw new ConnectorError(
                    `Unsupported entitlement type "${type}"; expected one of: ${SUPPORTED_TYPES.join(', ')}`
                )
        }
    }
}
