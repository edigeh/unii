// Text imports
// ============
// A Swift source imported `with { type: "text" }` (Computer.ts carries
// Computer.swift so): Bun gives its text as the default export.

declare module "*.swift" {
  const text: string;
  export default text;
}
