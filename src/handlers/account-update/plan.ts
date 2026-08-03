import {
    AttributeChange,
    AttributeChangeOp,
    ConnectorError,
    ConnectorErrorType,
    logger,
} from '@sailpoint/connector-sdk'
import { KeeperClient, UpdateUserOptions } from '../../client/keeper-client'
import { buildAccountMaps } from '../../utils/keeper-mappings'
import {
    coerceNonEmptyStrings,
    firstEntitlementValue,
    getAllShareableFolders,
    getRecordListByEmail,
    normalizeString,
    requireSingleNodeId,
} from '../../utils/helper'

export const READ_ONLY_ATTRS = new Set(['userId', 'status', 'twoFactorEnabled'])

/** Add/remove ID sets for one multi-valued entitlement attribute. */
export interface MembershipDelta {
    adds: Set<string>
    removes: Set<string>
}

export interface UpdatePlan {
    opts: UpdateUserOptions
    roles: MembershipDelta
    teams: MembershipDelta
    folders: MembershipDelta
    records: MembershipDelta
}

export interface CurrentMemberships {
    roleIds: string[]
    teamIds: string[]
    folderIds: string[]
    recordIds: string[]
}

export function emptyDelta(): MembershipDelta {
    return { adds: new Set(), removes: new Set() }
}

export function hasDeltaWork(delta: MembershipDelta): boolean {
    return delta.adds.size > 0 || delta.removes.size > 0
}

/**
 * True when enterprise-user flags (profile / node / roles / teams / email rename)
 * need to run. Email rename is expressed as `addAliasValues` because Keeper's
 * `--add-alias` promotes the new address to primary.
 */
export function hasUserMutation(opts: UpdateUserOptions): boolean {
    return (
        opts.name !== undefined ||
        opts.jobTitle !== undefined ||
        opts.nodeId !== undefined ||
        (opts.addRoleValues?.length ?? 0) > 0 ||
        (opts.removeRoleValues?.length ?? 0) > 0 ||
        (opts.addTeamValues?.length ?? 0) > 0 ||
        (opts.removeTeamValues?.length ?? 0) > 0 ||
        (opts.addAliasValues?.length ?? 0) > 0
    )
}

/** Profile / node / roles / teams only — excludes email rename (`addAliasValues`). */
export function withoutEmailRename(opts: UpdateUserOptions): UpdateUserOptions {
    return {
        email: opts.email,
        name: opts.name,
        jobTitle: opts.jobTitle,
        nodeId: opts.nodeId,
        addRoleValues: opts.addRoleValues,
        removeRoleValues: opts.removeRoleValues,
        addTeamValues: opts.addTeamValues,
        removeTeamValues: opts.removeTeamValues,
        addRecordValues: opts.addRecordValues,
        removeRecordValues: opts.removeRecordValues,
    }
}

export function toUserUpdateOptions(plan: UpdatePlan): UpdateUserOptions {
    return {
        ...plan.opts,
        addRoleValues: [...plan.roles.adds],
        removeRoleValues: [...plan.roles.removes],
        addTeamValues: [...plan.teams.adds],
        removeTeamValues: [...plan.teams.removes],
    }
}

/** New primary email when the plan renames via Keeper `--add-alias`, else undefined. */
export function plannedNewEmail(plan: UpdatePlan): string | undefined {
    return plan.opts.addAliasValues?.[0]
}

/** Pick a schema attribute for Result reporting when enterprise-user fails. */
export function primaryUserMutationAttribute(opts: UpdateUserOptions): string {
    if ((opts.addAliasValues?.length ?? 0) > 0) return 'email'
    if (opts.name !== undefined) return 'name'
    if (opts.jobTitle !== undefined) return 'jobTitle'
    if (opts.nodeId !== undefined) return 'node'
    if ((opts.addRoleValues?.length ?? 0) > 0 || (opts.removeRoleValues?.length ?? 0) > 0) return 'roles'
    if ((opts.addTeamValues?.length ?? 0) > 0 || (opts.removeTeamValues?.length ?? 0) > 0) return 'teams'
    return 'email'
}

export function hasWork(plan: UpdatePlan): boolean {
    return hasUserMutation(toUserUpdateOptions(plan)) || hasDeltaWork(plan.folders) || hasDeltaWork(plan.records)
}

/**
 * node is single-valued on the account schema and in Keeper. Reject plans that
 * try to assign more than one node (e.g. multiple nodes in an Access Profile).
 */
export function assertAtMostOneNodeAssign(changes: AttributeChange[]): void {
    const nodeAssignChanges = changes.filter((c) => c.attribute === 'node' && c.op !== AttributeChangeOp.Remove)
    if (nodeAssignChanges.length > 1) {
        throw new ConnectorError(
            `node is single-valued; expected at most one "node" change, got ${nodeAssignChanges.length}`
        )
    }
}

/**
 * Load only the current memberships needed for Set-diff on multi-valued attrs.
 * Teams/roles come from getUser; folders/records come from one vault tree.
 */
export async function loadCurrentMemberships(
    client: KeeperClient,
    email: string,
    changes: AttributeChange[]
): Promise<CurrentMemberships> {
    const needsUserProfile = changes.some(
        (c) => c.op === AttributeChangeOp.Set && (c.attribute === 'roles' || c.attribute === 'teams')
    )
    const needsFolders = changes.some((c) => c.op === AttributeChangeOp.Set && c.attribute === 'folders')
    const needsRecords = changes.some((c) => c.op === AttributeChangeOp.Set && c.attribute === 'records')

    const current: CurrentMemberships = {
        roleIds: [],
        teamIds: [],
        folderIds: [],
        recordIds: [],
    }

    if (needsUserProfile) {
        const user = await client.getUser(email)
        if (!user) {
            throw new ConnectorError(`Keeper user with email "${email}" not found`, ConnectorErrorType.NotFound)
        }
        current.roleIds = user.roles ?? []
        current.teamIds = user.teams ?? []
    }

    if (needsFolders || needsRecords) {
        const vaultTree = await client.listVaultTree()
        if (needsFolders) {
            const folders = getAllShareableFolders(vaultTree)
            current.folderIds = buildAccountMaps(folders).userEmailToFolderIds.get(email.toLowerCase()) ?? []
        }
        if (needsRecords) {
            current.recordIds = getRecordListByEmail(email, vaultTree)
        }
    }

    return current
}

/** Translate ISC attribute changes into Commander-ready deltas. */
export function buildUpdatePlan(email: string, changes: AttributeChange[], current: CurrentMemberships): UpdatePlan {
    const plan: UpdatePlan = {
        opts: { email },
        roles: emptyDelta(),
        teams: emptyDelta(),
        folders: emptyDelta(),
        records: emptyDelta(),
    }

    for (const change of changes) {
        switch (change.attribute) {
            case 'name':
                applyProfileStringChange(change, 'name', (v) => {
                    plan.opts.name = v
                })
                break
            case 'jobTitle':
                applyProfileStringChange(
                    change,
                    'jobTitle',
                    (v) => {
                        plan.opts.jobTitle = v
                    },
                    { allowClear: true }
                )
                break
            case 'node':
                applyNodeChange(change, (v) => {
                    plan.opts.nodeId = v
                })
                break
            case 'roles':
                applyMultiValuedChange(change, plan.roles, current.roleIds)
                break
            case 'teams':
                applyMultiValuedChange(change, plan.teams, current.teamIds)
                break
            case 'folders':
                applyMultiValuedChange(change, plan.folders, current.folderIds)
                break
            case 'records':
                applyMultiValuedChange(change, plan.records, current.recordIds)
                break
            case 'email':
                applyEmailChange(change, email, (newEmail) => {
                    plan.opts.addAliasValues = [newEmail]
                })
                break
            case 'aliases':
                throw new ConnectorError(
                    'cannot manage "aliases" via std:account:update; ' +
                        'Keeper --add-alias promotes the address to primary. ' +
                        'To rename the account, Set the "email" attribute to the new primary address.'
                )
            default:
                warnSkippedAttribute(change, email)
        }
    }

    return plan
}

/**
 * Diff a multi-valued entitlement change into `adds` / `removes`.
 * Both `currentIds` and ISC-supplied values are stable IDs, so Set-diff
 * needs no catalog lookup.
 */
export function applyMultiValuedChange(change: AttributeChange, delta: MembershipDelta, currentIds: string[]): void {
    const values = coerceNonEmptyStrings(change.value)

    switch (change.op) {
        case AttributeChangeOp.Add:
            for (const v of values) delta.adds.add(v)
            return
        case AttributeChangeOp.Remove:
            for (const v of values) delta.removes.add(v)
            return
        case AttributeChangeOp.Set: {
            const desired = new Set(values)
            const current = new Set(currentIds)
            for (const id of desired) {
                if (!current.has(id)) delta.adds.add(id)
            }
            for (const id of current) {
                if (!desired.has(id)) delta.removes.add(id)
            }
            return
        }
    }
}

/**
 * Keeper enterprise users belong to exactly one node.
 * - Remove (typical Role/AP deprovision): skip — cannot leave a user nodeless.
 * - Set/Add: validate a single id via requireSingleNodeId (shared with create).
 */
function applyNodeChange(change: AttributeChange, assign: (value: string) => void): void {
    if (change.op === AttributeChangeOp.Remove) {
        logger.info(
            'std:account:update ignoring Remove on "node" — Keeper users must remain in a node; ' +
                'use Set with a new node id to move the user'
        )
        return
    }
    assign(requireSingleNodeId(change.value, 'std:account:update attribute "node" cannot be empty'))
}

/**
 * Single-valued profile fields (`name`, `jobTitle`).
 * - Set/Add: require a non-empty string (unless allowClear and value is empty for jobTitle clear).
 * - Remove: clear when allowClear (jobTitle → ''); otherwise skip (name cannot be cleared).
 */
function applyProfileStringChange(
    change: AttributeChange,
    attribute: 'name' | 'jobTitle',
    assign: (value: string) => void,
    opts: { allowClear?: boolean } = {}
): void {
    if (change.op === AttributeChangeOp.Remove) {
        if (opts.allowClear) {
            assign('')
            return
        }
        logger.info(`std:account:update ignoring Remove on "${attribute}" — value cannot be cleared`)
        return
    }

    const value = firstEntitlementValue(change.value)
    if (value === undefined) {
        // Explicit empty jobTitle on Set clears the field in Commander.
        if (opts.allowClear && (change.value === '' || change.value === null)) {
            assign('')
            return
        }
        throw new ConnectorError(`std:account:update attribute "${attribute}" cannot be empty`)
    }
    assign(value)
}

/**
 * Primary email change from ISC Attribute Sync / Update Account.
 *
 * Keeper has no separate "rename email" API — `--add-alias <new>` on the
 * current primary promotes `<new>` to primary and demotes the old address to
 * an alias. A Set that matches the current identity is a no-op some policies
 * emit; only a different address is forwarded as `addAliasValues`.
 */
function applyEmailChange(
    change: AttributeChange,
    currentEmail: string,
    assign: (newEmail: string) => void
): void {
    if (change.op === AttributeChangeOp.Remove) {
        logger.info('std:account:update ignoring Remove on "email" — primary email cannot be cleared')
        return
    }

    const desired = firstEntitlementValue(change.value) ?? normalizeString(change.value)
    if (!desired) {
        throw new ConnectorError('std:account:update attribute "email" cannot be empty')
    }
    if (desired.toLowerCase() === currentEmail.toLowerCase()) {
        return
    }
    assign(desired)
}

function warnSkippedAttribute(change: AttributeChange, email: string): void {
    const kind = READ_ONLY_ATTRS.has(change.attribute) ? 'read-only' : 'unknown'
    logger.warn(`std:account:update ignoring ${kind} attribute "${change.attribute}" (op=${change.op}) for ${email}`)
}
