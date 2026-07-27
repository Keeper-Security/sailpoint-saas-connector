import { logger, StdAccountListOutput, StdEntitlementListOutput } from '@sailpoint/connector-sdk'
import { KeeperFolder, KeeperNode, KeeperRole, KeeperTeam, KeeperUser, KeeperRecord } from '../model/keeper-entities'
import {
    FolderPermission,
    folderEntitlementIdFromTreePerms,
    permissionLabel,
    permissionsForFolderType,
    toFolderEntitlementId,
} from './folder-permissions'

export const KEEPER_NODE_PATH_SEPARATOR = '\\'

/**
 * Keeper user statuses that we treat as "not disabled" for ISC. Only `Active`
 * qualifies: `Invited` users have been sent an invitation but haven't set up
 * their vault yet, so they can't actually sign in — surfacing them as
 * "Enabled" in ISC would misrepresent their real usability. They flip to
 * `Active` (and thus Enabled) automatically once they accept the invite.
 */
const ACTIVE_LIKE_STATUSES = new Set(['Active'])

/**
 * Minimal lookup map needed by `toAccount()` after Commander started
 * returning stable IDs directly on each user record. The only join left is
 * email -> folder entitlement identities for the `folders` attribute; the
 * `node` value is passed through as-is (its human-readable name lives on
 * the node entitlement, so ISC renders it correctly in the entitlement
 * assignments panel without a separate `nodePath` attribute).
 */
export interface AccountMaps {
    /** lowercase email -> folder entitlement identities (direct shares). */
    userEmailToFolderIds: Map<string, string[]>
}

export interface RecordMaps{
    userEmailToRecordIds: Map<string, string[]>
}

/**
 * Builds a node's full path from its `parent_node` and `name`.
 * Root nodes (no parent) resolve to just the node's name.
 */
export function buildNodePath(node: KeeperNode): string {
    if (!node.parent_node) {
        return node.name
    }
    return `${node.parent_node}${KEEPER_NODE_PATH_SEPARATOR}${node.name}`
}

/** Convenience: build only the node path -> id map (used by entitlement:list). */
export function buildNodePathMap(nodes: KeeperNode[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const node of nodes) {
        const path = buildNodePath(node)
        const id = String(node.node_id)
        registerFirstOrWarn(map, path, id, 'node')
    }
    return map
}

function registerFirstOrWarn(map: Map<string, string>, key: string, value: string, kind: string): void {
    const existing = map.get(key)
    if (existing == null) {
        map.set(key, value)
        return
    }
    if (existing !== value) {
        logger.warn(
            `Keeper ${kind} name collision for "${key}": keeping id "${existing}", ignoring "${value}". ` +
                `Consider making ${kind} names unique across nodes.`
        )
    }
}

/**
 * Build the lightweight lookup map that account handlers need. The only
 * catalog account:list / read / enable / disable / create / update can't
 * derive from the user record alone is folders (for the `folders`
 * entitlement attribute); everything else — node, teams, roles — is now
 * inline on the user as stable IDs.
 */
function pushFolderEntitlement(
    map: Map<string, string[]>,
    key: string,
    entitlementId: string
): void {
    const list = map.get(key) ?? []
    if (!list.includes(entitlementId)) list.push(entitlementId)
    map.set(key, list)
}

function addUserFolderEntitlements(
    map: Map<string, string[]>,
    folder: KeeperFolder
): void {
    if (!folder.uid) return
    for (const [email, treePerms] of Object.entries(folder.userPermissions ?? {})) {
        const key = email?.trim().toLowerCase()
        if (!key) continue
        const entId = folderEntitlementIdFromTreePerms(folder, treePerms)
        if (!entId) continue
        pushFolderEntitlement(map, key, entId)
    }
}

function addTeamFolderEntitlements(
    map: Map<string, string[]>,
    folder: KeeperFolder
): void {
    if (!folder.uid) return
    for (const [teamUid, treePerms] of Object.entries(folder.teamPermissions ?? {})) {
        if (!teamUid?.trim()) continue
        const entId = folderEntitlementIdFromTreePerms(folder, treePerms)
        if (!entId) continue
        pushFolderEntitlement(map, teamUid, entId)
    }
}

/**
 * Account `folders` = uid:CODE for all shareable folders from the vault tree.
 * Callers must pass listAllFolders() / getAllShareableFolders().
 */
export function buildAccountMaps(folders: KeeperFolder[]): AccountMaps {
    const userEmailToFolderIds = new Map<string, string[]>()
    for (const folder of folders) {
        addUserFolderEntitlements(userEmailToFolderIds, folder)
    }
    return { userEmailToFolderIds }
}

export function buildRecordMaps(records: KeeperRecord[]): RecordMaps {
    const userEmailToRecordIds = new Map<string, string[]>()
    for (const record of records){
        for (const email of record.users ?? []) {
            const key = email?.trim().toLowerCase()
            if (!key) continue
            const list = userEmailToRecordIds.get(key) ?? []
            if (!list.includes(record.record_uid_perm)) list.push(record.record_uid_perm)
            userEmailToRecordIds.set(key, list)
        }
    }
    return { userEmailToRecordIds }
}

/** Team `folders` = uid:CODE for all shareable folders from the vault tree. */
export function buildTeamFolderMap(folders: KeeperFolder[]): Map<string, string[]> {
    const teamUidToFolderIds = new Map<string, string[]>()
    for (const folder of folders) {
        addTeamFolderEntitlements(teamUidToFolderIds, folder)
    }
    return teamUidToFolderIds
}

// -------------------- Commander -> SailPoint output --------------------

export function toNodeEntitlement(node: KeeperNode): StdEntitlementListOutput {
    const id = String(node.node_id)
    return {
        identity: id,
        uuid: id,
        type: 'node',
        attributes: {
            id,
            name: node.name ?? '',
            path: buildNodePath(node),
            parentId: node.parent_id != null ? String(node.parent_id) : null,
            parentPath: node.parent_node ?? null,
            isolated: node.isolated ?? false,
        },
    }
}

export function toRecordEntitlement(record: KeeperRecord): StdEntitlementListOutput {
    const id = String(record.record_uid_perm)
    return {
        identity: id,
        uuid: id,
        type: 'record',

        attributes: {
            id,
            displayName: record.title + ' [' + record.permission + ']',
            name: record.title ?? '',
            record_category: record.record_category ?? '',
            record_uid: record.record_uid,
            type: record.type ?? '',
            permission: record.permission,
            path: record.path,
        },
    }
}

export function toTeamEntitlement(
    team: KeeperTeam,
    nodePathToId: Map<string, string>,
    folderIds: string[] = []
): StdEntitlementListOutput {
    const nodePath = team.node ?? null
    const nodeId = nodePath ? nodePathToId.get(nodePath) ?? null : null
    return {
        identity: team.team_uid,
        uuid: team.team_uid,
        type: 'team',
        attributes: {
            id: team.team_uid,
            name: team.name ?? '',
            nodeId,
            nodePath,
            restricts: team.restricts ?? '',
            folders: folderIds,
        },
    }
}

export function toRoleEntitlement(role: KeeperRole, nodePathToId: Map<string, string>): StdEntitlementListOutput {
    const id = String(role.role_id)
    const nodePath = role.node ?? null
    const nodeId = nodePath ? nodePathToId.get(nodePath) ?? null : null
    return {
        identity: id,
        uuid: id,
        type: 'role',
        attributes: {
            id,
            name: role.name ?? '',
            nodeId,
            nodePath,
            admin: role.admin ?? false,
            defaultRole: role.default_role ?? false,
            visibleBelow: role.visible_below ?? false,
        },
    }
}

export function toAccount(user: KeeperUser, maps: AccountMaps, recordMaps: RecordMaps): StdAccountListOutput {
    // Commander returns stable IDs directly on the user record:
    //   user.node   = node_id (string, single-valued entitlement)
    //   user.teams  = team_uid array
    //   user.roles  = role_id array (as strings)
    // All three are passed through as-is; ISC renders their human-readable
    // names via the linked entitlements in the assignments panel.
    const status = user.status ?? ''
    const disabled = status !== '' && !ACTIVE_LIKE_STATUSES.has(status)

    return {
        identity: user.email,
        uuid: String(user.user_id),
        // Deliberately omit the `locked` flag. Keeper's `Locked` status maps
        // to ISC "Disabled" (via `disabled` above) because our
        // std:account:disable/enable handlers use `enterprise-user --lock/
        // --unlock` under the hood. Setting `locked: true` would make ISC
        // suppress the Enable/Disable action and look for an unlock command
        // we don't publish. The raw Keeper state is still readable in
        // `attributes.status` for reporting and filtering.
        disabled,
        attributes: {
            userId: String(user.user_id),
            email: user.email,
            name: user.name ?? '',
            status,
            accountStatus: user.status ?? '',
            jobTitle: user.job_title ?? '',
            twoFactorEnabled: user['2fa_enabled'] ?? false,
            aliases: user.alias ?? [],
            node: user.node ?? null,
            teams: user.teams ?? [],
            roles: user.roles ?? [],
            folders: maps.userEmailToFolderIds.get((user.email ?? '').toLowerCase()) ?? [],
            records: recordMaps.userEmailToRecordIds.get((user.email ?? '').toLowerCase()) ?? [],
        },
    }
}

/**
 * Sharable folder entitlement = folder UID + permission code.
 * Classic: NP|MU|MR|MUR. NSF: V|SM|CM|CSM|FM.
 */
export function toFolderEntitlement(folder: KeeperFolder, permission: FolderPermission): StdEntitlementListOutput {
    const id = toFolderEntitlementId(folder.uid, permission)
    const label = permissionLabel(folder.folderType, permission)
    const baseName = (folder.name || folder.path || folder.uid)?.trim()
    return {
        identity: id,
        uuid: id,
        type: 'folder',
        attributes: {
            id,
            uid: folder.uid,
            name: `${baseName} [${label}]`,
            path: folder.path || folder.name || folder.uid,
            folderType: folder.folderType,
            parentId: folder.parentId ?? null,
            permission,
            permissionLabel: label,
        },
    }
}

/** Non-sharable plain vault folder — one entitlement, identity = raw uid. */
export function toNonSharableFolderEntitlement(folder: KeeperFolder): StdEntitlementListOutput {
    const id = folder.uid
    const baseName = (folder.name || folder.path || folder.uid)?.trim()
    return {
        identity: id,
        uuid: id,
        type: 'folder',
        attributes: {
            id,
            uid: folder.uid,
            name: baseName,
            path: folder.path || folder.name || folder.uid,
            folderType: 'non-sharable',
            parentId: folder.parentId ?? null,
            permission: null,
            permissionLabel: null,
        },
    }
}

/** Expand one Keeper folder into entitlement(s) for its type. */
export function toFolderEntitlements(folder: KeeperFolder): StdEntitlementListOutput[] {
    if (folder.folderType === 'non-sharable') {
        return [toNonSharableFolderEntitlement(folder)]
    }
    return permissionsForFolderType(folder.folderType).map((permission) =>
        toFolderEntitlement(folder, permission)
    )
}
