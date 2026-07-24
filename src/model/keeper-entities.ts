/**
 * Response shapes for Keeper Commander `enterprise-info --format json` commands.
 * Only fields consumed by the connector are declared.
 */

export interface KeeperUser {
    user_id: number
    email: string
    name?: string
    status?: string
    transfer_status?: string
    node?: string
    team_count?: number
    /** Team memberships as `team_uid` values (stable IDs). */
    teams?: string[]
    role_count?: number
    /** Role memberships as `role_id` values serialized as strings. */
    roles?: string[]
    alias?: string[]
    job_title?: string
    /** Raw JSON key starts with a digit; must be quoted. */
    '2fa_enabled'?: boolean
}

export interface KeeperTeam {
    team_uid: string
    name: string
    /** Raw restrict flags, e.g. "  W S". Decoded fields may be added later. */
    restricts?: string
    /** Full node path. */
    node?: string
    user_count?: number
    /** Emails of active users on the team. */
    users?: string[]
    queued_user_count?: number
    queued_users?: string[]
    role_count?: number
    /** Names of roles assigned to the team. */
    roles?: string[]
}

export interface KeeperRole {
    role_id: number
    name: string
    visible_below?: boolean
    default_role?: boolean
    admin?: boolean
    /** Full node path. */
    node?: string
    user_count?: number
    /** Emails of users with this role directly assigned. */
    users?: string[]
    team_count?: number
    /** Names of teams assigned to this role. */
    teams?: string[]
}

export interface KeeperNode {
    node_id: number
    name: string
    /** Parent node's full path (absent for root nodes). */
    parent_node?: string
    parent_id?: number
    user_count?: number
    users?: string[]
    team_count?: number
    teams?: string[]
    role_count?: number
    roles?: string[]
    isolated?: boolean
    provisioning?: unknown
}

/**
 * Flat record used by entitlement mapping (normalized from vault tree nodes).
 */
export interface KeeperRecord {
    record_uid: string
    record_uid_perm: string
    title: string
    record_category: string
    type: string
    path:string
    permission: string
    users?: string[]
}

export type KeeperFolderType = 'classic' | 'nsf'

export interface KeeperFolder {
    uid: string
    name: string
    path: string
    folderType: KeeperFolderType
    parentId?: string
    /** Filled later when membership discovery exists */
    users?: string[]
    teams?: string[]
}

// -------------------- Vault tree (`tree -s -ns -r -v --format json`) --------------------

/** Root-level code → label map (`data.share_permissions_key`). */
export interface KeeperSharePermissionsKey {
    classic: { [key: string]: string }
    nsf: { [key: string]: string }
}

export interface KeeperShareUser {
    email: string
    permissions: string[]
}

/** classic `shared_folder` ACL. */
export interface KeeperFolderSharePermissions {
    record_permissions?: string[]
    user_permissions?: string[]
}

/** `record` / `nested_record` / `nested_share_folder` ACL. */
export interface KeeperUserSharePermissions {
    users?: KeeperShareUser[]
}

/**
 * Recursive vault tree node (`data.tree` and each entry in `children`).
 * `children` is an array of nodes, not a string dictionary.
 */
export interface KeeperVaultTreeNode {
    kind: string
    name: string
    path: string
    uid?: string
    record_type?: string
    share_permissions?: KeeperFolderSharePermissions | KeeperUserSharePermissions
    children?: KeeperVaultTreeNode[]
}

/** Parsed `data` payload from the vault tree command. */
export interface KeeperVaultTreeData {
    share_permissions_key: KeeperSharePermissionsKey
    tree: KeeperVaultTreeNode
}

