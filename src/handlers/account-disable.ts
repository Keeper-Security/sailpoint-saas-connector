import {
    ConnectorError,
    ConnectorErrorType,
    Context,
    KeyID,
    logger,
    Response,
    StdAccountDisableInput,
    StdAccountDisableOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { buildAccountMaps, buildRecordMaps, toAccount } from '../utils/keeper-mappings'
import { getRecordList } from '../utils/helper'

export function createAccountDisableHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountDisableInput,
        res: Response<StdAccountDisableOutput>
    ): Promise<void> => {
        const email = safeKeyId(input) ?? input?.identity
        if (!email) {
            throw new ConnectorError('std:account:disable called without an identity')
        }

        logger.info(`Locking Keeper vault account ${email}`)
        await client.lockUser(email)

        // Return the refreshed account view so ISC sees the new `disabled`
        // flag and the updated Keeper status (Locked).
        const user = await client.getUser(email)
        const folders = await client.listAllFolders()
        const records = getRecordList(await client.listVaultTree(),await client.getWhoami()) 

        if (!user) {
            throw new ConnectorError(
                `Keeper user with email "${email}" not found after lock`,
                ConnectorErrorType.NotFound
            )
        }

        res.send(toAccount(user, buildAccountMaps(folders), buildRecordMaps(records)))
    }
}

/** Returns the key's simple id if present, else null. KeyID throws on missing keys. */
function safeKeyId(input: StdAccountDisableInput): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}
