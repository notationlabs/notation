import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "@notation/core";
import {
  resource,
  ResourceNotFoundError,
  type BaseResource,
  type StandardSchemaV1,
} from "@notation/resource";
import {
  bundleDir,
  bundleKey,
  cachedBuild,
  currentFileSha256,
  recordInputs,
} from "../bundle/cache";
import { moduleFileName, type BundleSource } from "../bundle/compile";
import { sha256Base64 } from "../bundle/inputs";
import { readEntryExports, type BundleExports } from "../exports";
import { realRoot } from "../files";
import { isPlatformName, type PlatformName } from "../platforms";

export type BundleParams = {
  Id: string;
  /**
   * A key of `modules`, or a path relative to the project root, with its
   * symlinks kept. A path that is only under the real path of the root is
   * relative to that real path.
   */
  Entry: string;
  Platform: PlatformName;
  /** The file that the bundle writes, relative to the project root. */
  FilePath: string;
  /** The base64 SHA-256 of the file that the bundle writes. */
  FileSha256: string;
};

export type BundleSchema = {
  Key: { Id: string; FilePath: string };
  CreateParams: BundleParams;
  UpdateParams: BundleParams;
  ReadResult: {
    FilePath: string;
    FileSha256: string;
    filePath: string;
    fileSha256: string;
  };
};

const check = <T>(
  test: (value: unknown) => boolean,
  message: string,
): StandardSchemaV1<T, T> => ({
  "~standard": {
    version: 1,
    vendor: "@notation/build",
    validate: (value) =>
      test(value) ? { value: value as T } : { issues: [{ message }] },
  },
});

const string = () =>
  check<string>((value) => typeof value === "string", "Expected a string");

/** The type of a `Bundle` resource. */
const bundleType = "build/bundle/Bundle";

/**
 * What a Lambda or a Worker needs from a bundle that it takes as its code.
 * Structural, so that a bundle from another installed copy of this package
 * matches it.
 */
export type BundleLike = BaseResource & {
  readonly config: { Entry: string; Platform: PlatformName };
  /** The file that the bundle writes, as the outputs of a `std.fs.File`. */
  readonly output: { filePath: string; fileSha256: string };
  /** The exports of the bundle's entry. */
  readonly exports: BundleExports;
};

/**
 * Whether a value is a bundle from `bundle()`. Compares the resource type,
 * not the class, so that a bundle from another installed copy of this
 * package is recognised.
 */
export const isBundle = (value: unknown): value is BundleLike =>
  (value as { type?: unknown } | null)?.type === bundleType;

const bundleResource = resource<BundleSchema>({
  type: bundleType,
  provider: "@notation/build/resources",
});

const bundleSchema = bundleResource.defineSchema({
  Id: {
    propertyType: "param",
    presence: "required",
    value: string(),
    primaryKey: true,
  },
  FilePath: {
    propertyType: "param",
    presence: "required",
    value: string(),
    secondaryKey: true,
  },
  Entry: { propertyType: "param", presence: "required", value: string() },
  Platform: {
    propertyType: "param",
    presence: "required",
    value: check<PlatformName>(
      (value) => typeof value === "string" && isPlatformName(value),
      'Expected "node" or "workerd"',
    ),
  },
  FileSha256: {
    propertyType: "param",
    presence: "required",
    value: string(),
  },
  filePath: { propertyType: "computed", presence: "required", value: string() },
  fileSha256: {
    propertyType: "computed",
    presence: "required",
    value: string(),
  },
} as const);

const BundleBase = bundleSchema.defineOperations<
  Pick<BundleParams, "FilePath" | "FileSha256">
>({
  // `Bundle` sets `create` and `update`, which need the instance.
  create: async () => {},
  // Reports the hash of the file on disk as `FileSha256`, so that drift
  // detection compares it with the param. A file that another build wrote,
  // such as that of another stage, then plans an update that rewrites it.
  read: async (key) => {
    const file = path.resolve(projectRoot(), key.FilePath);
    try {
      const fileSha256 = sha256Base64(fs.readFileSync(file));
      return {
        FilePath: key.FilePath,
        FileSha256: fileSha256,
        filePath: key.FilePath,
        fileSha256,
      };
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        throw new ResourceNotFoundError("The bundle's output was not found", {
          cause: error,
        });
      }
      throw error;
    }
  },
  delete: async (key) => {
    fs.rmSync(bundleDir(key.Id), { recursive: true, force: true });
  },
});

type BundleBaseInstance = InstanceType<typeof BundleBase>;

/** The file that a bundle writes, relative to the project root. */
const filePathOf = (id: string, platform: PlatformName) =>
  path
    .relative(
      projectRoot(),
      path.join(
        bundleDir(id),
        platform === "node" ? "index.zip" : moduleFileName,
      ),
    )
    .split(path.sep)
    .join("/");

export type BundleConfig = Pick<BundleParams, "Id" | "Entry" | "Platform">;

/**
 * Code built with Rolldown at deploy, with the build options of a
 * `$lambda` or `$worker` bundle. Declare one with `bundle()`. Its outputs
 * have the same shape as a `std.fs.File`, so a Lambda or a Worker can take it
 * as its code.
 */
export class Bundle extends BundleBase {
  // Set by the class from `defineOperations`, whose type leaves them abstract.
  declare type: BundleBaseInstance["type"];
  declare provider: string;
  declare schema: BundleBaseInstance["schema"];
  declare read: NonNullable<BundleBaseInstance["read"]>;
  declare delete: BundleBaseInstance["delete"];
  // `bundle()` takes plain values, so config holds no ref.
  declare config: BundleConfig;

  /** The generated modules, by import specifier. Not stored in state. */
  readonly modules: Record<string, string>;
  /** The exports of the entry, which `bundle()` read. */
  readonly exports: BundleExports;

  constructor(
    id: string,
    {
      config,
      modules = {},
      exports = { names: [], stars: [] },
    }: {
      config: BundleConfig;
      modules?: Record<string, string>;
      exports?: BundleExports;
    },
  ) {
    super(id, { config });
    this.modules = modules;
    this.exports = exports;
  }

  #source(): BundleSource {
    return {
      label: this.id,
      platform: this.config.Platform,
      entry: this.config.Entry,
      modules: this.modules,
      root: realRoot(projectRoot()),
      exports: this.exports.names,
    };
  }

  async deriveParams() {
    const source = this.#source();
    const key = await bundleKey(source);
    const FilePath = filePathOf(this.config.Id, source.platform);
    const FileSha256 =
      currentFileSha256(this.config.Id, key, source.root, FilePath) ??
      (await cachedBuild(this.config.Id, source, key)).fileSha256;
    return { FilePath, FileSha256 };
  }

  // Writes the output, unless the inputs file shows that it is on disk.
  #write = async (params: BundleParams) => {
    const source = this.#source();
    const key = await bundleKey(source);
    const id = this.config.Id;
    if (
      currentFileSha256(id, key, source.root, params.FilePath) ===
      params.FileSha256
    ) {
      return;
    }
    const built = await cachedBuild(id, source, key);
    if (built.fileSha256 !== params.FileSha256) {
      throw new Error(
        `${this.id} built to SHA-256 ${built.fileSha256}, but the plan expects ${params.FileSha256}. An input of the bundle changed after the plan, or its build is not deterministic. Start a new deploy.`,
      );
    }
    const dir = bundleDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, moduleFileName), built.code);
    if (source.platform === "node") {
      fs.writeFileSync(
        path.resolve(projectRoot(), params.FilePath),
        built.file,
      );
    }
    // A delete before a replace removes the inputs file, and the build may
    // have come from the cache, which doesn't write it.
    recordInputs(id, key, built);
  };

  create = async (params: BundleParams) => {
    await this.#write(params);
  };

  update = async (
    _key: BundleSchema["Key"],
    _patch: BundleParams,
    params: BundleParams,
  ) => {
    await this.#write(params);
  };
}

export type BundleOptions = {
  /**
   * Keys the bundle in state, as `bundle:<id>`. The output is written to
   * `dist/.bundles/<id>/`. 1 to 64 letters, digits, hyphens or underscores.
   */
  id: string;
  /**
   * `node` builds the bundle as for a `$lambda`, and `workerd` as for a
   * `$worker`.
   */
  platform: PlatformName;
  /**
   * The module that the bundle starts from: an absolute path, a path
   * relative to the project root, or a key of `modules`.
   */
  entry: string;
  /**
   * Generated modules, by import specifier. The entry and the modules that it
   * imports can import them. A specifier can't start with `.` or `/`. A
   * source is JavaScript, unless its specifier ends in `.ts` or `.tsx`.
   */
  modules?: Record<string, string>;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Declares code that deploy builds with Rolldown, with the build options of
 * a `$lambda` (`platform: "node"`) or a `$worker` (`platform: "workerd"`).
 * Pass it as the `code` of `lambda()` or `worker()`. Reads the exports of
 * the entry when it is called.
 * @resource
 */
export function bundle(options: BundleOptions): Bundle {
  const { id, platform, entry, modules = {} } = options;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid bundle() id ${JSON.stringify(id)}: use 1 to 64 letters, digits, hyphens or underscores. The id keys the bundle in state, so keep it stable.`,
    );
  }
  if (typeof platform !== "string" || !isPlatformName(platform)) {
    throw new Error(
      `bundle({ id: "${id}" }) has the platform ${JSON.stringify(platform)}. Use "node" for a Lambda or "workerd" for a Worker.`,
    );
  }
  for (const [specifier, moduleSource] of Object.entries(modules)) {
    if (typeof moduleSource !== "string") {
      throw new Error(
        `bundle({ id: "${id}" }) has the module ${JSON.stringify(specifier)} in modules, whose source is not a string. A source is the code of the module, as a string.`,
      );
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      throw new Error(
        `bundle({ id: "${id}" }) has the module ${JSON.stringify(specifier)} in modules. A key of modules can't start with "." or "/", as such a specifier names a file. Use a specifier such as "virtual:routes".`,
      );
    }
  }
  const { file, source } = readEntry(id, entry, modules);
  return new Bundle(`bundle:${id}`, {
    config: { Id: id, Entry: file, Platform: platform },
    modules,
    exports: readEntryExports(file, source, platform),
  });
}

// The entry as the param holds it, and its source. A path is made relative
// to the project root, without resolving symlinks. A path under the real path
// of the root but not under the root, such as one from
// `fileURLToPath(new URL(..., import.meta.url))` when the root is a symlink,
// is made relative to the real path, so that the param is the same on each
// machine. The param changes when the entry's real path changes, such as when
// pnpm upgrades the package that holds it.
function readEntry(
  id: string,
  entry: string,
  modules: Record<string, string>,
): { file: string; source: string } {
  if (typeof entry !== "string" || entry === "") {
    throw new Error(
      `bundle({ id: "${id}" }) requires an entry: a path, or a key of modules.`,
    );
  }
  if (Object.hasOwn(modules, entry)) {
    return { file: entry, source: modules[entry]! };
  }
  const absolute = path.resolve(projectRoot(), entry);
  let source: string;
  try {
    source = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    throw new Error(
      `bundle({ id: "${id}" }) can't read its entry ${entry} at ${absolute}. Pass an absolute path, a path relative to the project root, or a key of modules.`,
      { cause: error },
    );
  }
  const root = projectRoot();
  const real = realRoot(root);
  const base =
    !isUnder(root, absolute) && isUnder(real, absolute) ? real : root;
  const file = path.relative(base, absolute).split(path.sep).join("/");
  return { file, source };
}

const isUnder = (dir: string, file: string) => {
  const relative = path.relative(dir, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

export type BundleInstance = InstanceType<typeof Bundle>;
