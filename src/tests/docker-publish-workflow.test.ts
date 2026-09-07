import { describe, expect, test } from "bun:test";

type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  "continue-on-error"?: boolean;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  needs?: string[];
  steps: WorkflowStep[];
};

type DockerWorkflow = {
  on: { push: { paths: string[] } };
  jobs: Record<string, WorkflowJob>;
};

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/docker-and-deploy.yml", import.meta.url)).text(),
) as DockerWorkflow;

const releaseOnly = "steps.check.outputs.version_changed == 'true'";

describe("Docker publish workflow", () => {
  test("a Dockerfile.worker-only push publishes the full multi-arch worker", () => {
    expect(workflow.on.push.paths).toContain("Dockerfile.worker");

    const detectSteps = workflow.jobs["detect-version-change"].steps;
    const detectionIndex = detectSteps.findIndex((step) => step.id === "check");
    const setupIndex = detectSteps.findIndex((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    const syncIndex = detectSteps.findIndex(
      (step) => step.run === "bun run sync-chart-version --check",
    );
    expect(detectionIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(detectionIndex);
    expect(syncIndex).toBeGreaterThan(setupIndex);
    expect(detectSteps[syncIndex].if).toBe(releaseOnly);

    for (const architecture of ["amd64", "arm64"]) {
      const job = workflow.jobs[`build-and-push-worker-${architecture}`];
      expect(job.if).toBeUndefined();
      expect(job.needs).toEqual(["detect-version-change"]);
      expect(job.steps.find((step) => step.id === "build")?.with?.target).toBe("worker-full");
    }

    const merge = workflow.jobs["merge-worker"];
    expect(merge.if).toBeUndefined();
    expect(merge.needs).toEqual([
      "detect-version-change",
      "build-and-push-worker-amd64",
      "build-and-push-worker-arm64",
    ]);
    const tags = String(merge.steps.find((step) => step.id === "meta")?.with?.tags);
    expect(tags).toContain("type=raw,value=latest");
    expect(tags).toContain("type=sha");

    const publish = merge.steps.find((step) => step.run?.includes("imagetools create"))?.run;
    expect(publish).toContain("docker buildx imagetools create");
    expect(publish).toContain("needs.build-and-push-worker-amd64.outputs.digest");
    expect(publish).toContain("needs.build-and-push-worker-arm64.outputs.digest");
  });

  test("a version-changing release keeps chart sync blocking every image build", () => {
    const detectSteps = workflow.jobs["detect-version-change"].steps;
    expect(detectSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.if).toBe(
      releaseOnly,
    );
    const sync = detectSteps.find((step) => step.run === "bun run sync-chart-version --check");
    expect(sync?.if).toBe(releaseOnly);
    expect(sync?.run).toBe("bun run sync-chart-version --check");
    expect(sync?.["continue-on-error"]).toBeUndefined();

    for (const jobName of [
      "build-and-push-server-amd64",
      "build-and-push-server-arm64",
      "build-and-push-worker-amd64",
      "build-and-push-worker-arm64",
      "build-and-push-worker-slim-amd64",
      "build-and-push-worker-slim-arm64",
    ]) {
      expect(workflow.jobs[jobName].needs).toContain("detect-version-change");
    }
  });

  test("a fork never enters the upstream deployment job", () => {
    expect(workflow.jobs.deploy.if).toBe("github.repository == 'desplega-ai/agent-swarm'");

    const jobsUsingDokploy = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps.some((step) => step.uses?.startsWith("tarasyarema/dokploy-deploy-action@")),
    );
    expect(jobsUsingDokploy.map(([name]) => name)).toEqual(["deploy"]);
  });
});
