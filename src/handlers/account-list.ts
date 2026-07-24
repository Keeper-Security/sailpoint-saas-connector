import {
    Context,
    logger,
    Response,
    StdAccountListInput,
    StdAccountListOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { buildAccountMaps, toAccount } from '../utils/keeper-mappings'

export function createAccountListHandler(client: KeeperClient) {
    return async (
        _context: Context,
        _input: StdAccountListInput,
        res: Response<StdAccountListOutput>
    ): Promise<void> => {
        logger.info('Listing Keeper vault accounts')
        await client.syncEnterprise()
        logger.info('Synced enterprise')
        await client.syncVault()
        logger.info('Synced vault')

        const folders = await client.listManageableFolders()
        const maps = buildAccountMaps(folders)
        logger.info(`Loaded catalog: ${folders.length} folders`)

        const users = await client.listUsers()
        logger.info(`Fetched ${users.length} Keeper users`)

        for (const user of users) {
            res.send(toAccount(user, maps))
        }
    }
}
