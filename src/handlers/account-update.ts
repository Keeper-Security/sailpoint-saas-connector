import {
    AttributeChange,
    AttributeChangeOp,
    ConnectorError,
    ConnectorErrorType,
    Context,
    KeyID,
    logger,
    Response,
    StdAccountUpdateInput,
    StdAccountUpdateOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient, UpdateUserOptions } from '../client/keeper-client'
import { buildAccountMaps, buildRecordMaps, toAccount } from '../utils/keeper-mappings'
import { getRecordList } from '../utils/helper'

/**
 * Attributes exposed on the account schema that this handler intentionally
 * does not mutate. Keeper controls their values, so any op targeting them is
 * logged and skipped rather than failing the whole update. `email` is handled
 * separately (below) because it's the identity, not a plain read-only field.
 */
const READ_ONLY_ATTRS = new Set(['userId', 'status', 'accountStatus', 'twoFactorEnabled', 'aliases'])

export function createAccountUpdateHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountUpdateInput,
        res: Response<StdAccountUpdateOutput>
    ): Promise<void> => {
        const email = safeKeyId(input) ?? input?.identity
        if (!email) {
            throw new ConnectorError('std:account:update called without an identity')
        }

        const changes = input?.changes ?? []

        // ISC occasionally issues an update with no changes (e.g., a bulk edit
        // that resolves to a no-op for this account). Return the current view
        // rather than erroring so the caller's plan finishes cleanly.
        if (changes.length === 0) {
            logger.info(`std:account:update for "${email}" received no changes; returning current state`)
            res.send(await fetchFreshAccount(client, email))
            return
        }

        // Set on a multi-valued entitlement means "make membership exactly
        // match this list", which we implement as a diff against the current
        // membership. Since Commander now returns team_uid / role_id directly
        // on the user record, both sides of the diff are IDs — no catalog
        // lookup or name translation needed. All we need for a Set is the
        // user's current membership from getUser.
        const needsCurrent = changes.some(
            (c) => c.op === AttributeChangeOp.Set && (c.attribute === 'roles' || c.attribute === 'teams')
        )

        let currentRoleIds: string[] = []
        let currentTeamIds: string[] = []

        if (needsCurrent) {
            const user = await client.getUser(email)
            if (!user) {
                throw new ConnectorError(
                    `Keeper user with email "${email}" not found`,
                    ConnectorErrorType.NotFound
                )
            }
            currentRoleIds = user.roles ?? []
            currentTeamIds = user.teams ?? []
        }

        // Aggregate every change into a single UpdateUserOptions payload so
        // Commander sees the whole update as one atomic invocation.
        const opts: UpdateUserOptions = { email }
        const addRoles = new Set<string>()
        const removeRoles = new Set<string>()
        const addTeams = new Set<string>()
        const removeTeams = new Set<string>()

        for (const change of changes) {
            switch (change.attribute) {
                case 'name':
                    applyRequiredStringChange(change, 'name', (v) => {
                        opts.name = v
                    })
                    break
                case 'jobTitle':
                    applyOptionalStringChange(change, (v) => {
                        opts.jobTitle = v
                    })
                    break
                case 'node':
                    applyRequiredStringChange(change, 'node', (v) => {
                        opts.nodeId = v
                    })
                    break
                case 'roles':
                    applyMultiValuedChange(change, addRoles, removeRoles, currentRoleIds)
                    break
                case 'teams':
                    applyMultiValuedChange(change, addTeams, removeTeams, currentTeamIds)
                    break
                case 'email':
                    rejectEmailChange(change, email)
                    break
                default:
                    if (READ_ONLY_ATTRS.has(change.attribute)) {
                        logger.warn(
                            `std:account:update ignoring read-only attribute "${change.attribute}" ` +
                                `(op=${change.op}) for ${email}`
                        )
                    } else {
                        logger.warn(
                            `std:account:update ignoring unknown attribute "${change.attribute}" ` +
                                `(op=${change.op}) for ${email}`
                        )
                    }
            }
        }

        opts.addRoleValues = [...addRoles]
        opts.removeRoleValues = [...removeRoles]
        opts.addTeamValues = [...addTeams]
        opts.removeTeamValues = [...removeTeams]

        // If nothing translated into an actionable Commander flag (e.g., the
        // caller only touched read-only attributes, or a Set on roles turned
        // into a zero-length diff), skip the mutation but still respond with
        // the current account state so ISC sees a successful "no-op" update.
        if (!hasActionableChange(opts)) {
            logger.info(
                `std:account:update for "${email}" produced no actionable changes; returning current state`
            )
            res.send(await fetchFreshAccount(client, email))
            return
        }

        logger.info(`Updating Keeper vault account ${email}`)
        await client.updateUser(opts)

        res.send(await fetchFreshAccount(client, email))
    }
}

async function fetchFreshAccount(client: KeeperClient, email: string): Promise<StdAccountUpdateOutput> {
    // Only folders remains — node_id / team_uid / role_id are inline on user.
    const user = await client.getUser(email)
    const folders = await client.listAllFolders()
    const records = getRecordList(await client.listVaultTree(),await client.getWhoami()) 
    if (!user) {
        throw new ConnectorError(
            `Keeper user with email "${email}" not found after update`,
            ConnectorErrorType.NotFound
        )
    }
    return toAccount(user, buildAccountMaps(folders), buildRecordMaps(records))
}

function hasActionableChange(opts: UpdateUserOptions): boolean {
    return (
        opts.name !== undefined ||
        opts.jobTitle !== undefined ||
        opts.nodeId !== undefined ||
        (opts.addRoleValues?.length ?? 0) > 0 ||
        (opts.removeRoleValues?.length ?? 0) > 0 ||
        (opts.addTeamValues?.length ?? 0) > 0 ||
        (opts.removeTeamValues?.length ?? 0) > 0
    )
}

function applyRequiredStringChange(
    change: AttributeChange,
    label: string,
    assign: (value: string) => void
): void {
    if (change.op === AttributeChangeOp.Remove) {
        throw new ConnectorError(
            `cannot Remove required attribute "${label}"; use Set with a new value instead`
        )
    }
    const value = normalizeString(change.value)
    if (!value) {
        throw new ConnectorError(`std:account:update attribute "${label}" cannot be empty`)
    }
    assign(value)
}

function applyOptionalStringChange(change: AttributeChange, assign: (value: string) => void): void {
    if (change.op === AttributeChangeOp.Remove) {
        // Commander clears optional string fields when passed an empty value.
        assign('')
        return
    }
    assign(normalizeString(change.value) ?? '')
}

/**
 * Diff a multi-valued entitlement change into `adds` and `removes` sets of
 * IDs. Both `currentIds` (from getUser) and ISC-supplied values are stable
 * IDs (team_uid / role_id), so the Set-diff is a direct set comparison —
 * no catalog lookup, no name translation.
 */
function applyMultiValuedChange(
    change: AttributeChange,
    adds: Set<string>,
    removes: Set<string>,
    currentIds: string[]
): void {
    const values = coerceStringArray(change.value)

    switch (change.op) {
        case AttributeChangeOp.Add:
            for (const v of values) adds.add(v)
            return
        case AttributeChangeOp.Remove:
            for (const v of values) removes.add(v)
            return
        case AttributeChangeOp.Set: {
            const desired = new Set(values)
            const current = new Set(currentIds)
            for (const id of desired) {
                if (!current.has(id)) adds.add(id)
            }
            for (const id of current) {
                if (!desired.has(id)) removes.add(id)
            }
            return
        }
    }
}

function rejectEmailChange(change: AttributeChange, currentEmail: string): void {
    // A Set that matches the current identity is a harmless no-op that some
    // provisioning policies emit; let it through silently. Anything else
    // (Add/Remove, or a Set to a different value) is a real attempt to move
    // the identity, which this connector does not support.
    if (change.op === AttributeChangeOp.Set) {
        const desired = normalizeString(change.value)
        if (desired && desired.toLowerCase() === currentEmail.toLowerCase()) {
            return
        }
    }
    throw new ConnectorError(
        'cannot change "email" via std:account:update; email is the account identity'
    )
}

function safeKeyId(input: StdAccountUpdateInput): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

function coerceStringArray(value: unknown): string[] {
    if (value == null) return []
    const raw: unknown[] = Array.isArray(value) ? value : [value]
    return raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v !== '')
}
