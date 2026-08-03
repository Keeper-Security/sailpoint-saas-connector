import { ConnectorError, Context, logger, Response, StdAccountUpdateInput, StdAccountUpdateOutput } from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { loadAccountView } from '../utils/account-view'
import { resolveAccountEmail } from '../utils/identity'
import { applyUpdatePlan } from './account-update/apply'
import { formatAggregatedError, toAttributeResults } from './account-update/errors'
import {
    assertAtMostOneNodeAssign,
    buildUpdatePlan,
    hasWork,
    loadCurrentMemberships,
    plannedNewEmail,
} from './account-update/plan'

export function createAccountUpdateHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountUpdateInput,
        res: Response<StdAccountUpdateOutput>
    ): Promise<void> => {
        const email = resolveAccountEmail(input, 'std:account:update')
        const changes = input?.changes ?? []

        // ISC occasionally issues an update with no changes (e.g., a bulk edit
        // that resolves to a no-op for this account). Return the current view
        // rather than erroring so the caller's plan finishes cleanly.
        if (changes.length === 0) {
            logger.info(`std:account:update for "${email}" received no changes; returning current state`)
            res.send(await loadAccountView(client, email))
            return
        }

        assertAtMostOneNodeAssign(changes)

        await client.syncEnterprise()
        await client.syncVault()

        const current = await loadCurrentMemberships(client, email, changes)
        const plan = buildUpdatePlan(email, changes, current)

        if (!hasWork(plan)) {
            logger.info(`std:account:update for "${email}" produced no actionable changes; returning current state`)
            res.send(await loadAccountView(client, email))
            return
        }

        logger.info(`Updating Keeper vault account ${email}`)
        const failures = await applyUpdatePlan(client, email, plan)

        // After a successful --add-alias rename, Keeper's primary is the new
        // address; reload under that identity so ISC stores the updated key.
        const emailRenameFailed = failures.some((f) => f.attribute === 'email')
        const resultEmail = !emailRenameFailed && plannedNewEmail(plan) ? plannedNewEmail(plan)! : email
        const account = await loadAccountView(client, resultEmail, {
            notFoundMessage: `Keeper user with email "${resultEmail}" not found after update`,
        })

        if (failures.length === 0) {
            res.send(account)
            return
        }

        // Partial success: return the post-update account (successful ops are
        // already applied) plus per-attribute results, then fail the command
        // with one aggregated message so ISC surfaces every failure.
        const message = formatAggregatedError(email, failures)
        logger.error(message)
        res.send({
            ...account,
            results: toAttributeResults(failures),
        })
        throw new ConnectorError(message)
    }
}
