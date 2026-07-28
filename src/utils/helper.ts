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
import { WhoamiInfo } from '../client/keeper-client'

function getChildrenRecords(childrenNode: KeeperVaultTreeNode[], _whoami: WhoamiInfo): any[] {
    const records:any[] = []

    for (const child_node of childrenNode) {
        if ((child_node.kind === 'shared_folder' || child_node.kind === 'folder') && child_node.children !== undefined) {
            records.push(...getChildrenRecords(child_node.children, _whoami))
        } else if (child_node.kind === 'record' || child_node.kind === 'nested_record') {

            const user_permissions = child_node.share_permissions as KeeperUserSharePermissions;
            const users = user_permissions.users;

            const find_owner = users?.find(user => user.email === _whoami.user && user.permissions.includes('OW'));

            if(find_owner){
                let record_category = ''

                if (child_node.kind == 'record') {
                    record_category = 'classic'
                } else {
                    record_category = 'nested'
                }
    
                const keeper_record: any = {
                    record_uid: child_node.uid || '',
                    record_uid_perm: child_node.uid || '',
                    permission: '',
                    title: child_node.name,
                    record_category: record_category,
                    type: child_node.record_type ?? '',
                    path: child_node.path,
                    user_permissions: user_permissions,
                }
    
                records.push(keeper_record)
            }
        }
    }

    return records
}

export function getRecordList(_vaultTree: KeeperVaultTreeData, _whoami: WhoamiInfo): KeeperRecord[] {
    const vtree = _vaultTree.tree
    // share_permissions_key.classic / .nsf are maps { code: label }, not arrays
    const classic_permissions = _vaultTree.share_permissions_key.classic
    const nsf_permissions = _vaultTree.share_permissions_key.nsf

    const children = vtree.children || []
    const filter_records = getChildrenRecords(children, _whoami)

    const sail_entitlements: KeeperRecord[] = []

    for (const record of filter_records) {
        const user_permissions = record.user_permissions;
        const lusers = user_permissions.users;
        if (record.record_category === 'classic') {



            for (const permission of Object.keys(classic_permissions)) {      
                
                const get_users = lusers.filter((user: any) => user.permissions.includes(permission)).map((user: any) => user.email);

                sail_entitlements.push({
                    record_uid: record.record_uid,
                    record_uid_perm: record.record_uid+':'+permission,
                    title: record.title,
                    record_category: record.record_category,
                    type: record.type,
                    path: record.path,
                    permission: classic_permissions[permission],
                    users: get_users,
                })
            }
        } else {
            for (const permission of Object.keys(nsf_permissions)) {
                const get_users = lusers.filter((user: any) => user.permissions.includes(permission)).map((user: any) => user.email);

                sail_entitlements.push({
                    record_uid: record.record_uid,
                    record_uid_perm: record.record_uid+':'+permission,
                    title: record.title,
                    record_category: record.record_category,
                    type: record.type,
                    path: record.path,
                    permission: nsf_permissions[permission],
                    users: get_users,
                })
            }
        }
    }

    return sail_entitlements
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

function toKeeperFolder(node: KeeperVaultTreeNode, parentId: string | undefined, folderType: KeeperFolderType): KeeperFolder {
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
 * Keeper enterprise users belong to exactly one node. Accept a single id
 * (string or one-element array) and reject empty / multiple values.
 */
export function requireSingleNodeId(
    value: unknown,
    emptyMessage = 'attribute "node" cannot be empty'
): string {
    const values = coerceNonEmptyStrings(value)
    if (values.length === 0) {
        throw new ConnectorError(emptyMessage)
    }
    if (values.length > 1) {
        throw new ConnectorError(
            `node is single-valued; expected one node id, got ${values.length}`
        )
    }
    return values[0]
}
