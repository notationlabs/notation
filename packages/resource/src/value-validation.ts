import type { Schema } from "./resource.schema";
import type { StandardSchemaV1 } from "./standard-schema";
import { isUnknownAfterApply } from "./diff-params";
import { isPlainObject } from "./output-value";

/**
 * Where the engine validated a value:
 * - `declaration`: config, when the resource is declared.
 * - `plan`: the params a plan knows.
 * - `deploy`: params, before deploy changes anything, and again just before
 *   the resource's own operation.
 * - `create`: the result of the resource's `create`.
 * - `read`: the result of the resource's `read`.
 */
export type ValidationPoint =
  "declaration" | "plan" | "deploy" | "create" | "read";

/** The parts of a resource that validation reads. */
export type ValidationSubject = {
  id: string;
  type: string;
  schema: Schema;
  /** `file:line` of the code that declared the resource, when known. */
  declaredAt?: string;
};

/** Thrown when a value fails its schema item's validator. */
export class ValueValidationError extends Error {
  readonly _tag = "ValueValidationError" as const;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly field: string;
  readonly point: ValidationPoint;
  readonly declaredAt?: string;
  /**
   * One line per issue the validator reported, prefixed by its path. For a
   * sensitive field the line holds a generic message in place of the
   * validator's, which can include the value.
   */
  readonly issues: string[];

  constructor(opts: {
    resourceId: string;
    resourceType: string;
    field: string;
    point: ValidationPoint;
    declaredAt?: string;
    issues: string[];
  }) {
    const resource = `${opts.resourceId} (${opts.resourceType})`;
    const site = opts.declaredAt ? `, declared at ${opts.declaredAt}` : "";
    const subject =
      opts.point === "read" || opts.point === "create"
        ? `The ${opts.point} of ${resource} returned an invalid ${opts.field}${site}`
        : opts.point === "declaration"
          ? `Invalid ${opts.field} for ${resource} when declared${opts.declaredAt ? ` at ${opts.declaredAt}` : ""}`
          : `Invalid ${opts.field} for ${resource} at ${opts.point}${site}`;
    super(`${subject}: ${opts.issues.join("; ")}`);
    this.name = "ValueValidationError";
    this.resourceId = opts.resourceId;
    this.resourceType = opts.resourceType;
    this.field = opts.field;
    this.point = opts.point;
    this.declaredAt = opts.declaredAt;
    this.issues = opts.issues;
  }

  static is(error: unknown): error is ValueValidationError {
    return hasTag(error, "ValueValidationError");
  }
}

/**
 * Thrown when values do not have the fields that the schema expects: a param
 * that the schema does not have as a param, a required param that is missing,
 * a create result field that the schema has but not as computed, or a
 * required output that is missing.
 */
export class SchemaStructureError extends Error {
  readonly _tag = "SchemaStructureError" as const;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly fields: string[];

  constructor(subject: ValidationSubject, problem: string, fields: string[]) {
    const site = subject.declaredAt
      ? `, declared at ${subject.declaredAt}`
      : "";
    super(
      `${subject.id} (${subject.type})${site}: ${problem}: ${fields.join(", ")}`,
    );
    this.name = "SchemaStructureError";
    this.resourceId = subject.id;
    this.resourceType = subject.type;
    this.fields = fields;
  }

  static is(error: unknown): error is SchemaStructureError {
    return hasTag(error, "SchemaStructureError");
  }
}

/**
 * Validates each value with the validator of its schema item, and throws
 * `ValueValidationError` for the first that fails. A value that is undefined,
 * or that has no schema item, is not validated.
 *
 * `isUnknown` marks values that stand for something not known yet, such as
 * output values or values unknown until apply. A value that is unknown as a
 * whole is not validated. A value that holds unknowns is validated with them
 * in place, and the issues they could cause are dropped: an issue at or inside
 * an unknown, and an issue at a parent of one, such as a failed union or
 * object check. An issue with no path is at the root, so it is dropped too.
 * A validator that throws on such a value reports no issues.
 *
 * Returns a promise only when a validator is async, so validation at
 * declaration can throw from the constructor.
 */
export function validateValues(
  subject: ValidationSubject,
  values: Record<string, unknown>,
  point: ValidationPoint,
  isUnknown: (value: unknown) => boolean = () => false,
): void | Promise<void> {
  const pending: Promise<void>[] = [];
  try {
    for (const [field, value] of Object.entries(values)) {
      const item = subject.schema[field];
      if (!item || value === undefined) continue;
      const unknowns = findUnknownPaths(value, isUnknown);
      if (unknowns.some((path) => path.length === 0)) continue;
      const result = runValidator(item.value, value, unknowns.length > 0);
      if (result instanceof Promise) {
        pending.push(
          result.then((settled) =>
            assertValid(subject, field, point, knownIssues(settled, unknowns)),
          ),
        );
      } else {
        assertValid(subject, field, point, knownIssues(result, unknowns));
      }
    }
  } catch (error) {
    // Nothing awaits the async checks started before this failure, so their
    // rejections are handled here.
    for (const promise of pending) promise.catch(() => {});
    throw error;
  }
  if (pending.length > 0) return Promise.all(pending).then(() => undefined);
}

type Path = readonly string[];

function findUnknownPaths(
  value: unknown,
  isUnknown: (value: unknown) => boolean,
  path: Path = [],
  found: Path[] = [],
): Path[] {
  if (isUnknown(value)) {
    found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      findUnknownPaths(entry, isUnknown, [...path, String(index)], found),
    );
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      findUnknownPaths(entry, isUnknown, [...path, key], found);
    }
  }
  return found;
}

function runValidator(
  validator: StandardSchemaV1,
  value: unknown,
  hasUnknowns: boolean,
):
  StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>> {
  if (!hasUnknowns) return validator["~standard"].validate(value);
  // A validator can throw on an output value or a marker, for example when
  // it turns the value into a string.
  const valid = { value };
  try {
    const result = validator["~standard"].validate(value);
    return result instanceof Promise ? result.catch(() => valid) : result;
  } catch {
    return valid;
  }
}

function knownIssues(
  result: StandardSchemaV1.Result<unknown>,
  unknowns: Path[],
): readonly StandardSchemaV1.Issue[] {
  const issues = result.issues ?? [];
  if (unknowns.length === 0) return issues;
  return issues.filter((issue) => {
    const path = issuePath(issue);
    return !unknowns.some((unknown) => isPrefixEither(path, unknown));
  });
}

// True when one path is a prefix of the other, or the two are equal.
function isPrefixEither(a: Path, b: Path): boolean {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function issuePath(issue: StandardSchemaV1.Issue): Path {
  return (issue.path ?? []).map((segment) =>
    String(typeof segment === "object" ? segment.key : segment),
  );
}

function assertValid(
  subject: ValidationSubject,
  field: string,
  point: ValidationPoint,
  issues: readonly StandardSchemaV1.Issue[],
): void {
  if (issues.length === 0) return;
  const sensitive = subject.schema[field]?.sensitive === true;
  throw new ValueValidationError({
    resourceId: subject.id,
    resourceType: subject.type,
    field,
    point,
    declaredAt: subject.declaredAt,
    issues: issues.map((issue) => formatIssue(issue, sensitive)),
  });
}

function formatIssue(
  issue: StandardSchemaV1.Issue,
  sensitive: boolean,
): string {
  const message = sensitive ? "Invalid sensitive value" : issue.message;
  const path = issuePath(issue).join(".");
  return path ? `${path}: ${message}` : message;
}

/**
 * Checks params at plan or deploy: every field is a param, every required
 * param has a value, and every value passes its validator. Values unknown
 * until apply are treated as described in `validateValues`.
 */
export async function validateParams(
  subject: ValidationSubject,
  params: Record<string, unknown>,
  point: "plan" | "deploy",
): Promise<void> {
  assertParamFields(subject, params);
  assertRequiredParams(subject, params);
  await validateValues(subject, params, point, isUnknownAfterApply);
}

/** Throws unless every defined value is a param in the schema. */
export function assertParamFields(
  subject: ValidationSubject,
  params: Record<string, unknown>,
): void {
  const extra = Object.keys(params).filter(
    (field) =>
      params[field] !== undefined &&
      subject.schema[field]?.propertyType !== "param",
  );
  if (extra.length > 0) {
    throw new SchemaStructureError(
      subject,
      "these fields are not params in its schema",
      extra,
    );
  }
}

/**
 * Throws unless every required param has a value. Config is not checked with
 * this, because `deriveParams` can set a required param that config leaves
 * out.
 */
export function assertRequiredParams(
  subject: ValidationSubject,
  params: Record<string, unknown>,
): void {
  const missing = Object.entries(subject.schema)
    .filter(
      ([field, item]) =>
        item.propertyType === "param" &&
        item.presence === "required" &&
        params[field] === undefined,
    )
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new SchemaStructureError(
      subject,
      "these required params are missing",
      missing,
    );
  }
}

/** Throws unless every defined value of a create result is computed. */
export function assertComputedFields(
  subject: ValidationSubject,
  result: Record<string, unknown>,
): void {
  const extra = Object.keys(result).filter(
    (field) =>
      result[field] !== undefined &&
      subject.schema[field]?.propertyType !== "computed",
  );
  if (extra.length > 0) {
    throw new SchemaStructureError(
      subject,
      "create returned fields that are not computed in its schema",
      extra,
    );
  }
}

/** Throws unless every required computed field has a value in `output`. */
export function assertRequiredOutputs(
  subject: ValidationSubject,
  output: Record<string, unknown>,
): void {
  const missing = Object.entries(subject.schema)
    .filter(
      ([field, item]) =>
        item.propertyType === "computed" &&
        item.presence === "required" &&
        output[field] === undefined,
    )
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new SchemaStructureError(
      subject,
      "these required outputs are missing",
      missing,
    );
  }
}

function hasTag<T extends string>(
  error: unknown,
  tag: T,
): error is Error & { _tag: T } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === tag
  );
}
