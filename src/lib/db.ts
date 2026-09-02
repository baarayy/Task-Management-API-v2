import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string = env.MONGO_URI): Promise<typeof mongoose> {
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    minPoolSize: 2,
  });
  logger.info('MongoDB connected');
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.connection.close();
}

/**
 * Transactions require a replica set. A standalone mongo (the default in local
 * docker and in mongodb-memory-server) does not support them, so callers fall
 * back to running the same work without a session rather than failing outright.
 */
export function supportsTransactions(): boolean {
  const topology = (
    mongoose.connection as unknown as {
      client?: { topology?: { description?: { type?: string } } };
    }
  ).client?.topology?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
