import { expect, it } from "vitest";
import { describeE2e, poll, useProject } from "../../e2e";

// Resources that infra constructs at the top level, with no group.
const infra = `
  import * as cloudflare from "@notation/cloudflare/resources";
  import * as std from "@notation/std/resources";

  const code = new std.fs.File("worker:loose:code", {
    config: { filePath: "code/loose.js" },
  });
  const script = new cloudflare.workers.WorkerScript("worker:loose", {
    config: { CompatibilityDate: "2026-10-12" },
    dependencies: { code },
  });
  new cloudflare.workers.WorkerSubdomain("worker:loose:subdomain", {
    dependencies: { script },
  });
`;

describeE2e("WorkerScript in no group", () => {
  const project = useProject();

  it("deploys a Worker that infra constructs at the top level", async () => {
    project.write(
      "code/loose.js",
      `export default { fetch: () => new Response("loose") };`,
    );
    project.write("infra/main.ts", infra);
    await project.notation("deploy");

    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${project.scope}loose-`));
    expect(await poll(`${project.url(names[0]!)}/`)).toMatchObject({
      ok: true,
      body: "loose",
    });
  });
});
