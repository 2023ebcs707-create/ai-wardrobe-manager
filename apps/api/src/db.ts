import mongoose from 'mongoose';
import type { ServiceStatus } from '@wardrobe/shared';

export async function connectDatabase(url: string): Promise<void> {
  await mongoose.connect(url, { serverSelectionTimeoutMS: 5000 });
}

export async function databaseStatus(): Promise<ServiceStatus> {
  try {
    const db = mongoose.connection.db;
    if (!db) return 'down';
    await db.admin().command({ ping: 1 });
    return 'ok';
  } catch {
    return 'down';
  }
}
