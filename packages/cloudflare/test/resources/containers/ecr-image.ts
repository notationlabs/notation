import crypto from "node:crypto";
import {
  CompleteLayerUploadCommand,
  InitiateLayerUploadCommand,
  LayerAlreadyExistsException,
  PutImageCommand,
  UploadLayerPartCommand,
  type ECRClient,
} from "@aws-sdk/client-ecr";

const DOCKER_HUB = "https://registry-1.docker.io";

// ECR requires each part but the last to be at least 5 MiB.
const PART_SIZE = 10 * 1024 * 1024;

type Manifest = {
  mediaType: string;
  config: { digest: string };
  layers: { digest: string }[];
};

/**
 * Copies the image `repository@digest` from Docker Hub into the ECR
 * repository `ecrRepository`, through the registry HTTP API, so that no
 * Docker daemon is needed. `digest` must name an image manifest, not an
 * index. The manifest is put with the bytes that Docker Hub returns, so the
 * image keeps its digest in ECR.
 */
export async function copyDockerHubImageToEcr(
  ecr: ECRClient,
  {
    repository,
    digest,
    ecrRepository,
  }: { repository: string; digest: string; ecrRepository: string },
): Promise<void> {
  const token = await dockerHubToken(repository);
  const manifestBytes = await dockerHubGet(
    token,
    `/v2/${repository}/manifests/${digest}`,
    digest,
    "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
  );
  const manifestText = manifestBytes.toString("utf8");
  const manifest = JSON.parse(manifestText) as Manifest;
  for (const blob of [manifest.config, ...manifest.layers]) {
    const bytes = await dockerHubGet(
      token,
      `/v2/${repository}/blobs/${blob.digest}`,
      blob.digest,
    );
    await uploadLayer(ecr, ecrRepository, blob.digest, bytes);
  }
  await ecr.send(
    new PutImageCommand({
      repositoryName: ecrRepository,
      imageManifest: manifestText,
      imageManifestMediaType: manifest.mediaType,
      imageDigest: digest,
    }),
  );
}

async function dockerHubToken(repository: string): Promise<string> {
  const response = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
  );
  if (!response.ok) {
    throw new Error(`Docker Hub refused a token: ${response.status}`);
  }
  return ((await response.json()) as { token: string }).token;
}

// Checks the bytes against `digest`, as a blob request is redirected to a CDN.
async function dockerHubGet(
  token: string,
  path: string,
  digest: string,
  accept?: string,
): Promise<Buffer> {
  const response = await fetch(`${DOCKER_HUB}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(accept ? { Accept: accept } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Fetching ${path} from Docker Hub failed: ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== digest) {
    throw new Error(`${path} from Docker Hub has the digest ${actual}`);
  }
  return bytes;
}

async function uploadLayer(
  ecr: ECRClient,
  repositoryName: string,
  digest: string,
  bytes: Buffer,
): Promise<void> {
  const { uploadId } = await ecr.send(
    new InitiateLayerUploadCommand({ repositoryName }),
  );
  for (let start = 0; start < bytes.length; start += PART_SIZE) {
    const end = Math.min(start + PART_SIZE, bytes.length);
    await ecr.send(
      new UploadLayerPartCommand({
        repositoryName,
        uploadId,
        partFirstByte: start,
        partLastByte: end - 1,
        layerPartBlob: bytes.subarray(start, end),
      }),
    );
  }
  try {
    await ecr.send(
      new CompleteLayerUploadCommand({
        repositoryName,
        uploadId,
        layerDigests: [digest],
      }),
    );
  } catch (error) {
    if (!(error instanceof LayerAlreadyExistsException)) throw error;
  }
}
