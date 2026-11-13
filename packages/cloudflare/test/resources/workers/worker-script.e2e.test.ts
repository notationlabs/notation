import { expect, it } from "vitest";
import { describeE2e, poll, useProject, versionIds } from "../../e2e";

// Long enough that deploy cuts the generated name to the 54 character limit.
const id = "scriptworkerwithanidlongerthanthenamelimit";

// A Worker that binds itself. "/self" calls the Worker through the binding.
const workerModule = (reply: string) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

  export const worker = $worker({
    id: "${id}",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ SELF: worker }),
  });

  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/self") {
        return new Response("self: " + (await (await env.SELF.fetch(new URL("/", url))).text()));
      }
      return new Response("${reply}");
    },
  } satisfies WorkerHandler<typeof worker>;
`;

describeE2e("WorkerScript", () => {
  const project = useProject();
  let name: string;

  it("creates a Worker whose generated name is cut to 54 characters", async () => {
    project.write("runtime/worker.ts", workerModule("v1"));
    await project.notation("deploy");

    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    name = names[0]!;
    expect(name).toMatch(
      new RegExp(`^${project.scope}scriptworker[a-z]+-[0-9a-f]{8}$`),
    );
    expect(name).toHaveLength(54);
    expect(await poll(`${project.url(name)}/`)).toMatchObject({
      ok: true,
      body: "v1",
    });
  });

  it("creates a Worker that binds itself in one upload", async () => {
    expect(await versionIds(name)).toHaveLength(1);
    expect(await poll(`${project.url(name)}/self`)).toMatchObject({
      ok: true,
      body: "self: v1",
    });
  });

  it("uploads a new version of the Worker, under the same name, when its code changes", async () => {
    project.write("runtime/worker.ts", workerModule("v2"));
    await project.notation("deploy");

    expect(await project.workerNames()).toEqual([name]);
    expect(await versionIds(name)).toHaveLength(2);
    expect(
      await poll(`${project.url(name)}/`, {
        done: (fetched) => fetched.body === "v2",
      }),
    ).toMatchObject({ ok: true, body: "v2" });
  });
});
