import { expect, it } from "vitest";
import { api, describeE2e, poll, useProject, versionIds } from "../../e2e";

// Long enough that deploy cuts the generated name to the 54 character limit.
const longId = "subdomainworkerwithanidlongerthanthenamelimit";

const workerModule = (id: string, url: boolean) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

  export const worker = $worker({ id: "${id}", compatibilityDate: "2026-10-12", url: ${url} });

  export default {
    async fetch() {
      return new Response("${id}");
    },
  } satisfies WorkerHandler<typeof worker>;
`;

describeE2e("WorkerSubdomain", () => {
  const project = useProject();
  const names: Record<string, string> = {};

  it("serves a Worker whose generated name has 54 characters on workers.dev", async () => {
    project.write("runtime/long.ts", workerModule(longId, true));
    project.write("runtime/hidden.ts", workerModule("hidden", false));
    await project.notation("deploy");
    for (const name of await project.workerNames()) {
      names[name.startsWith(`${project.scope}hidden-`) ? "hidden" : "long"] =
        name;
    }

    expect(names.long).toHaveLength(54);
    expect(await poll(`${project.url(names.long!)}/`)).toMatchObject({
      ok: true,
      body: longId,
    });
  });

  it("serves the Worker at the preview URL of its version, whose label has 63 characters", async () => {
    const [version] = await versionIds(names.long!);
    const label = `${version!.slice(0, 8)}-${names.long}`;
    expect(label).toHaveLength(63);
    expect(
      await poll(`https://${label}.${project.subdomain}.workers.dev/`),
    ).toMatchObject({ ok: true, body: longId });
  });

  it("leaves a Worker with url: false off workers.dev", async () => {
    const state = await api(
      "GET",
      `/workers/scripts/${names.hidden}/subdomain`,
    );
    expect(state.result).toMatchObject({ enabled: false });
  });
});
