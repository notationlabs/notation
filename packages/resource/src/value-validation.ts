import type { Schema } from "./resource.schema";
import type { StandardSchemaV1 } from "./standard-schema";
import { containsUnknownAfterApply } from "./diff-params";

/**
 * Where the engine validated a value:
 * - `declaration`: config, when the resource is declared.
 * - `plan`: the params a plan knows.
 * - `deploy`: params, before deploy changes anything, and again just before
 *   the resource's own operation.
 * - `read`: the result of the resource's `read`.
 */
export type ValidationPoint = "declaration" | "plan" | "deploy" | "read";

/** The parts of a resource that validation reads. */
export type ValidationSubject = {
  id: string;
  type: string;
  schema: Schema;
  /** `file:line` of the code that declared the resource, when known. */
  declaredAt?: string;
};

/**
 * Thrown when a value fails its schema item's validator.
 */
export class ValueValidationError extends Error {
  readonly _tag = "ValueValidationError" as const;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly field: string;
  readonly point: ValidationPoint;
  readonly declaredAt?: string;
  /** One line per issue the validator reported, prefixed by its path. */
  readonly issues: string[];

  constructor(opts: {
    resourceId: string;
    resourceType: string;
    field: string;
    point: ValidationPoint;
    declaredAt?: string;
    issues: string[];
  }) {
    const subject =
      opts.point === "read"
        ? `The read of ${opts.resourceId} (${opts.resourceType}) returned an invalid ${opts.field}`
        : `Invalid ${opts.field} for ${opts.resourceId} (${opts.resourceType}) at ${opts.point}`;
    const site = opts.declaredAt ? `, declared at ${opts.declaredAt}` : "";
    super(`${subject}${site}: ${opts.issues.join("; ")}`);
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
 * that the schema does not have as a param, a create result field that is not
 * computed, or a required output that is missing.
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
 * that has no schema item, or that `skip` returns true for, is not validated.
 *
 * Returns a promise only when a validator is async, so validation at
 * declaration can throw from the constructor.
 */
export function validateValues(
  subject: ValidationSubject,
  values: Record<string, unknown>,
  point: ValidationPoint,
  skip: (value: unknown) => boolean = () => false,
): void | Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [field, value] of Object.entries(values)) {
    const item = subject.schema[field];
    if (!item || value === undefined || skip(value)) continue;
    const result = item.value["~standard"].validate(value);
    if (result instanceof Promise) {
      pending.push(
        result.then((settled) => assertValid(subject, field, point, settled)),
      );
    } else {
      assertValid(subject, field, point, result);
    }
  }
  if (pending.length > 0) return Promise.all(pending).then(() => undefined);
}

function assertValid(
  subject: ValidationSubject,
  field: string,
  point: ValidationPoint,
  result: StandardSchemaV1.Result<unknown>,
): void {
  if (!result.issues) return;
  throw new ValueValidationError({
    resourceId: subject.id,
    resourceType: subject.type,
    field,
    point,
    declaredAt: subject.declaredAt,
    issues: result.issues.map(formatIssue),
  });
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? [])
    .map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    )
    .join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Checks params at plan or deploy: every field is a param, and every value
 * passes its validator. A value that is unknown until apply, or holds one, is
 * skipped.
 */
export async function validateParams(
  subject: ValidationSubject,
  params: Record<string, unknown>,
  point: "plan" | "deploy",
): Promise<void> {
  assertParamFields(subject, params);
  await validateValues(subject, params, point, containsUnknownAfterApply);
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
