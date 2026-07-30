import { ConnectorError, ConnectorErrorType, logger } from '@sailpoint/connector-sdk'
import { KeeperClient } from '../../client/keeper-client'
import { KeeperFolder } from '../../model/keeper-entities'
import {
    ClassicPermission,
    NsfPermission,
    classicFlags,
    isValidPermission,
    nsfRoleForCode,
    parseFolderEntitlementId,
} from '../../utils/folder-permissions'
import { errorMessage, OperationFailure } from './errors'
import {
    hasDeltaWork,
    hasUserMutation,
    primaryUserMutationAttribute,
    toUserUpdateOptions,
    UpdatePlan,
} from './plan'

export async function applyUpdatePlan(client: KeeperClient, email: string, plan: UpdatePlan): Promise<OperationFailure[]> {
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
                action: 'update node/roles/teams',
                target: email,
                message: errorMessage(err),
            })
            logger.warn(`User node/roles/teams update failed for ${email}: ${errorMessage(err)}`)
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
            } else if (folder.folderType === 'nsf') {
                await client.removeNsfFolderShare(uid, email)
            } else {
                throw new ConnectorError(`unsupported folderType "${folder.folderType}" when removing folder share`)
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
            } else if (folder.folderType === 'nsf') {
                await client.grantNsfFolderShare(uid, email, nsfRoleForCode(permission as NsfPermission))
            } else {
                throw new ConnectorError(`unsupported folderType "${folder.folderType}" when granting folder share`)
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

    for (const id of removes) {
        try {
            await client.updateRecordPermissions({ email, removeRecordValues: [id] })
        } catch (err) {
            failures.push(recordFailure('revoke', id, err))
            logger.warn(`Record revoke failed for ${id}: ${errorMessage(err)}`)
        }
    }

    for (const id of adds) {
        try {
            await client.updateRecordPermissions({ email, addRecordValues: [id] })
        } catch (err) {
            failures.push(recordFailure('grant', id, err))
            logger.warn(`Record grant failed for ${id}: ${errorMessage(err)}`)
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
