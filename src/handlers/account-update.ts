import {
    AttributeChange,
    AttributeChangeOp,
    ConnectorError,
    ConnectorErrorType,
    Context,
    KeyID,
    logger,
    Response,
    Result,
    ResultMessageLevel,
    ResultStatus,
    StdAccountUpdateInput,
    StdAccountUpdateOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient, UpdateUserOptions } from '../client/keeper-client'
import { KeeperFolder } from '../model/keeper-entities'
import { buildAccountMaps, buildRecordMaps, toAccount } from '../utils/keeper-mappings'
import { getRecordList, coerceNonEmptyStrings, requireSingleNodeId, getRecordListByEmail } from '../utils/helper'
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
 * separately because it's the identity, not a plain read-only field.
 */
const READ_ONLY_ATTRS = new Set(['userId', 'status', 'accountStatus', 'twoFactorEnabled', 'aliases'])

/** Add/remove ID sets for one multi-valued entitlement attribute. */
interface MembershipDelta {
    adds: Set<string>
    removes: Set<string>
}

interface UpdatePlan {
    opts: UpdateUserOptions
    roles: MembershipDelta
    teams: MembershipDelta
    folders: MembershipDelta
    records: MembershipDelta
}

interface CurrentMemberships {
    roleIds: string[]
    teamIds: string[]
    folderIds: string[]
    recordIds: string[]
}

/**
 * One failed unit of work during an update. Independent folder/record ops are
 * collected rather than aborting the whole plan, then reported together.
 */
interface OperationFailure {
    /** Account schema attribute (e.g. folders, records, name). */
    attribute: string
    /** Short action label for the aggregated error message. */
    action: string
    /** Target entitlement id / description. */
    target: string
    message: string
}

export function createAccountUpdateHandler(client: KeeperClient) {
    return async (
        _context: Context,
        input: StdAccountUpdateInput,
        res: Response<StdAccountUpdateOutput>
    ): Promise<void> => {
        const email = resolveEmail(input)
        const changes = input?.changes ?? []

        // ISC occasionally issues an update with no changes (e.g., a bulk edit
        // that resolves to a no-op for this account). Return the current view
        // rather than erroring so the caller's plan finishes cleanly.
        if (changes.length === 0) {
            logger.info(`std:account:update for "${email}" received no changes; returning current state`)
            res.send(await fetchFreshAccount(client, email))
            return
        }

        assertAtMostOneNodeAssign(changes)

        await client.syncEnterprise()
        await client.syncVault()

        const current = await loadCurrentMemberships(client, email, changes)
        const plan = buildUpdatePlan(email, changes, current)

        if (!hasWork(plan)) {
            logger.info(`std:account:update for "${email}" produced no actionable changes; returning current state`)
            res.send(await fetchFreshAccount(client, email))
            return
        }

        logger.info(`Updating Keeper vault account ${email}`)
        const failures = await applyUpdatePlan(client, email, plan)
        const account = await fetchFreshAccount(client, email)

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

function resolveEmail(input: StdAccountUpdateInput): string {
    const email = safeKeyId(input) ?? input?.identity
    if (!email) {
        throw new ConnectorError('std:account:update called without an identity')
    }
    return email
}

/**
 * node is single-valued on the account schema and in Keeper. Reject plans that
 * try to assign more than one node (e.g. multiple nodes in an Access Profile).
 * Remove ops are ignored later — a user must stay in a node.
 */
function assertAtMostOneNodeAssign(changes: AttributeChange[]): void {
    const nodeAssignChanges = changes.filter((c) => c.attribute === 'node' && c.op !== AttributeChangeOp.Remove)
    if (nodeAssignChanges.length > 1) {
        throw new ConnectorError(
            `node is single-valued; expected at most one "node" change, got ${nodeAssignChanges.length}`
        )
    }
}

/**
 * Load only the current memberships needed for Set-diff on multi-valued attrs.
 * Teams/roles come from getUser; folders/records come from vault tree maps.
 */
async function loadCurrentMemberships(
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

    if (needsFolders) {
        const folders = await client.listAllFolders()
        current.folderIds = buildAccountMaps(folders).userEmailToFolderIds.get(email.toLowerCase()) ?? []
    }

    if (needsRecords) {
        const vaultTree = await client.listVaultTree()
        current.recordIds = getRecordListByEmail(email, vaultTree)
    }

    return current
}

/** Translate ISC attribute changes into Commander-ready deltas. */
function buildUpdatePlan(email: string, changes: AttributeChange[], current: CurrentMemberships): UpdatePlan {
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
                applyRequiredStringChange(change, 'name', (v) => {
                    plan.opts.name = v
                })
                break
            case 'jobTitle':
                applyOptionalStringChange(change, (v) => {
                    plan.opts.jobTitle = v
                })
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
function applyMultiValuedChange(change: AttributeChange, delta: MembershipDelta, currentIds: string[]): void {
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

async function applyUpdatePlan(client: KeeperClient, email: string, plan: UpdatePlan): Promise<OperationFailure[]> {
    const failures: OperationFailure[] = []

    // Profile / roles / teams — one Commander call. On failure, still continue
    // with independent folder/record ops so one enterprise-user error does not
    // skip the rest of the plan.
    const userOpts = toUserUpdateOptions(plan)
    if (hasUserMutation(userOpts)) {
        try {
            await client.updateUser(userOpts)
        } catch (err) {
            failures.push({
                attribute: primaryUserMutationAttribute(userOpts),
                action: 'update user profile/roles/teams',
                target: email,
                message: errorMessage(err),
            })
            logger.warn(`User profile/roles/teams update failed for ${email}: ${errorMessage(err)}`)
        }
    }

    if (hasDeltaWork(plan.folders)) {
        failures.push(...(await applyFolderChanges(client, email, [...plan.folders.adds], [...plan.folders.removes])))
    }

    if (hasDeltaWork(plan.records)) {
        logger.info(`Updating Keeper record permissions for ${email}`)
        failures.push(...(await applyRecordChanges(client, email, [...plan.records.adds], [...plan.records.removes])))
        logger.info(`Finished Keeper record permission updates for ${email}`)
    }

    return failures
}

/** Pick a schema attribute for Result reporting when enterprise-user fails. */
function primaryUserMutationAttribute(opts: UpdateUserOptions): string {
    if (opts.name !== undefined) return 'name'
    if (opts.jobTitle !== undefined) return 'jobTitle'
    if (opts.nodeId !== undefined) return 'node'
    if ((opts.addRoleValues?.length ?? 0) > 0 || (opts.removeRoleValues?.length ?? 0) > 0) return 'roles'
    return 'teams'
}

function toUserUpdateOptions(plan: UpdatePlan): UpdateUserOptions {
    return {
        ...plan.opts,
        addRoleValues: [...plan.roles.adds],
        removeRoleValues: [...plan.roles.removes],
        addTeamValues: [...plan.teams.adds],
        removeTeamValues: [...plan.teams.removes],
    }
}

function hasWork(plan: UpdatePlan): boolean {
    return (
        hasUserMutation(toUserUpdateOptions(plan)) ||
        hasDeltaWork(plan.folders) ||
        hasDeltaWork(plan.records)
    )
}

/** True when enterprise-user flags (profile / roles / teams) need to run. */
function hasUserMutation(opts: UpdateUserOptions): boolean {
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

function hasDeltaWork(delta: MembershipDelta): boolean {
    return delta.adds.size > 0 || delta.removes.size > 0
}

function emptyDelta(): MembershipDelta {
    return { adds: new Set(), removes: new Set() }
}

function warnSkippedAttribute(change: AttributeChange, email: string): void {
    const kind = READ_ONLY_ATTRS.has(change.attribute) ? 'read-only' : 'unknown'
    logger.warn(
        `std:account:update ignoring ${kind} attribute "${change.attribute}" (op=${change.op}) for ${email}`
    )
}

/**
 * Grant/remove classic and NSF folder shares. Each entitlement is independent:
 * a failure on one folder is collected and the remaining folders still run.
 * Remove runs first; if the same folder UID is also being granted (permission
 * change), skip remove and let grant update the existing share.
 */
async function applyFolderChanges(
    client: KeeperClient,
    email: string,
    adds: string[],
    removes: string[]
): Promise<OperationFailure[]> {
    const failures: OperationFailure[] = []
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
        try {
            const folder = requireFolder(byUid, uid, `remove "${id}"`)
            assertSharable(folder, 'remove')
            logger.info(`Removing folder share ${uid} from ${email} (${folder.folderType})`)
            if (folder.folderType === 'classic') {
                await client.removeClassicFolderShare(uid, email)
            } else {
                await client.removeNsfFolderShare(uid, email)
            }
        } catch (err) {
            failures.push(folderFailure('remove', id, err))
            logger.warn(`Folder remove failed for ${id}: ${errorMessage(err)}`)
        }
    }

    for (const id of adds) {
        try {
            const { uid, permission } = parseFolderEntitlementId(id)
            const folder = requireFolder(byUid, uid, `grant "${id}"`)
            assertSharable(folder, 'grant')
            if (!permission || !isValidPermission(folder.folderType, permission)) {
                throw new ConnectorError(`invalid folder entitlement "${id}" for folderType "${folder.folderType}"`)
            }
            logger.info(`Granting folder share ${id} to ${email} (${folder.folderType})`)
            if (folder.folderType === 'classic') {
                const flags = classicFlags(permission as ClassicPermission)
                await client.grantClassicFolderShare(uid, email, flags.manageUsers, flags.manageRecords)
            } else {
                await client.grantNsfFolderShare(uid, email, nsfRoleForCode(permission as NsfPermission))
            }
        } catch (err) {
            failures.push(folderFailure('grant', id, err))
            logger.warn(`Folder grant failed for ${id}: ${errorMessage(err)}`)
        }
    }

    return failures
}

/**
 * Grant/revoke record shares one entitlement at a time so a single Commander
 * failure does not skip the remaining record ops.
 */
async function applyRecordChanges(
    client: KeeperClient,
    email: string,
    adds: string[],
    removes: string[]
): Promise<OperationFailure[]> {
    const failures: OperationFailure[] = []

    for (const id of adds) {
        try {
            await client.updateRecordPermissions({ email, addRecordValues: [id] })
        } catch (err) {
            failures.push(recordFailure('grant', id, err))
            logger.warn(`Record grant failed for ${id}: ${errorMessage(err)}`)
        }
    }

    for (const id of removes) {
        try {
            await client.updateRecordPermissions({ email, removeRecordValues: [id] })
        } catch (err) {
            failures.push(recordFailure('revoke', id, err))
            logger.warn(`Record revoke failed for ${id}: ${errorMessage(err)}`)
        }
    }

    return failures
}

function folderFailure(action: 'grant' | 'remove', target: string, err: unknown): OperationFailure {
    return {
        attribute: 'folders',
        action: `${action} folder share`,
        target,
        message: errorMessage(err),
    }
}

function recordFailure(action: 'grant' | 'revoke', target: string, err: unknown): OperationFailure {
    return {
        attribute: 'records',
        action: `${action} record share`,
        target,
        message: errorMessage(err),
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}

/**
 * One Result entry per failed attribute (folders / records / …), with every
 * failed entitlement listed in the messages array — SailPoint-native partial
 * attribute reporting on StdAccountUpdateOutput.results.
 */
function toAttributeResults(failures: OperationFailure[]): Result[] {
    const byAttribute = new Map<string, OperationFailure[]>()
    for (const f of failures) {
        const list = byAttribute.get(f.attribute) ?? []
        list.push(f)
        byAttribute.set(f.attribute, list)
    }

    const results: Result[] = []
    for (const [attribute, items] of byAttribute) {
        results.push({
            attribute,
            status: ResultStatus.Error,
            messages: items.map((item) => ({
                level: ResultMessageLevel.ERROR,
                message: `Failed to ${item.action} "${item.target}": ${item.message}`,
            })),
        })
    }
    return results
}

function formatAggregatedError(email: string, failures: OperationFailure[]): string {
    const details = failures
        .map((f, i) => `${i + 1}) ${f.attribute}: failed to ${f.action} "${f.target}" — ${f.message}`)
        .join('; ')
    return (
        `Account update partially failed for "${email}". ` +
        `${failures.length} operation(s) failed; successful changes were applied. ` +
        `Details: ${details}`
    )
}

function requireFolder(byUid: Map<string, KeeperFolder>, uid: string, context: string): KeeperFolder {
    const folder = byUid.get(uid)
    if (!folder) {
        throw new ConnectorError(`Keeper folder with uid "${uid}" not found (${context})`, ConnectorErrorType.NotFound)
    }
    return folder
}

function assertSharable(folder: KeeperFolder, action: 'grant' | 'remove'): void {
    if (folder.folderType === 'non-sharable') {
        throw new ConnectorError(`cannot ${action} share on non-sharable folder "${folder.uid}"`)
    }
}

async function fetchFreshAccount(client: KeeperClient, email: string): Promise<StdAccountUpdateOutput> {
    const user = await client.getUser(email)
    if (!user) {
        throw new ConnectorError(
            `Keeper user with email "${email}" not found after update`,
            ConnectorErrorType.NotFound
        )
    }

    const folders = await client.listAllFolders()
    const vaultTree = await client.listVaultTree()
    const whoami = await client.getWhoami()
    const records = getRecordList(vaultTree, whoami)

    return toAccount(user, buildAccountMaps(folders), buildRecordMaps(records))
}

function applyRequiredStringChange(change: AttributeChange, label: string, assign: (value: string) => void): void {
    if (change.op === AttributeChangeOp.Remove) {
        throw new ConnectorError(`cannot Remove required attribute "${label}"; use Set with a new value instead`)
    }
    const value = normalizeString(change.value)
    if (!value) {
        throw new ConnectorError(`std:account:update attribute "${label}" cannot be empty`)
    }
    assign(value)
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

function applyOptionalStringChange(change: AttributeChange, assign: (value: string) => void): void {
    if (change.op === AttributeChangeOp.Remove) {
        // Commander clears optional string fields when passed an empty value.
        assign('')
        return
    }
    assign(normalizeString(change.value) ?? '')
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
