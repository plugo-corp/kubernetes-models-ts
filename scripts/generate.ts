import yargs from "yargs";
import { readFile, writeFile, copyDir } from "./fs";
import { camelCase, trimPrefix, upperFirst, trimSuffix } from "./string";
import { join, relative, dirname, posix } from "path";
import { set } from "./object";

interface DefinitionTree {
  [key: string]: string | DefinitionTree;
}

const { argv } = yargs
  .option("file", {
    description: "Path of OpenAPI spec",
    required: true
  })
  .option("output", {
    description: "Output path",
    required: true
  });

function collectRefs(name: string, input: any): Set<string> {
  function collect(data: any): string[] {
    const refs = Object.keys(data).map(key => {
      const val = data[key];

      if (key === "$ref" && typeof val === "string") {
        return [trimRefPrefix(val)];
      }

      if (typeof val === "object" && !Array.isArray(val)) {
        return collect(val);
      }

      return [];
    });

    return refs.reduce((acc, x) => acc.concat(x), [] as string[]);
  }

  return new Set(collect(input).filter(x => x !== name));
}

function getClassName(name: string): string {
  return upperFirst(camelCase(name, ".-"));
}

function getInterfaceName(name: string): string {
  return "I" + getClassName(name);
}

function getShortClassName(name: string): string {
  const s = name.split(".");
  return s[s.length - 1];
}

function getShortInterfaceName(name: string): string {
  return "I" + getShortClassName(name);
}

function getSchemaName(name: string): string {
  return getClassName(name) + "Schema";
}

function getAddSchemaName(name: string): string {
  return getClassName(name) + "AddSchema";
}

function getAjvPath() {
  return join(argv.output, "ajv");
}

function getBasePath() {
  return join(argv.output, "base");
}

function trimDefPrefix(name: string) {
  return trimPrefix(name, "io.k8s.");
}

function getOutputPath(name: string): string {
  return join(argv.output, ...trimDefPrefix(name).split("."));
}

function trimRefPrefix(ref: string) {
  return trimPrefix(ref, "#/definitions/");
}

function commentize(s: string): string {
  let output = "/**\n";

  for (const line of s.split("\n")) {
    output += " * " + line.replace(/\*\//g, "\\*\\/") + "\n";
  }

  output += " */\n";
  return output;
}

function compileDefinition(key: string, def: any): string {
  const interfaceName = getInterfaceName(key);
  const className = getClassName(key);
  const comment =
    typeof def.description === "string" ? commentize(def.description) : "";
  let output = "";

  if (!def.type && !def.$ref) def.type = "object";

  const content = compileType(def);

  if (def.type === "object") {
    const basePath = relative(dirname(getOutputPath(key)), getBasePath());
    const classContent = `${trimSuffix(content.trim(), "}")}

/** @internal */
protected [SCHEMA_ID] = "${key}";

/** @internal */
protected [ADD_SCHEMA] = ${getAddSchemaName(key)};

${compileClassCtor(key, def)}
}`;

    output += `
import { BaseModel, SCHEMA_ID, ADD_SCHEMA } from "${basePath}";

${comment}export interface ${interfaceName} ${content}

${comment}export class ${className} extends BaseModel<${interfaceName}> implements ${interfaceName} ${classContent}
`;
  } else {
    output += `
${comment}export type ${interfaceName} = ${content};

${comment}export type ${className} = ${interfaceName};
`;
  }

  output += `
/** @internal */
export const ${getSchemaName(key)}: object = ${compileSchema(key, def)};

/** @internal */
export function ${getAddSchemaName(key)}() ${compileAddSchema(key, def)}

export { ${interfaceName} as ${getShortInterfaceName(key)} };
export { ${className} as ${getShortClassName(key)} };
`;

  return output;
}

function compileType(def: any): string {
  if (typeof def.$ref === "string") {
    return getInterfaceName(trimPrefix(def.$ref, "#/definitions/"));
  }

  switch (def.type) {
    case "object":
      const { required = [], properties = {}, additionalProperties } = def;
      let output = "{\n";

      for (const key of Object.keys(properties)) {
        const prop = properties[key];

        if (typeof prop.description === "string") {
          output += commentize(prop.description);
        }

        output += `"${key}"`;
        if (!~required.indexOf(key)) output += "?";
        output += ": " + compileType(prop) + ";\n";
      }

      if (additionalProperties) {
        output += `[key: string]: ${compileType(additionalProperties)};\n`;
      }

      output += "}";
      return output;

    case "string":
      switch (def.format) {
        case "int-or-string":
          return "string | number";

        default:
          return "string";
      }

    case "number":
    case "integer":
      return "number";

    case "boolean":
      return "boolean";

    case "array":
      return `Array<${compileType(def.items)}>`;

    case "null":
      return "null";
  }

  return "any";
}

function compileSchema(name: string, def: any): string {
  function changeRef(obj: any) {
    const output: any = {};

    for (const key of Object.keys(obj)) {
      // Remove description and kubernetes attributes
      if (key === "description" || key.startsWith("x-kubernetes-")) {
        continue;
      }

      let val = obj[key];

      if (key === "$ref" && typeof val === "string") {
        val = trimRefPrefix(val) + "#";
      } else if (typeof val === "object" && !Array.isArray(val)) {
        val = changeRef(val);
      }

      output[key] = val;
    }

    return output;
  }

  let schema: any;

  // Rewrite schemas for some special types
  if (name === "io.k8s.apimachinery.pkg.util.intstr.IntOrString") {
    schema = {
      oneOf: [{ type: "string" }, { type: "integer", format: "int32" }]
    };
  } else {
    schema = changeRef(def);
  }

  return JSON.stringify(schema, null, "  ");
}

function compileAddSchema(name: string, def: any): string {
  let output = "{\n";

  for (const ref of collectRefs(name, def)) {
    output += `${getAddSchemaName(ref)}();\n`;
  }

  output += `addSchema("${name}", ${getSchemaName(name)});\n`;
  output += "}\n";
  return output;
}

function compileClassCtor(name: string, def: any): string {
  const gvk = def["x-kubernetes-group-version-kind"];
  if (!gvk || !gvk.length) return "";

  const { group, version, kind } = gvk[0];

  return `
constructor(data?: ${getInterfaceName(name)}) {
  super({
    apiVersion: "${group ? group + "/" : ""}${version}",
    kind: "${kind}",
    ...data
  } as any);
}`;
}

async function writeIndexFiles(tree: DefinitionTree, name: string = "") {
  let output = "";

  for (const key of Object.keys(tree)) {
    const val = tree[key];

    if (typeof val === "string") {
      output += `export * from "./${key}";\n`;
    } else {
      const exportedName = camelCase(key, "-");
      output += `import * as ${exportedName} from "./${key}";\n`;
      output += `export { ${exportedName} };\n`;
      await writeIndexFiles(val, name + key + ".");
    }
  }

  const path = join(getOutputPath(name), "index.ts");
  console.log("Generating:", path);
  await writeFile(path, output);
}

(async () => {
  const { definitions } = JSON.parse(await readFile(argv.file, "utf8"));
  const tree: DefinitionTree = {};

  for (const key of Object.keys(definitions)) {
    const def = definitions[key];
    const path = getOutputPath(key) + ".ts";
    let content = "";

    // Import ajv
    const ajvPath = relative(dirname(getOutputPath(key)), getAjvPath());
    content += `import { addSchema } from "${ajvPath}";\n`;

    for (const ref of collectRefs(key, def)) {
      let importPath = relative(dirname(path), getOutputPath(ref));

      if (!importPath.startsWith(".")) {
        importPath = "./" + importPath;
      }

      importPath = importPath.replace(/\\/g, posix.sep);
      content += `import {
${getInterfaceName(ref)},
${getAddSchemaName(ref)}
} from '${importPath}';\n`;
    }

    content += compileDefinition(key, def);

    console.log("Generating:", path);
    await writeFile(path, content);
    set(tree, trimDefPrefix(key), key);
  }

  await writeIndexFiles(tree);
  await copyDir(join(__dirname, "..", "src"), argv.output);
})().catch(console.error);
