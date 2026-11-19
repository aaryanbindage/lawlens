// Production account store: MongoDB (e.g. a free Atlas M0 cluster), selected when MONGODB_URI is set.
import { MongoClient, ObjectId } from 'mongodb';

export async function createMongoStore(uri) {
  const client = new MongoClient(uri, { appName: 'lawlens' });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'lawlens');
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const history = db.collection('history');

  await Promise.all([
    // Emails are stored lowercased, so a plain unique index enforces case-insensitive uniqueness.
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ token: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }), // MongoDB deletes expired sessions itself
    history.createIndex({ userId: 1, key: 1 }, { unique: true }),
    history.createIndex({ userId: 1, updatedAt: -1 }),
  ]);

  const toUser = (d) => d && { id: String(d._id), email: d.email, name: d.name, pwHash: d.pwHash, salt: d.salt, settings: d.settings || {} };
  const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

  return {
    kind: 'mongodb',
    async findUserByEmail(email) {
      return toUser(await users.findOne({ email: email.toLowerCase() }));
    },
    async createUser({ email, name, pwHash, salt }) {
      const doc = { email: email.toLowerCase(), name, pwHash, salt, settings: {}, createdAt: new Date() };
      const { insertedId } = await users.insertOne(doc);
      return toUser({ ...doc, _id: insertedId });
    },
    async updateSettings(userId, settings) {
      await users.updateOne({ _id: oid(userId) }, { $set: { settings } });
    },
    async createSession(token, userId, expiresAt) {
      await sessions.insertOne({ token, userId: oid(userId), expiresAt: new Date(expiresAt) });
    },
    async userForSession(token) {
      const s = await sessions.findOne({ token, expiresAt: { $gt: new Date() } });
      return s ? toUser(await users.findOne({ _id: s.userId })) : null;
    },
    async deleteSession(token) {
      await sessions.deleteOne({ token });
    },
    async listHistory(userId, limit) {
      const docs = await history.find({ userId: oid(userId) }, { projection: { _id: 0, userId: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray();
      return docs;
    },
    async upsertHistory(userId, it) {
      const { openedAt, ...fields } = it;
      try {
        // Only overwrite with newer progress, so a stale tab can't roll back where you got to.
        await history.updateOne(
          { userId: oid(userId), key: it.key, updatedAt: { $lte: it.updatedAt } },
          { $set: fields, $setOnInsert: { openedAt } },
          { upsert: true },
        );
      } catch (err) {
        if (err.code !== 11000) throw err; // a newer entry already exists — keep it
      }
    },
    async deleteHistory(userId, key) {
      await history.deleteMany(key ? { userId: oid(userId), key } : { userId: oid(userId) });
    },
  };
}
