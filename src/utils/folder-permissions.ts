import { ConnectorError } from '@sailpoint/connector-sdk'
import { KeeperFolder, KeeperFolderType } from '../model/keeper-entities'

/** Classic: share-folder -o / -p combinations. */
export const CLASSIC_PERMISSIONS = ['NP', 'MU', 'MR', 'MUR'] as const
export type ClassicPermission = (typeof CLASSIC_PERMISSIONS)[number]

/** NSF: nsf-share-folder -r roles (short codes). */
export const NSF_PERMISSIONS = ['V', 'SM', 'CM', 'CSM', 'FM'] as const
export type NsfPermission = (typeof NSF_PERMISSIONS)[number]

export type FolderPermission = ClassicPermission | NsfPermission

export const CLASSIC_PERMISSION_LABELS: Record<ClassicPermission, string> = {
    NP: 'No permissions',
    MU: 'Manage users',
    MR: 'Manage records',
    MUR: 'Manage users & records',
}

export const NSF_PERMISSION_LABELS: Record<NsfPermission, string> = {
    V: 'Viewer',
    SM: 'Share manager',
    CM: 'Content manager',
    CSM: 'Content share manager',
    FM: 'Full manager',
}

export function permissionsForFolderType(folderType: KeeperFolderType): readonly FolderPermission[] {
    return folderType === 'classic' ? CLASSIC_PERMISSIONS : NSF_PERMISSIONS
}

export function permissionLabel(folderType: KeeperFolderType, permission: FolderPermission): string {
    if (folderType === 'classic') {
        return CLASSIC_PERMISSION_LABELS[permission as ClassicPermission] ?? permission
    }
    return NSF_PERMISSION_LABELS[permission as NsfPermission] ?? permission
}

export function toFolderEntitlementId(uid: string, permission: FolderPermission): string {
    return `${uid}:${permission}`
}

/**
 * Parse "<folderUid>:<permission>".
 * Uses lastIndexOf so UIDs that contain ":" still work if that ever happens.
 */
export function parseFolderEntitlementId(identity: string): { uid: string; permission: string } {
    const idx = identity.lastIndexOf(':')
    if (idx <= 0 || idx === identity.length - 1) {
        throw new ConnectorError(
            `Invalid folder entitlement id "${identity}"; expected <folderUid>:<permission>`
        )
    }
    return { uid: identity.slice(0, idx), permission: identity.slice(idx + 1) }
}

export function isValidPermission(folderType: KeeperFolderType, permission: string): boolean {
    return (permissionsForFolderType(folderType) as readonly string[]).includes(permission)
}

/** Classic share-folder -o / -p from NP|MU|MR|MUR. */
export function classicFlags(
    permission: ClassicPermission
): { manageUsers: 'on' | 'off'; manageRecords: 'on' | 'off' } {
    switch (permission) {
        case 'NP':
            return { manageUsers: 'off', manageRecords: 'off' }
        case 'MU':
            return { manageUsers: 'on', manageRecords: 'off' }
        case 'MR':
            return { manageUsers: 'off', manageRecords: 'on' }
        case 'MUR':
            return { manageUsers: 'on', manageRecords: 'on' }
    }
}

/** NSF code → Commander -r value (for provisioning later). */
export function nsfRoleForCode(code: NsfPermission): string {
    const map: Record<NsfPermission, string> = {
        V: 'viewer',
        SM: 'share-manager',
        CM: 'content-manager',
        CSM: 'content-share-manager',
        FM: 'full-manager',
    }
    return map[code]
}

export function expandFolderPermissions(
    folder: KeeperFolder
): Array<{ folder: KeeperFolder; permission: FolderPermission }> {
    return permissionsForFolderType(folder.folderType).map((permission) => ({ folder, permission }))
}