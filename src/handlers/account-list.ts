import {
    Context,
    logger,
    Response,
    StdAccountListInput,
    StdAccountListOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { buildIdMaps, toAccount } from '../utils/keeper-mappings'

export function createAccountListHandler(client: KeeperClient) {
    return async (
        _context: Context,
        _input: StdAccountListInput,
        res: Response<StdAccountListOutput>
    ): Promise<void> => {
        logger.info('Listing Keeper vault accounts')

        // Aggregate the catalog first so we can translate names/paths to stable IDs
        // (team_uid, role_id, node_id) when building each account's entitlement arrays.
        const [nodes, teams, roles] = await Promise.all([
            client.listNodes(),
            client.listTeams(),
            client.listRoles(),
        ])
        const maps = buildIdMaps(nodes, teams, roles)
        logger.info(
            `Loaded catalog: ${nodes.length} nodes, ${teams.length} teams, ${roles.length} roles`
        )

        const users = await client.listUsers()
        logger.info(`Fetched ${users.length} Keeper users`)

        for (const user of users) {
            res.send(toAccount(user, maps))
        }
    }
}
