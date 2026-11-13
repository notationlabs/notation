import { scrubError } from "@notation/core";
import { ResourceCreationUnknownError } from "@notation/resource";
import { cloudflareCreate } from "src/api/client";
import {
  createSecret,
  deleteSecret,
  findSecretByName,
  isNotFound,
  isSecretNotFound,
  patchSecret,
  type SecretScope,
} from "src/api/secrets-store";

export async function upsertSecretByName(opts: {
  account: string;
  storeId: string;
  name: string;
  value: string;
  /**
   * Pass a string to patch that secret directly, `null` when
   * `findSecretByName` already ran and found no match, or `undefined` to look
   * up by name before deciding between patch and create.
   */
  existingId?: string | null;
  scopesOnPatch?: SecretScope[];
}): Promise<void> {
  try {
    const patch = (id: string) =>
      patchSecret(opts.account, opts.storeId, id, {
        value: opts.value,
        ...(opts.scopesOnPatch ? { scopes: opts.scopesOnPatch } : {}),
      });
    const targetId =
      opts.existingId === undefined
        ? (await findSecretByName(opts.account, opts.storeId, opts.name))?.id
        : (opts.existingId ?? undefined);
    if (targetId) {
      try {
        await patch(targetId);
        return;
      } catch (error) {
        if (!(opts.existingId && isSecretNotFound(error))) throw error;
        // Stale state SecretId (e.g. deleted or recreated out-of-band before an
        // update); fall back to looking up by name or recreating.
        const current = await findSecretByName(
          opts.account,
          opts.storeId,
          opts.name,
        );
        if (current) {
          await patch(current.id);
          return;
        }
      }
    }
    const created = await cloudflareCreate(createSecret)(
      opts.account,
      opts.storeId,
      opts.name,
      {
        value: opts.value,
        scopes: ["workers"],
      },
    );
    if (!created) {
      throw new ResourceCreationUnknownError(
        "Cloudflare reported a successful create, but returned no secret",
      );
    }
  } catch (error) {
    throw scrubError(error);
  }
}

export async function deleteSecretByName(opts: {
  account: string;
  storeId: string;
  name: string;
  secretId?: string;
}): Promise<void> {
  let secretId = opts.secretId;
  if (!secretId) {
    try {
      secretId = (
        await findSecretByName(opts.account, opts.storeId, opts.name)
      )?.id;
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }
  if (!secretId) return;
  try {
    await deleteSecret(opts.account, opts.storeId, secretId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
