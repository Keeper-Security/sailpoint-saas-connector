import {
    AttributeChange,
    AttributeChangeOp,
    ConnectorError,
    ConnectorErrorType,
    logger,
} from '@sailpoint/connector-sdk'
import { KeeperClient, UpdateUserOptions } from '../../client/keeper-client'
import { buildAccountMaps } from '../../utils/keeper-mappings'
import { coerceNonEmptyStrings, getAllShareableFolders, getRecordListByEmail, normalizeString, requireSingleNodeId } from '../../utils/helper'

/**
 * Non-entitlement attributes this handler does not mutate. Profile fields
 * (`name`, `jobTitle`) are set at create time only; updates are entitlement
 * driven (node / teams / roles / folders / records). Keeper-owned fields are
 * also skipped. `email` is handled separately (identity — rejected unless no-op).
 */
export const READ_ONLY_ATTRS = new Set([
    'userId',
    'status',
    'twoFactorEnabled',
    'aliases',
    'name',
    'jobTitle',
])

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

/** True when enterprise-user flags (node / roles / teams) need to run. */
export function hasUserMutation(opts: UpdateUserOptions): boolean {
    return (
        opts.nodeId !== undefined ||
        (opts.addRoleValues?.length ?? 0) > 0 ||
        (opts.removeRoleValues?.length ?? 0) > 0 ||
        (opts.addTeamValues?.length ?? 0) > 0 ||
        (opts.removeTeamValues?.length ?? 0) > 0
    )
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

/** Pick a schema attribute for Result reporting when enterprise-user fails. */
export function primaryUserMutationAttribute(opts: UpdateUserOptions): string {
    if (opts.nodeId !== undefined) return 'node'
    if ((opts.addRoleValues?.length ?? 0) > 0 || (opts.removeRoleValues?.length ?? 0) > 0) return 'roles'
    return 'teams'
}

export function hasWork(plan: UpdatePlan): boolean {
    return (
        hasUserMutation(toUserUpdateOptions(plan)) ||
        hasDeltaWork(plan.folders) ||
        hasDeltaWork(plan.records)
    )
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
    const needsRolesOrTeams = changes.some(
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

    if (needsRolesOrTeams) {
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
                rejectEmailChange(change, email)
                break
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

function rejectEmailChange(change: AttributeChange, currentEmail: string): void {
    // A Set that matches the current identity is a harmless no-op that some
    // provisioning policies emit; let it through silently. Anything else is a
    // real attempt to move the identity, which this connector does not support.
    if (change.op === AttributeChangeOp.Set) {
        const desired = normalizeString(change.value)
        if (desired && desired.toLowerCase() === currentEmail.toLowerCase()) {
            return
        }
    }
    throw new ConnectorError('cannot change "email" via std:account:update; email is the account identity')
}

function warnSkippedAttribute(change: AttributeChange, email: string): void {
    const kind = READ_ONLY_ATTRS.has(change.attribute) ? 'read-only' : 'unknown'
    logger.warn(
        `std:account:update ignoring ${kind} attribute "${change.attribute}" (op=${change.op}) for ${email}`
    )
}
