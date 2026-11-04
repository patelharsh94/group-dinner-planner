import { expect, it } from "vitest";
import { ProviderCallDiagnosticSchema } from "../../src/application/research.js";
const call = {phase:"normalization",status:"failed",durationMs:10,model:"muse-spark-1.3",reasoningEffort:"minimal",maxOutputTokens:8192,queryCount:0,schemaIssueCount:1};
it("retains safe model, usage and schema diagnosis without retaining rejected values", () => {
  expect(ProviderCallDiagnosticSchema.parse({...call,failureKind:"schema",schemaIssues:[{path:"dietary.assessments.0.assessment",code:"invalid_value"}]})).toMatchObject({failureKind:"schema"});
  expect(ProviderCallDiagnosticSchema.safeParse({...call,schemaIssues:[{path:"dietary",code:"invalid_value",message:"private response text"}]}).success).toBe(false);
  expect(ProviderCallDiagnosticSchema.safeParse({...call,schemaIssues:[{path:"person@example.com",code:"invalid_value"}]}).success).toBe(false);
});
