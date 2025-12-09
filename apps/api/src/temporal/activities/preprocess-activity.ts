import { db } from '../../db';
import * as schema from '../../db/schema';
import { eq, and, or, lt } from 'drizzle-orm';
import { agentStreamManager } from '../../services/agent-stream-manager';
import { BackendStreamMessageType } from '@sia/models';

export async function preprocessActivity(params: { agentId: string }): Promise<{
  jobId: string | null;
  queueType: 'rework' | 'backlog' | null;
  orgId: string | null;
}> {
  const { agentId } = params;

  // Get agent info
  const agent = await db.query.agents.findFirst({
    where: eq(schema.agents.id, agentId),
  });

  if (!agent || agent.status !== 'active') {
    return { jobId: null, queueType: null, orgId: null };
  }

  const orgId = agent.orgId;

  // 1. Check for orphan jobs (stuck jobs)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const orphanJobs = await db
    .select()
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.orgId, orgId),
        eq(schema.jobs.status, 'in-progress'),
        or(
          eq(schema.jobs.agentId, agentId),
          lt(schema.jobs.updatedAt, fiveMinutesAgo)
        )
      )
    );

  for (const job of orphanJobs) {
    await db
      .update(schema.jobs)
      .set({
        status: 'queued',
        agentId: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
  }

  // 2. Check if agent has job in progress
  const inProgressJob = await db.query.jobs.findFirst({
    where: and(
      eq(schema.jobs.agentId, agentId),
      eq(schema.jobs.status, 'in-progress')
    ),
  });

  if (inProgressJob) {
    // Send heartbeat
    const stream = agentStreamManager.getStream(agentId);
    if (stream) {
      stream.write({
        messageType: BackendStreamMessageType.HEALTH_CHECK_PING,
        payload: Buffer.from(JSON.stringify({ timestamp: Date.now() })),
      });
    }

    // Update agent status
    await db
      .update(schema.agents)
      .set({
        lastActive: new Date(),
        consecutiveFailures: 0,
        updatedAt: new Date(),
      })
      .where(eq(schema.agents.id, agentId));

    return { jobId: null, queueType: null, orgId };
  }

  // 3. Check if queues are paused
  const queueTypes: Array<'rework' | 'backlog'> = ['rework', 'backlog'];

  for (const queueType of queueTypes) {
    const queueStatus = await db.query.queueStatus.findFirst({
      where: and(
        eq(schema.queueStatus.orgId, orgId),
        eq(schema.queueStatus.queueType, queueType)
      ),
    });

    if (queueStatus?.isPaused) {
      continue;
    }

    // Get lowest priority job (highest orderInQueue value)
    const nextJob = await db.query.jobs.findFirst({
      where: and(
        eq(schema.jobs.orgId, orgId),
        eq(schema.jobs.status, 'queued'),
        eq(schema.jobs.queueType, queueType)
      ),
      orderBy: (jobs, { asc }) => [asc(jobs.orderInQueue)],
    });

    if (nextJob) {
      // Claim the job
      await db
        .update(schema.jobs)
        .set({
          status: 'in-progress',
          agentId,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, nextJob.id));

      return { jobId: nextJob.id, queueType, orgId };
    }
  }

  return { jobId: null, queueType: null, orgId };
}
