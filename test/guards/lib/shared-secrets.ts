import ts from "typescript";
import { lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";

/**
 * Names that carry secret material. `credentialRef` (an opaque reference) and
 * `hasCredential` (a boolean) are deliberately not matched.
 */
const SECRET_NAME =
  /^(api_?key|apikey|secret_?key|client_?secret|cookies?|cookie_?header|sessdata|bili_?jct|password_?hash|master_?key|private_?key|access_?token|refresh_?token|session_?id|session_?token|bearer_?token)$/i;
const SECRET_TYPE_NAME = /(ApiKey|Cookie|PasswordHash|MasterKey|PrivateKey|AccessToken|RefreshToken|Secret)(s)?(Dto|Schema|Input|Payload)?$/;

/**
 * Shared-secrets guard: `src/shared` is bundled into the SPA and describes DTOs, so it must
 * not declare secret-bearing fields or types. Invariant: a secret is persisted only in
 * encrypted form and never enters a DTO, log, URL or error message.
 */
export function sharedSecrets(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src/shared"], TS_EXTENSIONS)) {
    const source = parseSource(root, file);
    visit(source, (node) => {
      const name = declaredName(node);
      if (name === undefined) {
        return;
      }
      if (SECRET_NAME.test(name.text)) {
        violations.push({ file, rule: "shared-secret-field", line: lineOf(source, name.node) });
      } else if (isTypeDeclaration(node) && SECRET_TYPE_NAME.test(name.text)) {
        violations.push({ file, rule: "shared-secret-type", line: lineOf(source, name.node) });
      }
    });
  }
  return violations;
}

function isTypeDeclaration(node: ts.Node): boolean {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node);
}

function declaredName(node: ts.Node): { text: string; node: ts.Node } | undefined {
  if (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    const name = node.name;
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
      return { text: name.text, node: name };
    }
  }
  return undefined;
}
