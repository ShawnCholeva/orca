import { WorkflowStepOutputSchema as WorkflowStepOutputSchemaValue } from "@orca/contracts";
import type { WorkflowStepOutputField, WorkflowStepOutputSchema } from "@orca/contracts";

const pad = (depth: number) => "  ".repeat(depth);

function quoteLiteral(value: string): string {
  return JSON.stringify(value);
}

function renderField(f: WorkflowStepOutputField, depth: number): string {
  const opt = f.required ? "" : "?";
  if (f.type === "object" && f.fields) {
    const desc = f.description ? `  # ${f.description}` : "";
    return `${pad(depth)}${f.key}${opt} {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}${desc}`;
  }
  if (f.type === "array" && f.itemType === "object" && f.fields) {
    const desc = f.description ? `  # ${f.description}` : "";
    return `${pad(depth)}${f.key}${opt}[] {\n${renderFields(f.fields, depth + 1)}\n${pad(depth)}}${desc}`;
  }
  let typ = "";
  if (f.type === "array") {
    typ = f.itemType ? `: ${f.itemType}[]` : "[]";
  } else if (f.type === "string" && f.enum) {
    typ = `: ${f.enum.map(quoteLiteral).join(" | ")}`;
  } else if (f.type !== "string") {
    typ = `: ${f.type}`;
  }
  const desc = f.description ? `  # ${f.description}` : "";
  return `${pad(depth)}${f.key}${opt}${typ}${desc}`;
}

function renderFields(fields: WorkflowStepOutputField[], depth: number): string {
  return fields
    .map((f, i, arr) => {
      const s = renderField(f, depth);
      if (i === arr.length - 1) return s;
      // A trailing comma after a # comment would be swallowed into the description,
      // and commas are optional separators anyway — for described fields the newline
      // alone separates (a comma orphaned on its own line renders as garbage).
      return f.description ? s : s + ",";
    })
    .join("\n");
}

export function serializeOutputSchema(schema: WorkflowStepOutputSchema): string {
  return renderFields(schema, 0);
}

export type ParseResult =
  | { ok: true; schema: WorkflowStepOutputSchema }
  | { ok: false; error: string };

type Tok =
  | { t: "{" } | { t: "}" } | { t: "[" } | { t: "]" }
  | { t: ":" } | { t: "?" } | { t: "," } | { t: "|" }
  | { t: "name"; v: string }
  | { t: "str"; v: string }
  | { t: "desc"; v: string };

class ParseErr extends Error {}

const PRIMS = ["string", "number", "boolean"] as const;
type Prim = (typeof PRIMS)[number];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      let j = i + 1;
      while (j < src.length && src[j] !== "\n") j++;
      toks.push({ t: "desc", v: src.slice(i + 1, j).trim() });
      i = j;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === "?" || c === "," || c === "|") {
      toks.push({ t: c });
      i++;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      let value = "";
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\"") break;
        if (ch === "\\") {
          const nextChar = src[j + 1];
          if (!nextChar) throw new ParseErr("Unterminated string literal");
          value += nextChar;
          j += 2;
          continue;
        }
        value += ch;
        j++;
      }
      if (src[j] !== "\"") throw new ParseErr("Unterminated string literal");
      toks.push({ t: "str", v: value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseErr(`Unexpected character '${c}'`);
  }
  return toks;
}

export function parseOutputSchemaText(text: string): ParseResult {
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok | undefined => toks[pos++];

  function expect(t: Tok["t"]): void {
    const x = next();
    if (!x || x.t !== t) throw new ParseErr(`Expected '${t}'`);
  }

  function parseBraced(): WorkflowStepOutputField[] {
    expect("{");
    const fields = parseFieldList(true);
    expect("}");
    return fields;
  }

  function parseStringLiterals(): string[] {
    const values: string[] = [];
    while (true) {
      const literal = next();
      if (!literal || literal.t !== "str") throw new ParseErr("Expected string literal");
      values.push(literal.v);
      if (peek()?.t !== "|") break;
      next();
    }
    return values;
  }

  function parseField(): WorkflowStepOutputField {
    const nameTok = next();
    if (!nameTok || nameTok.t !== "name") throw new ParseErr("Expected field name");
    let field: WorkflowStepOutputField = { key: nameTok.v, type: "string", required: true };
    if (peek()?.t === "?") { next(); field.required = false; }

    const p = peek();
    if (p?.t === ":") {
      next();
      const after = peek();
      if (after?.t === "{") {
        field = { ...field, type: "object", fields: parseBraced() };
      } else if (after?.t === "str") {
        field = { ...field, type: "string", enum: parseStringLiterals() };
      } else if (after?.t === "name") {
        const word = (next() as { t: "name"; v: string }).v;
        if (!(PRIMS as readonly string[]).includes(word)) throw new ParseErr(`Unknown type '${word}'`);
        if (peek()?.t === "[") {
          next();
          expect("]");
          field = { ...field, type: "array", itemType: word as Prim };
        } else {
          field = { ...field, type: word as Prim };
        }
      } else {
        throw new ParseErr(`Expected a type after ':' for '${field.key}'`);
      }
    } else if (p?.t === "[") {
      next();
      expect("]");
      if (peek()?.t === "{") {
        field = { ...field, type: "array", itemType: "object", fields: parseBraced() };
      } else {
        field = { ...field, type: "array" };
      }
    } else if (p?.t === "{") {
      field = { ...field, type: "object", fields: parseBraced() };
    }

    if (peek()?.t === "desc") {
      field = { ...field, description: (next() as { t: "desc"; v: string }).v };
    }
    return field;
  }

  function parseFieldList(insideBrace: boolean): WorkflowStepOutputField[] {
    const fields: WorkflowStepOutputField[] = [];
    const seen = new Set<string>();
    while (pos < toks.length) {
      const tok = peek();
      if (insideBrace && tok?.t === "}") break;
      if (tok?.t === ",") { next(); continue; }
      if (tok?.t !== "name") throw new ParseErr(`Expected field name, got '${tok?.t ?? "end"}'`);
      const f = parseField();
      if (seen.has(f.key)) throw new ParseErr(`Duplicate key '${f.key}'`);
      seen.add(f.key);
      fields.push(f);
    }
    return fields;
  }

  let fields: WorkflowStepOutputField[];
  try {
    fields = parseFieldList(false);
    if (pos < toks.length) throw new ParseErr("Unexpected trailing input");
  } catch (e) {
    if (e instanceof ParseErr) return { ok: false, error: e.message };
    throw e;
  }

  const result = WorkflowStepOutputSchemaValue.safeParse(fields);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    return { ok: false, error: path ? `${path}: ${issue.message}` : issue.message };
  }
  return { ok: true, schema: result.data };
}
