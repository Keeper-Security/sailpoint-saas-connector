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
    /** Full node path, e.g. "Metron Security\\Metronlabs". */
    node?: string
    team_count?: number
    /** Team display names (not team_uid). */
    teams?: string[]
    role_count?: number
    /** Role display names (not role_id). */
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

export interface KeeperRecord {
    record_uid: string
    title: string
    record_category: string
    type: string
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
