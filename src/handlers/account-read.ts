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
import { buildIdMaps, toAccount } from '../utils/keeper-mappings'

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

        // Fetch the user and the entitlement catalogs in parallel. The catalogs are
        // needed to translate Commander's name-based `teams`/`roles`/`node` values
        // on the user into stable IDs that match the entitlement schemas.
        const [user, nodes, teams, roles] = await Promise.all([
            client.getUser(email),
            client.listNodes(),
            client.listTeams(),
            client.listRoles(),
        ])

        if (!user) {
            throw new ConnectorError(
                `Keeper user with email "${email}" not found`,
                ConnectorErrorType.NotFound
            )
        }

        const maps = buildIdMaps(nodes, teams, roles)
        res.send(toAccount(user, maps))
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
