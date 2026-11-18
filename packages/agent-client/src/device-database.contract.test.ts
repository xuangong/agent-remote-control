import { it } from 'vitest';
import { buildStoredRecord, deviceDatabaseCases, memoryDeviceDatabase } from './testing/index.js';

for (const { name, run } of deviceDatabaseCases) it(`memory device database: ${name}`, () => run(memoryDeviceDatabase, (who, updatedAt) => buildStoredRecord({ nativeSessionId: who, updatedAt })));
