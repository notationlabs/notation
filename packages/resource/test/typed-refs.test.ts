import { describe, expectTypeOf, it } from "vitest";
import {
  all,
  resource,
  text,
  type CredentialRef,
  type DeepInput,
  type Derived,
  type Input,
  OutputRef,
  type StateRef,
} from "src";
import { number, object, string } from "./validators";

// The type checker checks these tests. A line that would throw at run time
// is in a function that is not called.

type Statement = { Effect: string; Resource: string | string[] };

const Bucket = resource<{
  Key: { Name: string };
  CreateParams: {
    Name: string;
    Versioned?: boolean;
    Statements?: Statement[];
    Target?: { Kind: "queue"; Url: string } | { Kind: "topic"; Arn: string };
  };
  UpdateParams: {
    Versioned?: boolean;
    Statements?: Statement[];
    Target?: { Kind: "queue"; Url: string } | { Kind: "topic"; Arn: string };
  };
  ReadResult: { Arn: string; Alias?: string; Size: number };
}>({ type: "test/typed-refs/bucket", provider: "test" })
  .defineSchema({
    Name: {
      propertyType: "param",
      value: string(),
      presence: "required",
      primaryKey: true,
      immutable: true,
    },
    Versioned: {
      propertyType: "param",
      value: object<boolean>(),
      presence: "optional",
    },
    Statements: {
      propertyType: "param",
      value: object<Statement[]>(),
      presence: "optional",
      collect: (items: any[]) => items.flat(),
    },
    Target: {
      propertyType: "param",
      value: object<
        { Kind: "queue"; Url: string } | { Kind: "topic"; Arn: string }
      >(),
      presence: "optional",
    },
    Arn: { propertyType: "computed", value: string(), presence: "required" },
    Alias: { propertyType: "computed", value: string(), presence: "optional" },
    Size: { propertyType: "computed", value: number(), presence: "required" },
  })
  .defineOperations({
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  });

const Optional = resource<{
  Key: { Id: string };
  CreateParams: { Label?: string };
  UpdateParams: { Label?: string };
  ReadResult: { Id: string };
}>({ type: "test/typed-refs/optional", provider: "test" })
  .defineSchema({
    Id: {
      propertyType: "computed",
      value: string(),
      presence: "required",
      primaryKey: true,
    },
    Label: { propertyType: "param", value: string(), presence: "optional" },
  })
  .defineOperations({
    create: async () => ({ Id: "1" }),
    update: async () => undefined,
    delete: async () => undefined,
  });

const source = new Bucket("source", { config: { Name: "s" } });
const url = source.outputRef("Arn");
const port = source.outputRef("Size");
const optional = source.outputRef("Alias");
const flag = new OutputRef<boolean>(source, ["Versioned"]);
const credential = new OutputRef<string>(source, ["Token"], {
  credential: true,
});
const recorded = source["~state"].outputRef("Name");

describe("output ref types", () => {
  it("types a ref as a ref, and not as its value", () => {
    const bucket = new Bucket("b", { config: { Name: "b" } });
    expectTypeOf(bucket.outputRef("Arn")).toEqualTypeOf<OutputRef<string>>();
    expectTypeOf(bucket.outputRef("Size")).toEqualTypeOf<OutputRef<number>>();
    expectTypeOf(bucket.outputRef("Alias")).toEqualTypeOf<
      OutputRef<string | undefined>
    >();
    expectTypeOf(bucket["~state"].outputRef("Name")).toEqualTypeOf<
      StateRef<string>
    >();
    expectTypeOf(url).not.toMatchTypeOf<string>();
    // @ts-expect-error a ref has no string methods
    () => url.startsWith("https://");
    // @ts-expect-error a ref is not a string
    const asString: string = url;
    // @ts-expect-error a ref doesn't fit a ref of another type
    const asNumber: OutputRef<number> = url;
    void [asString, asNumber];
  });

  it("types Input<string> as a string, a ref or a template, and not a credential or an optional output", () => {
    const inputs: Input<string>[] = [
      "x",
      url,
      text`${url}/x`,
      url.map((value) => value.length.toString()),
      optional.map((value) => value ?? "none"),
    ];
    // @ts-expect-error a credential is not an Input
    const fromCredential: Input<string> = credential;
    // @ts-expect-error an optional output can be undefined
    const fromOptional: Input<string> = optional;
    // @ts-expect-error a ~state ref is not an Input
    const fromState: Input<string> = recorded;
    // @ts-expect-error a ref to a number is not an Input<string>
    const fromNumber: Input<string> = port;
    void [inputs, fromCredential, fromOptional, fromState, fromNumber];
  });

  it("types DeepInput with refs inside arrays and unions of objects", () => {
    const statements: DeepInput<Statement[]> = [
      { Effect: "Allow", Resource: url },
      { Effect: url, Resource: [url, text`${url}/*`] },
    ];
    const target: DeepInput<
      { Kind: "queue"; Url: string } | { Kind: "topic"; Arn: string }
    > = { Kind: "topic", Arn: url };
    const whole: DeepInput<Statement> = all([url, url]).map(([a, b]) => ({
      Effect: a,
      Resource: b,
    }));
    const versioned: DeepInput<boolean> = flag;
    const maybe: DeepInput<string | undefined> = optional;
    // @ts-expect-error a ref to a string is not a boolean
    const notBoolean: DeepInput<boolean> = url;
    void [statements, target, whole, versioned, maybe, notBoolean];
  });

  it("keeps credentials and ~state refs apart from output refs", () => {
    // @ts-expect-error a credential to a number doesn't fit a credential to a string
    const credentialNumber: CredentialRef<string> = {} as CredentialRef<number>;
    // @ts-expect-error a ~state ref doesn't fit an output ref
    const stateAsOutput: OutputRef<string> = recorded;
    // @ts-expect-error a credential doesn't fit an output ref
    const credentialAsOutput: OutputRef<string> = credential;
    // @ts-expect-error a credential has no map
    () => credential.map((value) => value);
    // @ts-expect-error a ~state ref has no map
    () => recorded.map((value) => value);
    // @ts-expect-error text doesn't join a credential
    () => text`${credential}`;
    // @ts-expect-error all doesn't take a ~state ref
    () => all([recorded]);
    void [credentialNumber, stateAsOutput, credentialAsOutput];
  });

  it("types derived values by the value they compute", () => {
    expectTypeOf(text`${url}:${port}`).toEqualTypeOf<Derived<string>>();
    expectTypeOf(url.map((value) => value.length)).toEqualTypeOf<
      Derived<number>
    >();
    expectTypeOf(all([url, port])).toEqualTypeOf<Derived<[string, number]>>();
  });

  it("types config and contributions as DeepInput", () => {
    const bucket = new Bucket("b", {
      config: {
        Name: text`${source.outputRef("Arn")}-copy`,
        Versioned: flag,
        Statements: [{ Effect: "Allow", Resource: source.outputRef("Arn") }],
        Target: { Kind: "queue", Url: url },
      },
    });
    bucket.contribute({
      Statements: [
        { Effect: "Allow", Resource: [text`${url}/*`, recorded] },
        { Effect: "Allow", Resource: credential },
      ],
    });
    new Bucket("credential", { config: { Name: credential } });
    new Bucket("alias", {
      config: {
        // @ts-expect-error a required param doesn't take an optional output
        Name: source.outputRef("Alias"),
      },
    });
    new Bucket("mapped", {
      config: { Name: source.outputRef("Alias").map((alias) => alias ?? "") },
    });
    new Bucket("size", {
      config: {
        // @ts-expect-error a ref to a number doesn't fit a string param
        Name: source.outputRef("Size"),
      },
    });
    new Optional("label", { config: { Label: source.outputRef("Alias") } });
    new Bucket("state", {
      // @ts-expect-error config doesn't take a ~state ref
      config: { Name: recorded },
    });
  });

  it("makes a resource whose params are all optional with no options", () => {
    new Optional("o");
    new Optional("o", {});
  });
});
