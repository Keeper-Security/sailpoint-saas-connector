import {
    Context,
    logger,
    Response,
    StdAccountReadInput,
    StdAccountReadOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { loadAccountView } from '../utils/account-view'
import { resolveAccountEmail } from '../utils/identity'

export function createAccountReadHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountReadInput,
        res: Response<StdAccountReadOutput>
    ): Promise<void> => {
        const email = resolveAccountEmail(input, 'std:account:read')

        logger.info(`Reading Keeper vault account ${email}`)

        await client.syncEnterprise()
        logger.info('Synced enterprise')
        await client.syncVault()
        logger.info('Synced vault')

        res.send(await loadAccountView(client, email))
    }
}
