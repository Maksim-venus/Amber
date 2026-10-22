import ts from "typescript";
import { lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";

/** Prefixes of model identifiers across vendors; a literal starting with one names a model. */
const MODEL_ID_LITERAL =
  /^(gpt|chatgpt|o[1-9]|claude|gemini|gemma|deepseek|qwen|qwq|llama|mistral|mixtral|codestral|glm|chatglm|kimi|moonshot|yi-|doubao|ernie|hunyuan|grok|phi-|command-|scribe)/i;

/** Identifiers that hold a model name; comparing them to any literal is branching on the model. */
const MODEL_NAME_IDENTIFIER = /^(model|modelId|modelName|modelDisplay\w*)$/;

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const STRING_MATCHERS = new Set(["startsWith", "endsWith", "includes", "match", "test", "search", "indexOf"]);

/**
 * Model-name branching guard: capability decisions come from `ModelCapability` effective
 * values only, never from the model name. Flags equality and `switch` against model-id
 * literals, string matching with model-id patterns, and any literal comparison of a
 * `model` / `modelId` value.
 */
export function modelNameBranching(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src"], TS_EXTENSIONS)) {
    const source = parseSource(root, file);
    visit(source, (node) => {
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        const literal = stringLiteral(node.left) ?? stringLiteral(node.right);
        const other = stringLiteral(node.left) !== undefined ? node.right : node.left;
        if (literal !== undefined && (MODEL_ID_LITERAL.test(literal) || namesModel(other))) {
          violations.push({ file, rule: "model-name-comparison", line: lineOf(source, node) });
        }
      } else if (ts.isCaseClause(node)) {
        const literal = stringLiteral(node.expression);
        const switched = ts.isSwitchStatement(node.parent.parent) ? node.parent.parent.expression : undefined;
        if (literal !== undefined && (MODEL_ID_LITERAL.test(literal) || (switched && namesModel(switched)))) {
          violations.push({ file, rule: "model-name-switch", line: lineOf(source, node) });
        }
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (!STRING_MATCHERS.has(node.expression.name.text)) {
          return;
        }
        const receiver = node.expression.expression;
        const patterns = [receiver, ...node.arguments].map(patternText).filter((text) => text !== undefined);
        const matchesModelPattern = patterns.some((text) => MODEL_ID_LITERAL.test(text.replace(/^\^/, "")));
        const matchesModelValue = namesModel(receiver) || node.arguments.some(namesModel);
        if (matchesModelPattern || (matchesModelValue && patterns.length > 0)) {
          violations.push({ file, rule: "model-name-match", line: lineOf(source, node) });
        }
      }
    });
  }
  return violations;
}

function stringLiteral(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function patternText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return node.text.slice(1, node.text.lastIndexOf("/"));
  }
  return undefined;
}

function namesModel(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    return MODEL_NAME_IDENTIFIER.test(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return MODEL_NAME_IDENTIFIER.test(node.name.text);
  }
  return false;
}
