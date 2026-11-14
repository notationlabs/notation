import { expect, it } from "vitest";
import { api, bucketsWithPrefix, describeE2e, useProject } from "../e2e";

type BucketConfig = {
  BucketName: string;
  Jurisdiction: "default" | "eu";
  StorageClass: "Standard" | "InfrequentAccess";
  LocationHint?: "weur" | "enam";
};

type CloudflareBucket = {
  name: string;
  creation_date: string;
  location?: string;
  jurisdiction?: string;
  storage_class?: string;
};

describeE2e("R2Bucket", () => {
  const project = useProject();
  const uploads = `${project.scope}uploads`;
  const archive = `${project.scope}archive`;
  const taken = `${project.scope}taken`;
  let uploadsCreatedAt: string;

  function writeProject(buckets: Record<string, BucketConfig>) {
    const declarations = Object.entries(buckets).map(
      ([id, config]) =>
        `new r2.R2Bucket(${JSON.stringify(id)}, { config: ${JSON.stringify(config)} });`,
    );
    project.write(
      "infra/main.ts",
      `
      import { r2 } from "@notation/cloudflare/resources";

      ${declarations.join("\n      ")}
      `,
    );
  }

  async function getBucket(
    name: string,
    jurisdiction: string,
  ): Promise<CloudflareBucket | undefined> {
    const response = await api<CloudflareBucket>(
      "GET",
      `/r2/buckets/${name}`,
      undefined,
      { "cf-r2-jurisdiction": jurisdiction },
    );
    if (response.status === 404) return undefined;
    if (!response.success) {
      throw new Error(
        `Reading the bucket ${name} failed: ${JSON.stringify(response.errors)}`,
      );
    }
    return response.result;
  }

  const uploadsConfig: BucketConfig = {
    BucketName: uploads,
    Jurisdiction: "default",
    StorageClass: "Standard",
    LocationHint: "weur",
  };
  const archiveConfig: BucketConfig = {
    BucketName: archive,
    Jurisdiction: "eu",
    StorageClass: "InfrequentAccess",
  };

  it("creates a bucket in the default jurisdiction and one in the EU jurisdiction", async () => {
    writeProject({
      "bucket:uploads": uploadsConfig,
      "bucket:archive": archiveConfig,
    });
    await project.notation("deploy");

    const created = await getBucket(uploads, "default");
    expect(created).toMatchObject({
      name: uploads,
      location: "WEUR",
      storage_class: "Standard",
    });
    uploadsCreatedAt = created!.creation_date;
    expect(await getBucket(archive, "eu")).toMatchObject({
      name: archive,
      jurisdiction: "eu",
      storage_class: "InfrequentAccess",
    });
    expect(await getBucket(archive, "default")).toBeUndefined();
  });

  it("changes the storage class in place, and ignores a change to the location hint", async () => {
    writeProject({
      "bucket:uploads": {
        ...uploadsConfig,
        StorageClass: "InfrequentAccess",
        LocationHint: "enam",
      },
      "bucket:archive": archiveConfig,
    });
    await project.notation("deploy");

    expect(await getBucket(uploads, "default")).toMatchObject({
      creation_date: uploadsCreatedAt,
      location: "WEUR",
      storage_class: "InfrequentAccess",
    });
  });

  it("fails to deploy a bucket whose name another bucket has, and leaves that bucket", async () => {
    const existing = await api("POST", "/r2/buckets", { name: taken });
    expect(existing.errors).toEqual([]);
    const before = await getBucket(taken, "default");

    writeProject({
      "bucket:uploads": { ...uploadsConfig, StorageClass: "InfrequentAccess" },
      "bucket:archive": archiveConfig,
      "bucket:taken": {
        BucketName: taken,
        Jurisdiction: "default",
        StorageClass: "InfrequentAccess",
      },
    });
    await expect(project.notation("deploy")).rejects.toThrow(
      `A bucket named ${taken} already exists`,
    );
    expect(await getBucket(taken, "default")).toEqual(before);

    await api("DELETE", `/r2/buckets/${taken}`);
    expect(await getBucket(taken, "default")).toBeUndefined();
  });

  it("deletes the buckets on destroy", async () => {
    await project.notation("destroy");

    expect(await bucketsWithPrefix(project.scope)).toEqual([]);
  });
});
