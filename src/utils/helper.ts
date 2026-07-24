import { KeeperRecord, KeeperUserSharePermissions, KeeperVaultTreeData, KeeperVaultTreeNode } from '../model/keeper-entities'
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
