import {
    ConnectorError,
    Context,
    logger,
    Response,
    StdAccountCreateInput,
    StdAccountCreateOutput,
} from '@sailpoint/connector-sdk'
import { CreateUserOptions, KeeperClient } from '../client/keeper-client'
import { loadAccountView } from '../utils/account-view'
import { coerceNonEmptyStrings, firstEntitlementValue, requireSingleNodeId } from '../utils/helper'

export function createAccountCreateHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountCreateInput,
        res: Response<StdAccountCreateOutput>
    ): Promise<void> => {
        const attrs = (input?.attributes ?? {}) as Record<string, unknown>

        // Email is the account identifier in our schema. ISC sends it either in
        // `attributes.email` or as `input.identity` (both are usually the same
        // value at create time). We accept either.
        const email = firstEntitlementValue(attrs.email) ?? firstEntitlementValue(input?.identity)
        if (!email) {
            throw new ConnectorError('std:account:create requires an email in attributes.email or input.identity')
        }

        // `name` and `node` are declared required in connector-spec.json (ISC
        // enforces them on the create form). We re-check here so API/Postman
        // callers that bypass ISC's form validation get a clear, actionable
        // error instead of a cryptic Commander failure downstream.
        const name = firstEntitlementValue(attrs.name)
        if (!name) {
            throw new ConnectorError(
                `std:account:create for "${email}" is missing required attribute "name" ` + `(the user's display name).`
            )
        }

        // `node` is a managed entitlement, so ISC delivers it as an array
        // (e.g. ["70411693850651"]) even though it is single-valued. Accept a
        // scalar or a one-element array; reject multiple node ids explicitly.
        const nodeId = requireSingleNodeId(
            attrs.node,
            `std:account:create for "${email}" is missing required attribute "node" ` +
                `(the node_id of the Keeper enterprise node to place the user in).`
        )

        // Only forward attributes we actually know how to set on Keeper. Every
        // other attribute (userId, status, twoFactorEnabled, aliases)
        // is either server-controlled or a display-only mirror of the node
        // entitlement. roles / teams are optional — ISC may include them when
        // create is driven by a Role/AP that also grants those entitlements.
        const addRoleValues = coerceNonEmptyStrings(attrs.roles)
        const addTeamValues = coerceNonEmptyStrings(attrs.teams)

        const createOptions: CreateUserOptions = {
            email,
            name,
            jobTitle: firstEntitlementValue(attrs.jobTitle),
            nodeId,
            ...(addRoleValues.length > 0 ? { addRoleValues } : {}),
            ...(addTeamValues.length > 0 ? { addTeamValues } : {}),
        }

        logger.info(
            `Creating Keeper vault account for "${email}" ` +
                `(name=${createOptions.name ?? '-'}), in node "${createOptions.nodeId ?? '-'}"` +
                `, roles=[${addRoleValues.join(',') || '-'}]` +
                `, teams=[${addTeamValues.join(',') || '-'}]`
        )
        await client.createUser(createOptions)

        // Fetch the fresh user + folders so ISC's stored account view
        // matches Keeper's post-invite state (status will be "Invited"
        // until the user accepts the email and sets up their vault).
        res.send(
            await loadAccountView(client, email, {
                notFoundMessage:
                    `Keeper user "${email}" was created but could not be read back from enterprise-info. ` +
                    `Commander may still be propagating the invite; ISC will pick it up on the next aggregation.`,
            })
        )
    }
}
