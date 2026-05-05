import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentFailureState,
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-failure-state lifecycle hook tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent_failure_state lifecycle hook — close/cancel clears openAutoIssueId", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-failure-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentFailureState);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });

    return { companyId, agentId, runId };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("closing auto-issue clears openAutoIssueId", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Auto adapter failure",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      idempotencyKey: `auto-adapter-failure:${agentId}`,
    });
    await db.insert(agentFailureState).values({
      agentId,
      consecutiveAdapterFailures: 2,
      firstFailureRunId: runId,
      lastFailureRunId: runId,
      openAutoIssueId: issueId,
    });

    const app = createApp(companyId);
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(agentFailureState)
      .where(eq(agentFailureState.agentId, agentId));
    expect(row.openAutoIssueId).toBeNull();
    // Counter and run-id anchors must NOT be touched
    expect(row.consecutiveAdapterFailures).toBe(2);
    expect(row.firstFailureRunId).toBe(runId);
    expect(row.lastFailureRunId).toBe(runId);
  });

  it("cancelling auto-issue clears openAutoIssueId", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Auto adapter failure",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      idempotencyKey: `auto-adapter-failure:${agentId}`,
    });
    await db.insert(agentFailureState).values({
      agentId,
      consecutiveAdapterFailures: 3,
      firstFailureRunId: runId,
      lastFailureRunId: runId,
      openAutoIssueId: issueId,
    });

    const app = createApp(companyId);
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(agentFailureState)
      .where(eq(agentFailureState.agentId, agentId));
    expect(row.openAutoIssueId).toBeNull();
    expect(row.consecutiveAdapterFailures).toBe(3);
    expect(row.firstFailureRunId).toBe(runId);
    expect(row.lastFailureRunId).toBe(runId);
  });

  it("closing non-auto-issue does not touch agent_failure_state", async () => {
    const { companyId, agentId, runId } = await seed();
    const autoIssueId = randomUUID();
    const regularIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: autoIssueId,
        companyId,
        title: "Auto issue (open)",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        idempotencyKey: `auto-adapter-failure:${agentId}`,
      },
      {
        id: regularIssueId,
        companyId,
        title: "Regular issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(agentFailureState).values({
      agentId,
      consecutiveAdapterFailures: 2,
      firstFailureRunId: runId,
      lastFailureRunId: runId,
      openAutoIssueId: autoIssueId,
    });

    const app = createApp(companyId);
    const res = await request(app)
      .patch(`/api/issues/${regularIssueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(agentFailureState)
      .where(eq(agentFailureState.agentId, agentId));
    // openAutoIssueId should still point to the auto-issue, untouched
    expect(row.openAutoIssueId).toBe(autoIssueId);
  });

  it("no-op when no matching agent_failure_state row exists", async () => {
    const { companyId, agentId } = await seed();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphaned auto issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      idempotencyKey: `auto-adapter-failure:${agentId}`,
    });
    // No agent_failure_state row — agent was deleted/recreated

    const app = createApp(companyId);
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    // Just verifies no crash — no row to check
  });
});
