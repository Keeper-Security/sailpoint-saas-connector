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
import { KeeperFolder } from '../model/keeper-entities'
import { buildAccountMaps, buildRecordMaps, toAccount } from '../utils/keeper-mappings'
import { getRecordList, coerceNonEmptyStrings, requireSingleNodeId, getRecordListByEmail  } from '../utils/helper'
import {
    ClassicPermission,
    NsfPermission,
    classicFlags,
    isValidPermission,
    nsfRoleForCode,
    parseFolderEntitlementId,
} from '../utils/folder-permissions'

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
        // membership. Teams/roles come from getUser; folders come from vault
        // tree ACL maps (not on the enterprise user record).
        const needsCurrentRolesOrTeams = changes.some(
            (c) => c.op === AttributeChangeOp.Set && (c.attribute === 'roles' || c.attribute === 'teams')
        )
        const needsCurrentFolders = changes.some(
            (c) => c.op === AttributeChangeOp.Set && c.attribute === 'folders'
        )

        const needsCurrentRecords = changes.some(
            (c) => c.op === AttributeChangeOp.Set && c.attribute === 'records'
        )

        let currentRoleIds: string[] = []
        let currentTeamIds: string[] = []
        let currentRecordIds: string[] = []

        await client.syncEnterprise()
        await client.syncVault()
        let currentFolderIds: string[] = []

        if (needsCurrentRolesOrTeams) {
            const user = await client.getUser(email)

            
        }

        if (needsCurrentFolders) {
            const folders = await client.listAllFolders()
            currentFolderIds =
                buildAccountMaps(folders).userEmailToFolderIds.get(email.toLowerCase()) ?? []
        }

        if(needsCurrentRecords) {
            const vaultTree = await client.listVaultTree()
            currentRecordIds = getRecordListByEmail(email, vaultTree)
        }

        // node is single-valued on the account schema and in Keeper. Reject
        // plans that try to assign more than one node (e.g. multiple nodes in
        // an Access Profile). Remove ops are ignored later — a user must stay
        // in a node; ISC deprovisioning from a Role/AP often emits Remove.
        const nodeAssignChanges = changes.filter(
            (c) => c.attribute === 'node' && c.op !== AttributeChangeOp.Remove
        )
        if (nodeAssignChanges.length > 1) {
            throw new ConnectorError(
                `node is single-valued; expected at most one "node" change, got ${nodeAssignChanges.length}`
            )
        }

        // Aggregate every change into a single UpdateUserOptions payload so
        // Commander sees the whole update as one atomic invocation.
        const opts: UpdateUserOptions = { email }
        const addRoles = new Set<string>()
        const removeRoles = new Set<string>()
        const addTeams = new Set<string>()
        const removeTeams = new Set<string>()
        const addRecords = new Set<string>()
        const removeRecords = new Set<string>()
        const addFolders = new Set<string>()
        const removeFolders = new Set<string>()

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
                    applyNodeChange(change, (v) => {
                        opts.nodeId = v
                    })
                    break
                case 'roles':
                    applyMultiValuedChange(change, addRoles, removeRoles, currentRoleIds)
                    break
                case 'teams':
                    applyMultiValuedChange(change, addTeams, removeTeams, currentTeamIds)
                    break
                case 'folders':
                    applyMultiValuedChange(change, addFolders, removeFolders, currentFolderIds)
                    break
                case 'email':
                    rejectEmailChange(change, email)
                    break
                case 'records':
                    applyMultiValuedChange(change, addRecords, removeRecords, currentRecordIds)


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
        opts.addRecordValues = [...addRecords]
        opts.removeRecordValues = [...removeRecords]

        const folderWork = addFolders.size > 0 || removeFolders.size > 0
        const recordWork = addRecords.size > 0 || removeRecords.size > 0

        // If nothing translated into an actionable Commander flag (e.g., the
        // caller only touched read-only attributes, or a Set on roles turned
        // into a zero-length diff), skip the mutation but still respond with
        // the current account state so ISC sees a successful "no-op" update.
        if (!hasActionableChange(opts) && !folderWork && !recordWork) {
            logger.info(
                `std:account:update for "${email}" produced no actionable changes; returning current state`
            )
            res.send(await fetchFreshAccount(client, email))
            return
        }

        logger.info(`Updating Keeper vault account ${email}`)

        if (hasActionableChange(opts)) {
            await client.updateUser(opts)
        }

        if (folderWork) {
            await applyFolderChanges(client, email, [...addFolders], [...removeFolders])
        }

        if(recordWork) {
            logger.info(`Updating Keeper record permissions for ${email}`)
            await client.updateRecordPermissions(opts)
            logger.info(`Keeper record permissions updated for ${email}`)
        }

        res.send(await fetchFreshAccount(client, email))
    }
}

/**
 * Grant/remove classic and NSF folder shares. Non-sharable folders are rejected.
 * Remove runs first; if the same folder UID is also being granted (permission
 * change), skip remove and let grant update the existing share.
 */
async function applyFolderChanges(
    client: KeeperClient,
    email: string,
    adds: string[],
    removes: string[]
): Promise<void> {
    const catalog = await client.listAllFolders()
    const byUid = new Map<string, KeeperFolder>()
    for (const f of catalog) {
        if (f.uid) byUid.set(f.uid, f)
    }

    const addUids = new Set(adds.map((id) => parseFolderEntitlementId(id).uid))

    for (const id of removes) {
        const { uid } = parseFolderEntitlementId(id)
        if (addUids.has(uid)) {
            // Permission upgrade/downgrade on same folder — grant will replace.
            continue
        }
        const folder = byUid.get(uid)
        if (!folder) {
            throw new ConnectorError(
                `Keeper folder with uid "${uid}" not found (remove "${id}")`,
                ConnectorErrorType.NotFound
            )
        }
        if (folder.folderType === 'non-sharable') {
            throw new ConnectorError(
                `cannot remove share from non-sharable folder "${uid}"`
            )
        }
        logger.info(`Removing folder share ${uid} from ${email} (${folder.folderType})`)
        if (folder.folderType === 'classic') {
            await client.removeClassicFolderShare(uid, email)
        } else {
            await client.removeNsfFolderShare(uid, email)
        }
    }

    for (const id of adds) {
        const { uid, permission } = parseFolderEntitlementId(id)
        const folder = byUid.get(uid)
        if (!folder) {
            throw new ConnectorError(
                `Keeper folder with uid "${uid}" not found (grant "${id}")`,
                ConnectorErrorType.NotFound
            )
        }
        if (folder.folderType === 'non-sharable') {
            throw new ConnectorError(
                `cannot grant share on non-sharable folder "${uid}"`
            )
        }
        if (!permission || !isValidPermission(folder.folderType, permission)) {
            throw new ConnectorError(
                `invalid folder entitlement "${id}" for folderType "${folder.folderType}"`
            )
        }
        logger.info(`Granting folder share ${id} to ${email} (${folder.folderType})`)
        if (folder.folderType === 'classic') {
            const flags = classicFlags(permission as ClassicPermission)
            await client.grantClassicFolderShare(uid, email, flags.manageUsers, flags.manageRecords)
        } else {
            await client.grantNsfFolderShare(uid, email, nsfRoleForCode(permission as NsfPermission))
        }
    }
}

async function fetchFreshAccount(client: KeeperClient, email: string): Promise<StdAccountUpdateOutput> {
    // Folders/records come from vault tree; node/teams/roles are inline on user.
    const user = await client.getUser(email)
    const folders = await client.listAllFolders()
    const records = getRecordList(await client.listVaultTree(), await client.getWhoami())
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
        (opts.removeTeamValues?.length ?? 0) > 0 ||
        (opts.addRecordValues?.length ?? 0) > 0 ||
        (opts.removeRecordValues?.length ?? 0) > 0
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

/**
 * Keeper enterprise users belong to exactly one node.
 * - Remove (typical Role/AP deprovision): skip — cannot leave a user nodeless;
 *   move them with Set/Add instead.
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
    assign(
        requireSingleNodeId(change.value, 'std:account:update attribute "node" cannot be empty')
    )
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
    const values = coerceNonEmptyStrings(change.value)

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
