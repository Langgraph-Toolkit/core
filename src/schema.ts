/**
 * Schema-first values for state, tool inputs and structured model responses.
 *
 * The facade intentionally remains dependency-free. It validates the JSON
 * boundary and carries an optional state default so createState can infer both
 * the runtime state shape and its zero-config initial value.
 */
import type { JsonObject, JsonValue, ValueSchema } from "./types.js";

/** A typed JSON schema that can also be used as a createState field. */
export interface SchemaValue<TValue> extends ValueSchema<TValue> {
  readonly __schemaValue: true;
  readonly defaultValue?: TValue;
  optional(): SchemaValue<TValue | undefined>;
  default(value: TValue): SchemaValue<TValue>;
}

/** Object shape accepted by schema.object(). */
export type SchemaShape = Readonly<Record<string, SchemaValue<JsonValue | undefined>>>;

/** Infer an object value from a schema shape. */
export type InferSchemaShape<TShape extends SchemaShape> = {
  readonly [TKey in keyof TShape]: TShape[TKey] extends SchemaValue<infer TValue> ? TValue : JsonValue;
};

/** Inference-first primitives for JSON-safe workflow boundaries. */
export const schema = {
  string: (): SchemaValue<string> => value("string", (input) => {
    if (typeof input !== "string") throw new TypeError("Expected a string.");
    return input;
  }),
  number: (): SchemaValue<number> => value("number", (input) => {
    if (typeof input !== "number" || !Number.isFinite(input)) throw new TypeError("Expected a finite number.");
    return input;
  }),
  boolean: (): SchemaValue<boolean> => value("boolean", (input) => {
    if (typeof input !== "boolean") throw new TypeError("Expected a boolean.");
    return input;
  }),
  literal: <TValue extends JsonValue>(expected: TValue): SchemaValue<TValue> => value("literal", (input) => {
    if (JSON.stringify(input) !== JSON.stringify(expected)) throw new TypeError("Expected the declared literal value.");
    return expected;
  }),
  array: <TValue>(item: SchemaValue<TValue>): SchemaValue<readonly TValue[]> => value("array", (input) => {
    if (!Array.isArray(input)) throw new TypeError("Expected an array.");
    return input.map((entry) => item.parse(entry));
  }),
  record: <TValue>(item: SchemaValue<TValue>): SchemaValue<Readonly<Record<string, TValue>>> => value("record", (input) => {
    if (!isRecord(input)) throw new TypeError("Expected an object record.");
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, item.parse(entry)]));
  }),
  object: <TShape extends SchemaShape>(shape: TShape): SchemaValue<InferSchemaShape<TShape>> => value("object", (input) => {
    if (!isRecord(input)) throw new TypeError("Expected an object.");
    const parsed: Record<string, JsonValue | undefined> = {};
    for (const [key, field] of Object.entries(shape)) parsed[key] = field.parse(input[key] ?? null);
    return parsed as InferSchemaShape<TShape>;
  }),
  enum: <TValue extends string>(values: readonly TValue[]): SchemaValue<TValue> => value("enum", (input) => {
    if (typeof input !== "string" || !values.includes(input as TValue)) throw new TypeError(`Expected one of: ${values.join(", ")}.`);
    return input as TValue;
  }),
  /** JSON-safe flexible field for externally discovered MCP tool schemas. */
  any: (): SchemaValue<JsonValue> => value("json", (input) => input),
};

function value<TValue>(name: string, parse: (input: JsonValue) => TValue, defaultValue?: TValue): SchemaValue<TValue> {
  return {
    name,
    __schemaValue: true,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    parse,
    optional: () => value<TValue | undefined>(`${name}?`, (input) => input === null ? undefined : parse(input)),
    default: (next) => value(name, parse, next),
  };
}

function isRecord(input: JsonValue): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
