import { db, updateCustomGroupChannelsBatch, type CustomGroup, type CustomGroupChannel } from '../db';


/**
 * Create a new custom group
 */
export async function createCustomGroup(name: string): Promise<string> {
    const groupId = crypto.randomUUID();
    const count = await db.customGroups.count();

    await db.customGroups.add({
        group_id: groupId,
        name,
        display_order: count,
        created_at: Date.now()
    });

    return groupId;
}

/**
 * Delete a custom group and all its channel mappings
 */
export async function deleteCustomGroup(groupId: string): Promise<void> {
    await db.transaction('rw', [db.customGroups, db.customGroupChannels], async () => {
        await db.customGroupChannels.where('group_id').equals(groupId).delete();
        await db.customGroups.delete(groupId);
    });
}

/**
 * Rename a custom group
 */
export async function renameCustomGroup(groupId: string, newName: string): Promise<void> {
    await db.customGroups.update(groupId, { name: newName });
}

/**
 * Add channels to a custom group
 */
export async function addChannelsToGroup(groupId: string, streamIds: string[]): Promise<void> {
    await db.transaction('rw', [db.customGroupChannels], async () => {
        // Query existing group channels to prevent duplicates
        const existing = await db.customGroupChannels.where('group_id').equals(groupId).toArray();
        const existingSet = new Set(existing.map(e => e.stream_id));
        const uniqueStreamIds = streamIds.filter(id => !existingSet.has(id));
        if (uniqueStreamIds.length === 0) return;

        let nextOrder = 0;
        for (const item of existing) {
            if (item.display_order != null && item.display_order >= nextOrder) {
                nextOrder = item.display_order + 1;
            }
        }

        const now = Date.now();
        const items: CustomGroupChannel[] = uniqueStreamIds.map((streamId, index) => ({
            group_id: groupId,
            stream_id: streamId,
            display_order: nextOrder + index,
            added_at: now
        }));

        await db.customGroupChannels.bulkAdd(items);
    });
}

/**
 * Remove channels from a custom group
 */
export async function removeChannelsFromGroup(groupId: string, streamIds: string[]): Promise<void> {
    await db.transaction('rw', [db.customGroupChannels], async () => {
        // Fetch specific entries since .and() is not supported in our adapter
        const groupChannels = await db.customGroupChannels.where('group_id').equals(groupId).toArray();
        const idsToDelete = groupChannels
            .filter(c => streamIds.includes(c.stream_id))
            .map(c => c.id as number);

        if (idsToDelete.length > 0) {
            await db.customGroupChannels.bulkDelete(idsToDelete);
        }
    });
}

/**
 * Reorder channels in a custom group
 */
export async function reorderGroupChannels(groupId: string, orderedStreamIds: string[]): Promise<void> {
    await db.transaction('rw', [db.customGroupChannels], async () => {
        const items = await db.customGroupChannels.where('group_id').equals(groupId).toArray();
        const itemMap = new Map(items.map(i => [i.stream_id, i]));

        const updates = orderedStreamIds
            .map((streamId, i) => {
                const item = itemMap.get(streamId);
                return item && item.id !== undefined ? { id: item.id, displayOrder: i } : null;
            })
            .filter(Boolean) as Array<{ id: number; displayOrder: number }>;

        if (updates.length > 0) {
            await updateCustomGroupChannelsBatch(updates);
        }
    });
}
