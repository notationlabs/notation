import * as lambda from "@aws-sdk/client-lambda";
import { expect, it } from "vitest";
import { clients, describeE2e, functionsWithPrefix, useProject } from "./e2e";

describeE2e("lambda() with a bundle", () => {
  const project = useProject();

  // The handler imports a module that the infra code generates, and a
  // module of the project.
  function writeProject(greeting: string) {
    project.write("lib/name.ts", `export const name = "bundle";`);
    project.write(
      "lib/handler.ts",
      `
      import greeting from "virtual:greeting";
      import { name } from "./name";

      export const handler = async () => ({ message: \`\${greeting} from \${name}\` });
      `,
    );
    project.write(
      "infra/main.ts",
      `
      import { bundle } from "@notation/build/resources";
      import { lambda } from "@notation/aws/lambda";

      const code = bundle({
        id: "greeter",
        platform: "node",
        entry: "lib/handler.ts",
        modules: { "virtual:greeting": ${JSON.stringify(`export default ${JSON.stringify(greeting)};`)} },
      });

      lambda({ id: "greeter", code });
      `,
    );
  }

  async function invoke(): Promise<unknown> {
    const [name] = await functionsWithPrefix(project.scope);
    const result = await clients.lambda.send(
      new lambda.InvokeCommand({ FunctionName: name }),
    );
    return JSON.parse(new TextDecoder().decode(result.Payload));
  }

  it("deploys a Lambda whose code is built at deploy", async () => {
    writeProject("hello");
    await project.notation("deploy");

    expect(await invoke()).toEqual({ message: "hello from bundle" });
    const inputs = JSON.parse(
      project.read("dist/.bundles/greeter/inputs.json"),
    );
    expect(Object.keys(inputs.files)).toEqual(
      expect.arrayContaining(["lib/handler.ts", "lib/name.ts"]),
    );
  });

  it("deploys new code when a generated module changes", async () => {
    writeProject("goodbye");
    await project.notation("deploy");

    expect(await invoke()).toEqual({ message: "goodbye from bundle" });
  });
});
