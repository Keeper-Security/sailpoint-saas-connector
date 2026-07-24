import {
    ConnectorError,
    ConnectorErrorType,
    Context,
    KeyID,
    logger,
    Response,
    StdAccountReadInput,
    StdAccountReadOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { buildAccountMaps, toAccount } from '../utils/keeper-mappings'

export function createAccountReadHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountReadInput,
        res: Response<StdAccountReadOutput>
    ): Promise<void> => {
        // Accounts use email as the identity, which lives in either `key.simple.id`
        // (strict schema value from ISC) or `input.identity` (local test tools).
        const email = safeKeyId(input) ?? input?.identity
        if (!email) {
            throw new ConnectorError('std:account:read called without an identity')
        }

        logger.info(`Reading Keeper vault account ${email}`)

        await client.syncEnterprise()
        logger.info('Synced enterprise')
        await client.syncVault()
        logger.info('Synced vault')

        const user = await client.getUser(email)
        const folders = await client.listManageableFolders()

        if (!user) {
            throw new ConnectorError(`Keeper user with email "${email}" not found`, ConnectorErrorType.NotFound)
        }

        res.send(toAccount(user, buildAccountMaps(folders)))
    }
}

/** Returns the key's simple id if present, else null. KeyID throws on missing keys. */
function safeKeyId(input: StdAccountReadInput): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}
