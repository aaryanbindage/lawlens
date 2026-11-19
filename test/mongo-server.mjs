// Starts a throwaway MongoDB and prints its URI, for testing the MongoDB account store locally.
import { MongoMemoryServer } from 'mongodb-memory-server';
const mongod = await MongoMemoryServer.create();
console.log(mongod.getUri());
process.on('SIGTERM', () => mongod.stop().then(() => process.exit(0)));
setInterval(() => {}, 1 << 30);
