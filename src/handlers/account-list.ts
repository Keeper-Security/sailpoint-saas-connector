import {
    Context,
    logger,
    Response,
    StdAccountListInput,
    StdAccountListOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { buildAccountMaps, buildRecordMaps, toAccount } from '../utils/keeper-mappings'
import { getRecordList } from '../utils/helper'

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
        const whoami = await client.getWhoami()
        const vaultTree = await client.listVaultTree();
        const folders = await client.listManageableFolders()
        const records = getRecordList(vaultTree,whoami) 

        const maps = buildAccountMaps(folders)
        const recordMaps = buildRecordMaps(records)

        logger.info(`Loaded catalog: ${folders.length} folders`)
        logger.info(`Loaded catalog: ${records.length} records`)

        const users = await client.listUsers()
        logger.info(`Fetched ${users.length} Keeper users`)

        for (const user of users) {
            res.send(toAccount(user, maps, recordMaps))
        }
    }
}
