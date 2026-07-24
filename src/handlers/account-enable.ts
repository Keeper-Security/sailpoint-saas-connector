import {
    ConnectorError,
    ConnectorErrorType,
    Context,
    KeyID,
    logger,
    Response,
    StdAccountEnableInput,
    StdAccountEnableOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { buildAccountMaps, toAccount } from '../utils/keeper-mappings'

export function createAccountEnableHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountEnableInput,
        res: Response<StdAccountEnableOutput>
    ): Promise<void> => {
        const email = safeKeyId(input) ?? input?.identity
        if (!email) {
            throw new ConnectorError('std:account:enable called without an identity')
        }

        logger.info(`Unlocking Keeper vault account ${email}`)
        await client.unlockUser(email)

        // Return the refreshed account view so ISC sees `disabled: false`
        // and the updated Keeper status (Active).
        const user = await client.getUser(email)
        const folders = await client.listManageableFolders()

        if (!user) {
            throw new ConnectorError(
                `Keeper user with email "${email}" not found after unlock`,
                ConnectorErrorType.NotFound
            )
        }

        res.send(toAccount(user, buildAccountMaps(folders)))
    }
}

/** Returns the key's simple id if present, else null. KeyID throws on missing keys. */
function safeKeyId(input: StdAccountEnableInput): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}
