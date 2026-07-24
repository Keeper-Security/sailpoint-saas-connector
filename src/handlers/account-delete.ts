import {
    ConnectorError,
    Context,
    KeyID,
    logger,
    Response,
    StdAccountDeleteInput,
    StdAccountDeleteOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'

/**
 * Handler for `std:account:delete`.
 *
 * Flow:
 *   1. Resolve the target email from the input (prefers strict `key.simple.id`,
 *      falls back to the legacy `identity` field so Postman-style callers work).
 *   2. Refresh the enterprise cache so our existence check sees the latest state.
 *   3. If the user is already gone, return success — delete is idempotent.
 *   4. Refuse if the target *is* the Commander service account itself; deleting
 *      it would strand the source without working credentials.
 *   5. Ask Commander to delete the user, then return an empty response body
 *      (StdAccountDeleteOutput is `{}` — ISC just needs the success signal).
 *
 * Note: there is no read-back at the end (the account is gone by design).
 */
export function createAccountDeleteHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountDeleteInput,
        res: Response<StdAccountDeleteOutput>
    ): Promise<void> => {
        const email = safeKeyId(input) ?? input?.identity
        if (!email) {
            throw new ConnectorError('std:account:delete called without an identity')
        }

        logger.info(`Attempting to delete Keeper vault account ${email}`)

        await client.syncEnterprise()

        const user = await client.getUser(email)
        if (!user) {
            logger.info(`User ${email} not found in Keeper; treating delete as no-op (idempotent success)`)
            res.send({})
            return
        }

        const me = await client.getWhoami()
        if (me.user && me.user.toLowerCase() === email.toLowerCase()) {
            throw new ConnectorError(
                `Refusing to delete "${email}" — this is the Commander service account backing the SailPoint source. Deleting it would break provisioning.`
            )
        }

        await client.deleteUser(email)
        logger.info(`Deleted Keeper vault account ${email}`)

        res.send({})
    }
}

/** Returns the key's simple id if present, else null. `KeyID` throws on missing keys. */
function safeKeyId(input: StdAccountDeleteInput): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}
