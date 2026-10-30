// Starts a throwaway two-node replica set (in-memory, local only) in its own process and prints its connection string on one line,
// once it is really ready: one primary, one caught-up secondary. It runs outside Jest because the in-memory server's own client
// does not initialise inside Jest's sandbox.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 2, storageEngine: 'wiredTiger' } });
  const uri = rs.getUri();
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 30000 });
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const st = await client.db('admin').command({ replSetGetStatus: 1 });
      const states = st.members.map((m) => m.stateStr).sort();
      if (states.length === 2 && states[0] === 'PRIMARY' && states[1] === 'SECONDARY') {
        // a majority-acknowledged write proves the secondary is caught up
        await client.db('admin').collection('ready').insertOne({ at: new Date() }, { writeConcern: { w: 'majority', wtimeout: 10000 } });
        break;
      }
    } catch { /* still electing */ }
    if (Date.now() > deadline) throw new Error('replica set did not become healthy');
    await new Promise((r) => setTimeout(r, 300));
  }
  await client.close();
  console.log('URI ' + uri);
  const stop = async () => { try { await rs.stop(); } finally { process.exit(0); } };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.stdin.resume();
})().catch((e) => { console.error('REPLSET FAILED ' + e.message); process.exit(1); });
