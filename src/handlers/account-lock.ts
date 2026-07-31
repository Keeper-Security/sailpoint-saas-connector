import {
    Context,
    logger,
    Response,
    StdAccountDisableInput,
    StdAccountDisableOutput,
    StdAccountEnableInput,
    StdAccountEnableOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { loadAccountView } from '../utils/account-view'
import { resolveAccountEmail } from '../utils/identity'

export type AccountLockAction = 'lock' | 'unlock'

/**
 * Shared factory for `std:account:disable` (lock) and `std:account:enable` (unlock).
 * Behavior matches the previous dedicated handlers: mutate, then return a fresh account view.
 */
export function createAccountLockHandler(client: KeeperClient, action: AccountLockAction) {
    const commandLabel = action === 'lock' ? 'std:account:disable' : 'std:account:enable'
    const gerund = action === 'lock' ? 'Locking' : 'Unlocking'
    const past = action === 'lock' ? 'lock' : 'unlock'

    return async (
        _context: Context,
        input: StdAccountDisableInput | StdAccountEnableInput,
        res: Response<StdAccountDisableOutput | StdAccountEnableOutput>
    ): Promise<void> => {
        const email = resolveAccountEmail(input, commandLabel)

        logger.info(`${gerund} Keeper vault account ${email}`)
        if (action === 'lock') {
            await client.lockUser(email)
        } else {
            await client.unlockUser(email)
        }

        res.send(
            await loadAccountView(client, email, {
                notFoundMessage: `Keeper user with email "${email}" not found after ${past}`,
            })
        )
    }
}

export function createAccountDisableHandler(client: KeeperClient) {
    return createAccountLockHandler(client, 'lock')
}

export function createAccountEnableHandler(client: KeeperClient) {
    return createAccountLockHandler(client, 'unlock')
}
