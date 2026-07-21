import { logger, StdAccountListOutput, StdEntitlementListOutput } from '@sailpoint/connector-sdk'
import { KeeperNode, KeeperRecord, KeeperRole, KeeperTeam, KeeperUser } from '../model/keeper-entities'

export const KEEPER_NODE_PATH_SEPARATOR = '\\'

/** Keeper user statuses that we treat as "not disabled" for ISC. */
const ACTIVE_LIKE_STATUSES = new Set(['Active', 'Invited'])

export interface KeeperIdMaps {
    /** Full node path -> node_id (as string). */
    nodePathToId: Map<string, string>
    /** Team display name -> team_uid. */
    teamNameToUid: Map<string, string>
    /** Role display name -> role_id (as string). */
    roleNameToId: Map<string, string>
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

export function buildIdMaps(nodes: KeeperNode[], teams: KeeperTeam[], roles: KeeperRole[]): KeeperIdMaps {
    const nodePathToId = buildNodePathMap(nodes)

    const teamNameToUid = new Map<string, string>()
    for (const team of teams) {
        if (!team.name || !team.team_uid) continue
        registerFirstOrWarn(teamNameToUid, team.name, team.team_uid, 'team')
    }

    const roleNameToId = new Map<string, string>()
    for (const role of roles) {
        if (!role.name || role.role_id == null) continue
        registerFirstOrWarn(roleNameToId, role.name, String(role.role_id), 'role')
    }

    return { nodePathToId, teamNameToUid, roleNameToId }
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
    const id = String(record.record_uid)
    return {
        identity: id,
        uuid: id,
        type: 'record',
        
        attributes: {
            id,
            name: record.title ?? '',
            record_category: record.record_category ?? '',
            record_uid: id,
            type: record.type ?? '',
        },
    }
}

export function toTeamEntitlement(team: KeeperTeam, nodePathToId: Map<string, string>): StdEntitlementListOutput {
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

export function toAccount(user: KeeperUser, maps: KeeperIdMaps): StdAccountListOutput {
    const nodePath = user.node ?? null
    const nodeId = nodePath ? maps.nodePathToId.get(nodePath) ?? null : null

    const teamUids = translateNames(
        user.teams ?? [],
        maps.teamNameToUid,
        (name) => `Keeper team "${name}" on user ${user.email} not found in team catalog; skipping`
    )
    const roleIds = translateNames(
        user.roles ?? [],
        maps.roleNameToId,
        (name) => `Keeper role "${name}" on user ${user.email} not found in role catalog; skipping`
    )

    const status = user.status ?? ''
    const disabled = status !== '' && !ACTIVE_LIKE_STATUSES.has(status)

    return {
        identity: user.email,
        uuid: String(user.user_id),
        disabled,
        attributes: {
            userId: String(user.user_id),
            email: user.email,
            name: user.name ?? '',
            status,
            jobTitle: user.job_title ?? '',
            twoFactorEnabled: user['2fa_enabled'] ?? false,
            aliases: user.alias ?? [],
            nodePath,
            node: nodeId,
            teams: teamUids,
            roles: roleIds,
        },
    }
}

function translateNames(names: string[], nameToId: Map<string, string>, missingMsg: (name: string) => string): string[] {
    const result: string[] = []
    for (const name of names) {
        const id = nameToId.get(name)
        if (id) {
            result.push(id)
        } else {
            logger.warn(missingMsg(name))
        }
    }
    return result
}
