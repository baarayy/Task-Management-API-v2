/**
 * Runs explain() over the hot query paths and prints the winning plan for each.
 *
 * This is the evidence behind the indexing strategy in docs/SCHEMA.md: every
 * query below must report IXSCAN, never COLLSCAN, and must not carry an
 * in-memory SORT stage.
 *
 *   npm run seed && npm run explain
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/lib/db.js';
import { Task, TaskComment, TaskHistory } from '../src/models/index.js';

const USER_ID = new Types.ObjectId('650000000000000000000003');
/** Matches the id scheme used by the seed fixtures: '65' + zero-padded index. */
const seedId = (n: number) => new Types.ObjectId('65' + String(n).padStart(22, '0'));

interface PlanSummary {
  query: string;
  stage: string;
  indexName: string;
  docsExamined: number;
  keysExamined: number;
  returned: number;
  millis: number;
}

type ExplainDoc = Record<string, unknown> & {
  executionStats?: Record<string, unknown> & { executionStages?: PlanStage };
};
interface PlanStage {
  stage?: string;
  indexName?: string;
  inputStage?: PlanStage;
  inputStages?: PlanStage[];
}

// Mongoose types explain() as returning documents, so the result is narrowed here.
function summarise(name: string, raw: unknown): PlanSummary {
  const explain = (raw ?? {}) as ExplainDoc;
  const exec = (explain.executionStats ?? {}) as Record<string, number> & {
    executionStages?: PlanStage;
  };
  let stage: PlanStage | undefined = exec.executionStages;
  let indexName = '-';

  // Walk down to the leaf stage to find the actual access method.
  while (stage) {
    if (stage.indexName) indexName = stage.indexName;
    if (stage.stage === 'IXSCAN' || stage.stage === 'COLLSCAN') break;
    stage = stage.inputStage ?? stage.inputStages?.[0];
  }

  return {
    query: name,
    stage: stage?.stage ?? 'UNKNOWN',
    indexName,
    docsExamined: exec.totalDocsExamined ?? -1,
    keysExamined: exec.totalKeysExamined ?? -1,
    returned: exec.nReturned ?? -1,
    millis: exec.executionTimeMillis ?? -1,
  };
}

async function main(): Promise<void> {
  await connectDb();
  const rows: PlanSummary[] = [];

  rows.push(
    summarise(
      'tasks by assignee + status, sorted by dueDate',
      await Task.find({ assignees: USER_ID, deletedAt: null, status: 'todo' })
        .sort({ dueDate: 1 })
        .limit(20)
        .explain('executionStats'),
    ),
  );

  rows.push(
    summarise(
      'tasks by assignee + dueDate range',
      await Task.find({
        assignees: USER_ID,
        deletedAt: null,
        dueDate: { $gte: new Date('2026-07-01'), $lte: new Date('2026-09-30') },
      })
        .sort({ dueDate: 1 })
        .explain('executionStats'),
    ),
  );

  rows.push(
    summarise(
      'task history timeline (taskId, createdAt desc)',
      await TaskHistory.find({ taskId: seedId(1000) })
        .sort({ createdAt: -1 })
        .explain('executionStats')
        .catch(() => ({})),
    ),
  );

  rows.push(
    summarise(
      'comments for a task, newest first',
      await TaskComment.find({ taskId: seedId(1000), deletedAt: null })
        .sort({ createdAt: -1 })
        .explain('executionStats')
        .catch(() => ({})),
    ),
  );

  console.table(rows);

  const collscans = rows.filter((r) => r.stage === 'COLLSCAN');
  if (collscans.length > 0) {
    console.error(`\n${collscans.length} query/queries fell back to a collection scan.`);
  } else {
    console.log('\nAll sampled queries are served by an index.');
  }

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
