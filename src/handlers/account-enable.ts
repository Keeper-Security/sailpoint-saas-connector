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
import { buildIdMaps, toAccount } from '../utils/keeper-mappings'

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

        // Return the refreshed account view so ISC sees `disabled: false` and
        // the updated Keeper status (Active). Reuses the same catalog lookup
        // as account:list so entitlement joins stay intact.
        const [user, nodes, teams, roles] = await Promise.all([
            client.getUser(email),
            client.listNodes(),
            client.listTeams(),
            client.listRoles(),
        ])

        if (!user) {
            throw new ConnectorError(
                `Keeper user with email "${email}" not found after unlock`,
                ConnectorErrorType.NotFound
            )
        }

        res.send(toAccount(user, buildIdMaps(nodes, teams, roles)))
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
