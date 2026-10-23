"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapLimit = mapLimit;
/**
 * Runs `worker` over `items` with at most `limit` in flight at once and returns the results in the order of `items`
 * (not in completion order). A worker that throws rejects the whole call, like a plain loop would.
 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const lane = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
    return results;
}
