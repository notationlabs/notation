import path from "node:path";
import { analyzeModule, Marks } from "src/index";

export const root = "/project";

/**
 * Marks over in-memory files, keyed by path relative to `root`. A bare
 * specifier resolves through `packages`, which maps it to a file.
 */
export function virtualMarks(
  files: Record<string, string>,
  packages: Record<string, string> = {},
) {
  const abs = (file: string) => path.join(root, file);
  const known = new Set(Object.keys(files).map(abs));
  return new Marks({
    readFile: (file) => {
      const contents = files[path.relative(root, file)];
      if (contents === undefined) throw new Error(`No file ${file}`);
      return contents;
    },
    resolve: (specifier, importer) => {
      if (specifier in packages) return abs(packages[specifier]!);
      if (!specifier.startsWith(".")) return undefined;
      const base = path.resolve(path.dirname(importer), specifier);
      return [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        base.replace(/\.js$/, ".ts"),
      ].find((f) => known.has(f));
    },
  });
}

export function analyze(
  files: Record<string, string>,
  file: string,
  packages?: Record<string, string>,
) {
  const marks = virtualMarks(files, packages);
  return {
    marks,
    analysis: analyzeModule(marks.table(path.join(root, file))!, marks),
  };
}

// A stand-in for @notation/aws/lambda, with its marks.
export const awsLambda = `
/** @declaration shared: id, event, env; keys: env; entry: handler */
export function $lambda(config) { return config; }

export const sqs = {
  /** @runtime queue */
  bind(queue, options) { return { kind: "sqs", schema: queue?.schema, queue, options }; },
  schema(schema) { return { kind: "sqs", schema }; },
};

export const apiGateway = {
  /** @runtime api */
  bind(api) {
    return {
      /** @runtime options.auth */
      defineRoute(options) {
        return { kind: options.auth ? "apiGateway-jwt" : "apiGateway", schema: options.schema, claims: options.auth?.claims };
      },
    };
  },
  schema(body, options) { return { kind: options?.claims ? "apiGateway-jwt" : "apiGateway", schema: body, claims: options?.claims }; },
};
`;

export const awsApiGateway = `
/** @resource runtime: */
export function api(config) { return { id: config.name }; }

/** @resource runtime: claims */
export function jwtAuthorizer(config) { return config; }
`;

export const awsSqs = `
/** @resource runtime: schema */
export function createQueue(config) { return { url: "\${url}", grant: () => ({}) }; }

/** @resource */
export function createTopic(config) { return { arn: "\${arn}" }; }
`;

export const packages = {
  "@notation/aws/lambda": "node_modules/@notation/aws/lambda.js",
  "@notation/aws/sqs": "node_modules/@notation/aws/sqs.js",
  "@notation/aws/api-gateway": "node_modules/@notation/aws/api-gateway.js",
};

export const packageFiles = {
  "node_modules/@notation/aws/lambda.js": awsLambda,
  "node_modules/@notation/aws/sqs.js": awsSqs,
  "node_modules/@notation/aws/api-gateway.js": awsApiGateway,
};
