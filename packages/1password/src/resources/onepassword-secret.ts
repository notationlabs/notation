import * as v from "valibot";
import { credentialSourceResource } from "@notation/resource";
import {
  assertTrackKey,
  trackRevision,
  trackValidator,
  type Track,
} from "@notation/std/track";
import { fetchEntry, prefetchItems } from "../items";
import { parseReference } from "../reference";

export type OnePasswordSecretSchema = {
  Params: { reference: string; track?: Track };
  Value: string;
};

/**
 * The item of the reference was deleted after deploy read it, and another
 * item with the same name was added.
 */
export class ItemReplacedError extends Error {
  constructor(reference: string) {
    super(
      `The item of \`${reference}\` was deleted and another item with the same name was added after deploy read it. Run deploy again.`,
    );
    this.name = "ItemReplacedError";
  }
}

/**
 * A field of an item in 1Password. It reads the item with the 1Password
 * CLI, `op`, which signs in with the desktop app, `OP_SERVICE_ACCOUNT_TOKEN`
 * or a Connect server. `OP_ACCOUNT` chooses the account.
 *
 * Without `track`, its revision is the item's ID and version, so a resource
 * that takes the value is written when any part of the item changes.
 */
export const OnePasswordSecret =
  credentialSourceResource<OnePasswordSecretSchema>({
    type: "1password/secrets/OnePasswordSecret",
    provider: "@notation/1password/resources",
  })
    .defineSchema({
      /** An `op://<vault>/<item>/[<section>/]<field>` secret reference. */
      reference: {
        propertyType: "param",
        presence: "required",
        value: v.pipe(
          v.string(),
          v.rawCheck(({ dataset, addIssue }) => {
            if (!dataset.typed) return;
            try {
              parseReference(dataset.value);
            } catch (error) {
              addIssue({ message: (error as Error).message });
            }
          }),
        ),
      },
      /**
       * Makes `revision` a hash of the field's value, so that a resource that
       * takes the value is written only when it changes. `"scrypt"` is for
       * generated values only. `"hmac"` needs `NOTATION_TRACK_KEY`.
       */
      track: {
        propertyType: "param",
        presence: "optional",
        value: trackValidator,
      },
      revision: {
        propertyType: "computed",
        presence: "required",
        value: v.string(),
      },
      value: { propertyType: "credential", value: v.string() },
    } as const)
    .defineOperations({
      prefetch: (sources, context) =>
        prefetchItems(
          sources.map(({ id, params }) => ({
            id,
            reference: params.reference,
          })),
          context.notify,
        ),
      read: async (params, context) => {
        if (params.track) assertTrackKey(params.track);
        const entry =
          context.prefetched?.get(params.reference) ??
          (await fetchEntry(parseReference(params.reference)));
        if (params.track) {
          return {
            revision: await trackRevision(params.track, context, entry.value),
          };
        }
        return { revision: `version:${entry.id}:${entry.version}` };
      },
      // `op` can't fetch a past version, so the item must still be the one
      // that `read` saw.
      loadCredential: async (state, context) => {
        const revision = parseRevision(state.revision);
        if (state.track) assertTrackKey(state.track);
        if (
          (revision.kind === "hash" ? revision.track : undefined) !==
          state.track
        ) {
          throw new Error(
            `The revision of ${context.id} in state is \`${state.revision}\`, which does not match \`track: ${state.track ? `"${state.track}"` : "undefined"}\`. Run deploy again.`,
          );
        }
        const { id, version, value } =
          context.prefetched?.get(state.reference) ??
          (await fetchEntry(parseReference(state.reference)));
        const changed = new Error(
          `\`${state.reference}\` changed after deploy read it. Run deploy again.`,
        );
        if (revision.kind === "version") {
          if (id !== revision.id) throw new ItemReplacedError(state.reference);
          if (version !== revision.version) throw changed;
        } else if (
          (await trackRevision(revision.track, context, value)) !==
          state.revision
        ) {
          throw changed;
        }
        return value;
      },
    });

type Revision =
  | { kind: "version"; id: string; version: number }
  | { kind: "hash"; track: Track };

function parseRevision(revision: string): Revision {
  const version = /^version:([^:]+):(\d+)$/.exec(revision);
  if (version) {
    return { kind: "version", id: version[1]!, version: Number(version[2]) };
  }
  if (revision.startsWith("hmac:")) return { kind: "hash", track: "hmac" };
  if (revision.startsWith("scrypt:")) return { kind: "hash", track: "scrypt" };
  throw new Error(
    `\`${revision}\` is not a revision of a 1Password secret. Run deploy again.`,
  );
}

export type OnePasswordSecretInstance = InstanceType<typeof OnePasswordSecret>;
