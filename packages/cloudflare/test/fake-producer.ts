import { randomUUID } from "node:crypto";
import * as v from "valibot";
import {
  collectSecretTargets,
  producedSource,
  writeSecretValues,
  type ProducedSource,
  type SecretTarget,
} from "@notation/core";
import {
  ResourceGroup,
  resource,
  ResourceNotFoundError,
} from "@notation/resource";

/** The key pairs that the fake API holds, by ID. It never holds a value. */
export const fakeKeys = new Map<string, { name: string }>();

/** The values that creates made, so that tests can look for them. */
export const producedValues: string[] = [];

/**
 * The creates and deletes of the fake resources, in order. Tests add the
 * deletes of the secrets' values from the fake Cloudflare API.
 */
export const operations: string[] = [];

type FakeKeyPairSchema = {
  Key: { KeyId: string };
  CreateParams: { Name: string; PrivateKeyTargets: SecretTarget[] };
  UpdateParams: {};
  ReadResult: {};
};

const fakeKeyPair = resource<FakeKeyPairSchema>({
  type: "test/fake/FakeKeyPair",
  provider: "@notation/cloudflare/test/fake-producer",
});

const targetSchema = v.object({
  provider: v.string(),
  params: v.record(v.string(), v.any()),
});

/**
 * A key pair whose API returns the private key once, in the create's
 * response, like a GitHub App from the manifest flow.
 */
export const FakeKeyPair = fakeKeyPair
  .defineSchema({
    Name: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      value: v.string(),
    },
    // Each secret that takes `sources.privateKey` contributes its target.
    // Immutable, because only a create gets a value to write to a new
    // target.
    PrivateKeyTargets: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      value: v.array(targetSchema),
      collect: collectSecretTargets,
    },
    KeyId: {
      propertyType: "computed",
      presence: "required",
      primaryKey: true,
      value: v.string(),
    },
  } as const)
  .defineOperations({
    create: async (params) => {
      const id = randomUUID();
      const privateKey = `private-key-${randomUUID()}`;
      fakeKeys.set(id, { name: params.Name });
      producedValues.push(privateKey);
      try {
        await writeSecretValues(
          params.PrivateKeyTargets.map((target) => [target, privateKey]),
        );
      } catch (error) {
        fakeKeys.delete(id);
        throw error;
      }
      operations.push(`create key pair ${params.Name}`);
      return { KeyId: id };
    },

    read: async (key) => {
      if (!fakeKeys.has(key.KeyId)) {
        throw new ResourceNotFoundError("Key pair was not found");
      }
      // A missing value is left to the secret's read, which reports it as
      // drift. Throwing here would fail the plan before it shows the drift.
      return {};
    },

    // The secrets own the value, so delete leaves it. A key pair that a
    // rotation replaced would otherwise delete its replacement's value.
    delete: async (key, state) => {
      fakeKeys.delete(key.KeyId);
      operations.push(`delete key pair ${state.Name}`);
    },
  });

export class FakeKeyPairGroup extends ResourceGroup<{ id: string }> {
  platform = "test";
  readonly keyPair: InstanceType<typeof FakeKeyPair>;
  readonly sources: { privateKey: ProducedSource };

  constructor(config: { id: string; name?: string }) {
    super("test/fakeKeyPair", config.id, { id: config.id });
    this.keyPair = this.add(
      new FakeKeyPair(`key-pair:${config.id}`, {
        config: { Name: config.name ?? config.id },
      }),
    );
    this.sources = {
      privateKey: producedSource({
        producer: `fakeKeyPair({ id: "${config.id}" })`,
        resource: this.keyPair,
        name: "privateKey",
        param: "PrivateKeyTargets",
      }),
    };
  }
}

export const fakeKeyPairGroup = (
  config: ConstructorParameters<typeof FakeKeyPairGroup>[0],
) => new FakeKeyPairGroup(config);

type FakeBindingSchema = {
  Key: { Id: string };
  CreateParams: { Id: string; StoreId: string; SecretName: string };
  UpdateParams: { StoreId: string; SecretName: string };
  ReadResult: {};
};

const fakeBinding = resource<FakeBindingSchema>({
  type: "test/fake/FakeBinding",
  provider: "@notation/cloudflare/test/fake-producer",
});

/**
 * Stands in for a Worker that binds a secret. It takes the same output refs
 * of the secret as a Worker's `secrets_store_secret` binding, and records
 * its creates and deletes in `operations`.
 */
export const FakeBinding = fakeBinding
  .defineSchema({
    Id: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      primaryKey: true,
      value: v.string(),
    },
    StoreId: { propertyType: "param", presence: "required", value: v.string() },
    SecretName: {
      propertyType: "param",
      presence: "required",
      value: v.string(),
    },
  } as const)
  .defineOperations({
    create: async (params) => {
      operations.push(`create binding ${params.Id}`);
    },
    read: async () => ({}),
    update: async (key) => {
      operations.push(`update binding ${key.Id}`);
    },
    delete: async (key) => {
      operations.push(`delete binding ${key.Id}`);
    },
  });
