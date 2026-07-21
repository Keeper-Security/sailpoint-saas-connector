import {
    ConnectorError,
    ConnectorErrorType,
    Context,
    logger,
    Response,
    StdAccountCreateInput,
    StdAccountCreateOutput,
} from '@sailpoint/connector-sdk'
import { CreateUserOptions, KeeperClient } from '../client/keeper-client'
import { buildFolderMaps, buildIdMaps, toAccount } from '../utils/keeper-mappings'

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
        const email = normalizeString(attrs.email) ?? normalizeString(input?.identity)
        if (!email) {
            throw new ConnectorError('std:account:create requires an email in attributes.email or input.identity')
        }

        // `name` and `node` are declared required in connector-spec.json (ISC
        // enforces them on the create form). We re-check here so API/Postman
        // callers that bypass ISC's form validation get a clear, actionable
        // error instead of a cryptic Commander failure downstream.
        const name = normalizeString(attrs.name)
        if (!name) {
            throw new ConnectorError(
                `std:account:create for "${email}" is missing required attribute "name" ` + `(the user's display name).`
            )
        }

        const nodeId = normalizeString(attrs.node)
        if (!nodeId) {
            throw new ConnectorError(
                `std:account:create for "${email}" is missing required attribute "node" ` +
                    `(the node_id of the Keeper enterprise node to place the user in).`
            )
        }

        // Only forward attributes we actually know how to set on Keeper. Every
        // other attribute (userId, status, twoFactorEnabled, aliases, nodePath)
        // is either server-controlled or a display-only mirror of the node
        // entitlement.
        const createOptions: CreateUserOptions = {
            email,
            name,
            jobTitle: normalizeString(attrs.jobTitle),
            nodeId,
        }

        logger.info(
            `Creating Keeper vault account for "${email}" ` +
                `(name=${createOptions.name ?? '-'}), in node "${createOptions.nodeId ?? '-'}"`
        )
        await client.createUser(createOptions)

        // Fetch the fresh user + catalogs so ISC's stored account view matches
        // Keeper's post-invite state (status will be "Invited" until the user
        // accepts the email and sets up their vault).
        const [user, nodes, teams, roles, folders] = await Promise.all([
            client.getUser(email),
            client.listNodes(),
            client.listTeams(),
            client.listRoles(),
            client.listAllFolders(),
        ])

        if (!user) {
            throw new ConnectorError(
                `Keeper user "${email}" was created but could not be read back from enterprise-info. ` +
                    `Commander may still be propagating the invite; ISC will pick it up on the next aggregation.`,
                ConnectorErrorType.NotFound
            )
        }

        const maps = {
            ...buildIdMaps(nodes, teams, roles),
            ...buildFolderMaps(folders, teams),
        }
        res.send(toAccount(user, maps))
    }
}

/** Returns a trimmed non-empty string, or undefined for anything else. */
function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

/**
 * ISC delivers multi-valued entitlement attributes as arrays, but occasionally
 * a single scalar sneaks through (e.g., only one value assigned). Normalise
 * both shapes into a filtered array of non-empty trimmed strings.
 */
function normalizeStringArray(value: unknown): string[] | undefined {
    if (value == null) return undefined
    const raw: unknown[] = Array.isArray(value) ? value : [value]
    const result = raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v !== '')
    return result.length === 0 ? undefined : result
}
