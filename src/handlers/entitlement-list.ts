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
    toFolderEntitlements,
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
                const teams = await client.listTeams()
                const nodes = await client.listNodes()
                const folders = await client.listAllFolders()
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
                const records = await client.listRecords()
                const classic_permissions = ['View Only', 'Can Edit','Can Share','Can Edit & Share','Owner']
                const nsf_permissions = ['Viewer', 'Share Manager','Content Manager','Content and Share Manager', 'Full Manager','Owner']
                logger.info(`Fetched ${records.length} Keeper records`)
                for (const record of records) {
                    if(record.record_category.toLowerCase() === 'classic'){
                        for(const perm of classic_permissions){
                            res.send(toRecordEntitlement(record,perm));
                        }
                }
                else{
                    for(const perm of nsf_permissions){
                        res.send(toRecordEntitlement(record,perm));
                    }
                }
            }
                return
            }
            case 'folder': {
                const folders = await client.listAllFolders()
                let entitlementCount = 0
                for (const folder of folders) {
                    for (const ent of toFolderEntitlements(folder)) {
                        res.send(ent)
                        entitlementCount++
                    }
                }
                logger.info(
                    `Fetched ${folders.length} Keeper folders → ${entitlementCount} folder entitlements (by permission)`
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
