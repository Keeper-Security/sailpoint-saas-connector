import { ConnectorError } from '@sailpoint/connector-sdk'
import {
    KeeperFolder,
    KeeperFolderType,
    KeeperShareTeam,
    KeeperShareUser,
    KeeperVaultTreeData,
    KeeperVaultTreeNode,
} from '../model/keeper-entities'

function getChildrenRecords(childrenNode: KeeperVaultTreeNode[]): any[] {
    const records = []

    for (const child_folder of childrenNode) {
        if ((child_folder.kind === 'shared_folder' || child_folder.kind === 'folder') && child_folder.children !== undefined) {
            console.log("child_folder found",child_folder)
            records.push(...getChildrenRecords(child_folder.children))
        } else if (child_folder.kind === 'record' || child_folder.kind === 'nested_record') {
            records.push(child_folder)
        }
    }

    return records
}

export function getRecordList(_vaultTree: KeeperVaultTreeData): any[] {
    const vtree = _vaultTree.tree

    const children = vtree.children || []

    return getChildrenRecords(children)
}

/** Classic: whoami must have MU to include folder in catalog / membership. */
const CLASSIC_CATALOG_PERMS = new Set(['MU'])

/** NSF: whoami must have OW (Owner) to include folder in catalog / membership. */
const NSF_CATALOG_PERMS = new Set(['OW'])

const CONTAINER_KINDS = new Set(['shared_folder', 'folder', 'nested_share_folder'])

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
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

function whoamiPermsOnFolder(node: KeeperVaultTreeNode, whoamiEmail: string): string[] {
    const me = normalizeEmail(whoamiEmail)
    const entry = usersOnNode(node).find((u) => normalizeEmail(u.email) === me)
    return entry?.permissions ?? []
}

function isCatalogFolder(node: KeeperVaultTreeNode, whoamiEmail: string): boolean {
    const perms = whoamiPermsOnFolder(node, whoamiEmail)
    if (perms.length === 0) return false

    if (node.kind === 'shared_folder') {
        return perms.some((p) => CLASSIC_CATALOG_PERMS.has(p))
    }
    if (node.kind === 'nested_share_folder') {
        return perms.some((p) => NSF_CATALOG_PERMS.has(p))
    }
    return false
}

function folderTypeForKind(kind: string): KeeperFolderType | null {
    if (kind === 'shared_folder') return 'classic'
    if (kind === 'nested_share_folder') return 'nsf'
    return null
}

function stripLeadingSlash(path: string): string {
    return path.replace(/^\/+/, '')
}

function toKeeperFolder(node: KeeperVaultTreeNode, parentId: string | undefined, folderType: KeeperFolderType): KeeperFolder {
    const uid = node.uid!.trim()
    const rawPath = (node.path || node.name || uid).trim()
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
 * Walk the vault tree and collect catalog folders only
 * (classic: whoami has MU; NSF: whoami has OW).
 */
function collectFolders(
    nodes: KeeperVaultTreeNode[],
    parentId: string | undefined,
    out: KeeperFolder[],
    seen: Set<string>,
    whoamiEmail: string
): void {
    for (const node of nodes) {
        const uid = node.uid?.trim()
        const folderType = folderTypeForKind(node.kind)

        const include =
            !!folderType &&
            !!uid &&
            !seen.has(uid) &&
            isCatalogFolder(node, whoamiEmail)

        if (include && folderType && uid) {
            seen.add(uid)
            out.push(toKeeperFolder(node, parentId, folderType))
        }

        // Always walk children so nested shared_folder / nested_share_folder are found
        if (CONTAINER_KINDS.has(node.kind) && node.children?.length) {
            collectFolders(node.children, uid || parentId, out, seen, whoamiEmail)
        }
    }
}

/**
 * Whoami catalog folders: classic shared_folder if whoami has MU;
 * NSF nested_share_folder if whoami has OW.
 * Used for entitlement aggregation and account/team folder membership.
 */
export function getManageableFolders(vaultTree: KeeperVaultTreeData, whoamiEmail: string): KeeperFolder[] {
    if (!whoamiEmail?.trim()) {
        throw new ConnectorError(
            'whoami returned empty user; cannot filter manageable folders'
        )
    }
    const children = vaultTree.tree?.children ?? []
    const out: KeeperFolder[] = []
    collectFolders(children, undefined, out, new Set(), whoamiEmail)
    return out
}

/**
 * Whether whoami may grant/remove shares on this folder.
 * Same rule as catalog: classic MU; NSF OW.
 */
export function canWhoamiManageFolder(folder: KeeperFolder, whoamiEmail: string): boolean {
    if (!whoamiEmail?.trim()) return false
    const perms = folder.userPermissions?.[normalizeEmail(whoamiEmail)] ?? []
    if (perms.length === 0) return false
    if (folder.folderType === 'classic') {
        return perms.some((p) => CLASSIC_CATALOG_PERMS.has(p))
    }
    return perms.some((p) => NSF_CATALOG_PERMS.has(p))
}
