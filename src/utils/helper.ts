import { KeeperRecord, KeeperVaultTreeData, KeeperVaultTreeNode } from '../model/keeper-entities'

function getChildrenRecords(childrenNode: KeeperVaultTreeNode[]): KeeperRecord[] {
    const records: KeeperRecord[] = []

    for (const child_node of childrenNode) {
        if ((child_node.kind === 'shared_folder' || child_node.kind === 'folder') && child_node.children !== undefined) {
            records.push(...getChildrenRecords(child_node.children))
        } else if (child_node.kind === 'record' || child_node.kind === 'nested_record') {
            let record_category = ''

            if (child_node.kind == 'record') {
                record_category = 'classic'
            } else {
                record_category = 'nested'
            }

            const keeper_record: KeeperRecord = {
                record_uid: child_node.uid || '',
                record_uid_perm: child_node.uid || '',
                permission: '',
                title: child_node.name,
                record_category: record_category,
                type: child_node.record_type ?? '',
                path: child_node.path,
            }

            records.push(keeper_record)
        }
    }

    return records
}

export function getRecordList(_vaultTree: KeeperVaultTreeData): KeeperRecord[] {
    const vtree = _vaultTree.tree
    // share_permissions_key.classic / .nsf are maps { code: label }, not arrays
    const classic_permissions = _vaultTree.share_permissions_key.classic
    const nsf_permissions = _vaultTree.share_permissions_key.nsf

    const children = vtree.children || []
    const filter_records = getChildrenRecords(children)

    const sail_entitlements: KeeperRecord[] = []

    for (const record of filter_records) {
        if (record.record_category === 'classic') {
            for (const permission of Object.keys(classic_permissions)) {

                sail_entitlements.push({
                    record_uid: record.record_uid,
                    record_uid_perm: record.record_uid+':'+permission,
                    title: record.title,
                    record_category: record.record_category,
                    type: record.type,
                    path: record.path,
                    permission: classic_permissions[permission],
                })
            }
        } else {
            for (const permission of Object.keys(nsf_permissions)) {

                sail_entitlements.push({
                    record_uid: record.record_uid,
                    record_uid_perm: record.record_uid+':'+permission,
                    title: record.title,
                    record_category: record.record_category,
                    type: record.type,
                    path: record.path,
                    permission: nsf_permissions[permission],
                })
            }
        }
    }

    return sail_entitlements
}
