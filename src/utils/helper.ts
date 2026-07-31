import { ConnectorError } from '@sailpoint/connector-sdk'
import {
    KeeperRecord,
    KeeperUserSharePermissions,
    KeeperFolder,
    KeeperFolderType,
    KeeperShareTeam,
    KeeperShareUser,
    KeeperVaultTreeData,
    KeeperVaultTreeNode,
} from '../model/keeper-entities'

/** Intermediate record node collected while walking the vault tree. */
interface VaultRecordNode {
    recordUid: string
    title: string
    recordCategory: 'classic' | 'nested'
    type: string
    path: string
    userPermissions: KeeperUserSharePermissions
}

export const SUPPORTED_TYPES = ['node', 'team', 'role', 'folder', 'record'] as const

function getChildrenRecords(childrenNode: KeeperVaultTreeNode[]): VaultRecordNode[] {
    const records: VaultRecordNode[] = []

    for (const childNode of childrenNode) {
        if (
            (childNode.kind === 'shared_folder' ||
                childNode.kind === 'folder' ||
                childNode.kind === 'nested_share_folder') &&
            childNode.children !== undefined
        ) {
            records.push(...getChildrenRecords(childNode.children))
        } else if (childNode.kind === 'record' || childNode.kind === 'nested_record') {
            const userPermissions = childNode.share_permissions as KeeperUserSharePermissions
            records.push({
                recordUid: childNode.uid || '',
                title: childNode.name,
                recordCategory: childNode.kind === 'record' ? 'classic' : 'nested',
                type: childNode.record_type ?? '',
                path: childNode.path,
                userPermissions,
            })
        }
    }

    return records
}

/** Entitlement ids (`uid:PERM`) for records shared directly with this email. */
export function getRecordListByEmail(email: string, vaultTree: KeeperVaultTreeData): string[] {
    const children = vaultTree.tree?.children || []
    const filterRecords = getChildrenRecords(children)
    const userRecordPerm: string[] = []

    for (const record of filterRecords) {
        const matchedUsers = (record.userPermissions.users ?? []).filter((user) => normalizeEmail(user.email) === normalizeEmail(email))
        if (matchedUsers.length > 0) {
            for (const permission of matchedUsers[0].permissions ?? []) {
                userRecordPerm.push(`${record.recordUid}:${permission}`)
            }
        }
    }
    return userRecordPerm
}

/**
 * Expand vault-tree records into SailPoint record entitlements
 * (`record_uid:permission` rows). Does not mutate the vault-tree response.
 */
export function getRecordList(vaultTree: KeeperVaultTreeData): KeeperRecord[] {
    const classicPermissions = vaultTree.share_permissions_key.classic
    const nsfPermissions = vaultTree.share_permissions_key.nsf
    // MU/MR are folder-share flags on classic maps — exclude from record entitlements.
    const classicCodes = Object.keys(classicPermissions).filter((code) => code !== 'MU' && code !== 'MR')
    const nsfCodes = Object.keys(nsfPermissions)

    const children = vaultTree.tree?.children || []
    const filterRecords = getChildrenRecords(children)
    const sailEntitlements: KeeperRecord[] = []

    for (const record of filterRecords) {
        const users = record.userPermissions.users ?? []
        const permissionMap =
            record.recordCategory === 'classic' ? classicPermissions : nsfPermissions
        const permissionCodes = record.recordCategory === 'classic' ? classicCodes : nsfCodes

        for (const permission of permissionCodes) {
            const getUsers = users
                .filter((user) => user.permissions.includes(permission))
                .map((user) => user.email)

            sailEntitlements.push({
                record_uid: record.recordUid,
                record_uid_perm: `${record.recordUid}:${permission}`,
                title: record.title,
                record_category: record.recordCategory,
                type: record.type,
                path: record.path,
                permission: permissionMap[permission],
                users: getUsers,
            })
        }
    }

    return sailEntitlements
}

const CONTAINER_KINDS = new Set(['shared_folder', 'folder', 'nested_share_folder'])

function normalizeEmail(email: string): string {
    return email?.trim().toLowerCase()
}

function usersOnNode(node: KeeperVaultTreeNode): KeeperShareUser[] {
    const sp = node.share_permissions
    if (!sp || !('users' in sp) || !Array.isArray(sp.users)) return []
    return sp.users
}

function teamsOnNode(node: KeeperVaultTreeNode): KeeperShareTeam[] {
    const sp = node.share_permissions
    if (!sp || !('teams' in sp) || !Array.isArray(sp.teams)) return []
    return sp.teams
}

function folderTypeForKind(kind: string): KeeperFolderType | null {
    if (kind === 'shared_folder') return 'classic'
    if (kind === 'nested_share_folder') return 'nsf'
    if (kind === 'folder') return 'non-sharable'
    return null
}

function stripLeadingSlash(path: string): string {
    return path.replace(/^\/+/, '')
}

function toKeeperFolder(
    node: KeeperVaultTreeNode,
    parentId: string | undefined,
    folderType: KeeperFolderType
): KeeperFolder {
    const uid = node.uid!.trim()
    const rawPath = (node.path || node.name || uid)?.trim()
    const userPermissions: Record<string, string[]> = {}
    for (const u of usersOnNode(node)) {
        const email = normalizeEmail(u.email)
        if (!email) continue
        userPermissions[email] = [...(u.permissions ?? [])]
    }

    const teamPermissions: Record<string, string[]> = {}
    for (const t of teamsOnNode(node)) {
        const teamUid = t.uid?.trim()
        if (!teamUid) continue
        teamPermissions[teamUid] = [...(t.permissions ?? [])]
    }

    return {
        uid,
        name: node.name ?? '',
        path: stripLeadingSlash(rawPath) || node.name || uid,
        folderType,
        parentId,
        userPermissions,
        teamPermissions,
    }
}

/**
 * Walk the vault tree and collect classic shared_folder, NSF nested_share_folder,
 * and plain vault `folder` nodes (non-sharable, one entitlement each).
 */
function collectShareableFolders(
    nodes: KeeperVaultTreeNode[],
    parentId: string | undefined,
    out: KeeperFolder[],
    seen: Set<string>
): void {
    for (const node of nodes) {
        const uid = node.uid?.trim()
        const folderType = folderTypeForKind(node.kind)

        const include = !!folderType && !!uid && !seen.has(uid)

        if (include && folderType && uid) {
            seen.add(uid)
            out.push(toKeeperFolder(node, parentId, folderType))
        }

        // Always walk children so nested shared_folder / nested_share_folder are found
        if (CONTAINER_KINDS.has(node.kind) && node.children?.length) {
            collectShareableFolders(node.children, uid || parentId, out, seen)
        }
    }
}

/**
 * All folder nodes from the vault tree: classic, NSF, and non-sharable plain folders.
 * No whoami permission filter — Commander enforces share rights on grant/remove.
 */
export function getAllShareableFolders(vaultTree: KeeperVaultTreeData): KeeperFolder[] {
    const children = vaultTree.tree?.children ?? []
    const out: KeeperFolder[] = []
    collectShareableFolders(children, undefined, out, new Set())
    return out
}

/** Returns a trimmed non-empty string, or undefined for anything else. */
export function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize a scalar or array attribute into non-empty trimmed strings.
 * ISC often wraps single-valued managed entitlements (e.g. `node`) as arrays.
 */
export function coerceNonEmptyStrings(value: unknown): string[] {
    if (value == null) return []
    const raw: unknown[] = Array.isArray(value) ? value : [value]
    return raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v !== '')
}

/**
 * Read a single-valued attribute that ISC may deliver either as a scalar string
 * or as an array (managed entitlements). Returns the first non-empty trimmed value.
 */
export function firstEntitlementValue(value: unknown): string | undefined {
    const asScalar = normalizeString(value)
    if (asScalar) return asScalar
    const asArray = coerceNonEmptyStrings(value)
    return asArray[0]
}

/**
 * Keeper enterprise users belong to exactly one node. Accept a single id
 * (string or one-element array) and reject empty / multiple values.
 */
export function requireSingleNodeId(value: unknown, emptyMessage = 'attribute "node" cannot be empty'): string {
    const values = coerceNonEmptyStrings(value)
    if (values.length === 0) {
        throw new ConnectorError(emptyMessage)
    }
    if (values.length > 1) {
        throw new ConnectorError(`node is single-valued; expected one node id, got ${values.length}`)
    }
    return values[0]
}
