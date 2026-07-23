import { KeeperVaultTreeData, KeeperVaultTreeNode } from '../model/keeper-entities'

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
