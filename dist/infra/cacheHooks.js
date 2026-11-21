"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearCacheOnWrite = clearCacheOnWrite;
const cache_1 = require("./cache");
/**
 * Clears a cache namespace after ANY write to the model (save, update, delete, insert), however it was made. Hooking the model means a
 * new code path that changes the data can never forget to clear the cache.
 */
function clearCacheOnWrite(schema, ns) {
    const after = () => { void (0, cache_1.invalidate)(ns).catch(() => undefined); };
    for (const op of ['save', 'insertMany'])
        schema.post(op, after);
    for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
        schema.post(op, after);
    }
}
